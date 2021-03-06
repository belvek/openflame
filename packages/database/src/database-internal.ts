import { Subject } from 'rxjs/Subject';
import { Observer } from 'rxjs/Observer';
import { Observable } from 'rxjs/Observable';
import { Subscription } from 'rxjs/Subscription';
import { WebSocketSubject } from 'rxjs/observable/dom/WebSocketSubject';
import { async as asyncScheduler } from 'rxjs/scheduler/async';
import 'rxjs/add/operator/map';
import 'rxjs/add/operator/merge';
import 'rxjs/add/operator/share';
import 'rxjs/add/operator/takeUntil';
import 'rxjs/add/operator/observeOn';
import 'rxjs/add/observable/of';
import 'rxjs/add/observable/from';
import 'rxjs/add/observable/dom/webSocket';

import { Reference } from './reference';
import { Query, QueryObject } from './query';
import { Path } from './path';
import { DataModel } from './data-model';
import { DataSnapshot } from './data-snapshot';
import { Notifier, NotifierEvent } from './notifier';


/**
 * Which SDK version to fake
 * @type {string}
 */
const SDK_VERSION = 'sdk.js.3-7-0';

/**
 * The keep-alive period, in miliseconds
 * @type {number}
 */
const KEEPALIVE_PERIOD = 45000;

/**
 * @internal
 * Internal implementation of the database SDK
 */
export class DatabaseInternal {
  private _socket$: WebSocketSubject<any>;
  private _connection: Subscription;
  private _databaseURL: string;
  private _host: string;
  private _useTLS: boolean;
  private _projectName: string;
  private _useProjectName: boolean = false;
  private _keepAliveHandler: any;
  private _ready = false;
  private _dataMessageQueue: any[] = [];
  private _serverInfo: ServerInfo = {timeDiff: 0};
  private _reqCounter: number = 1;
  private _sentRequests: { [k: number]: SentDataRequest } = {};
  private _tagCounter: number = 1;
  private _model: DataModel = new DataModel();
  private _dataListeners: Array<DataListener> = [];
  private _hasReceivedError = false;
  private _notifier = new Notifier();

  // FIXME: this class does way too many things. Split it up in logical parts.

  constructor(_databaseURL?: string) {
    if (!_databaseURL)
      throw new Error('No databaseURL provided in the configuration');

    this._databaseURL = _databaseURL;

    this.init();
    this.connect();
  }

  /**
   * Initialize the internal data model with any data
   * @param data
   */
  bootstrap(data: any) {
    this._notifier.pause();
    this._model.setData(data);
    this._notifier.resume();
  }

  /**
   * Adds a new listener to the database, based on a `Query`
   * @param query
   * @param type
   * @returns {[DataListener,Observable<DataSnapshot>]}
   */
  addListener(query: Query, type: EventType): { listener: DataListener, notifier$: Observable<DataSnapshot> } {
    const toInactivate: any[] = [];
    let makeActive = true;

    for (let i = 0, l = this._dataListeners.length; i < l; i++) {
      const listener = this._dataListeners[i];

      if (listener.query.path.includesOrEqualTo(query.path) && !listener.query.hasQuery()) {

        // This listener has the same path as the new one or includes it, and it doesn't have a query,
        // so we don't need to make the new one active. No need to check further.
        makeActive = false;
        break;

      } else if (listener.isActive) {
        // This listener is active, we need to check wether we have to inactivate it or not

        if (query.path.includes(listener.query.path)) {
          // This listener is active and its path is included in the one being added. Check queries.

          if (!query.hasQuery()) {
            // The one being added doesn't have a query, so it's safe to inactivate the current one
            toInactivate.push(listener);
          }

        } else if (query.path.isEqual(listener.query.path)) {
          // This listener has the same path as the one being added, and (first "if") it has a query.

          if (!query.hasQuery()) {
            // The one being added doesn't have a query, so we inactivate the current one
            toInactivate.push(listener);
          }

        }
      }
    }

    const newListener = {
      query,
      type,
      isActive: makeActive,
      tag: query.hasQuery() ? this._tagCounter++ : 0
    };

    this._dataListeners.push(newListener);

    // A subject where we will emit the current cached value, when necessary
    const current$ = new Subject<NotifierEvent>();

    // This observable emits when we receive data from the server, or the current cached value when necessary
    const notifier$ = this._notifier.forListener(newListener, current$);

    const addWatchPromise = makeActive ? this.addServerWatch(query, newListener.tag) : null;

    // Inactivate any listeners marked for inactivation
    // IMPORTANT: This needs to come *after* calling addServerWatch()
    toInactivate.forEach((listener: DataListener) => {
      listener.isActive = false;
      this.removeServerWatch(listener.query, listener.tag);
    });

    // This observable emits when the watch has been added (unless we've already received data),
    // or immediately if we're not adding a watch
    const addWatch$: Observable<any> = addWatchPromise
      ? Observable.from(addWatchPromise).takeUntil(notifier$)
      : Observable.of(void 0);

    // If we're not adding a watch, or adding the watched resolves without any data, we need to trigger
    // this listener's notifier with the data we currently have for "value" and "child_added" events.
    // We use the async scheduler to ensure subscription happens after exiting addListener()
    if ((type === 'value') || (type === 'child_added')) {
      addWatch$.observeOn(asyncScheduler).subscribe(() => {
        const newModel = this._model.child(query.path);
        const oldModel = new DataModel(newModel.key, newModel.parent);
        this._notifier.trigger(query.path, oldModel, newModel, newListener.tag, {
          downLevels: type === 'value' ? 0 : 1,
          useSubject: current$,
          skipEqualityCheck: true
        });
      });
    }

    return {
      listener: newListener,
      notifier$
    };
  }

  isListenerMaskedByAnyOther(listener: DataListener) {
    const path = listener.query.path;

    return !listener.query.hasQuery() && this._dataListeners.some((other: DataListener) => {
        return (listener !== other) && path.includesOrEqualTo(other.query.path);
      });
  }

  removeListener(listenerToRemove: DataListener, removeWatch = true): Promise<void> {
    return new Promise<void>((resolve: (v?: any) => void, reject: (r?: any) => void) => {
      try {
        let shouldRemoveWatch = listenerToRemove.isActive && removeWatch;
        const promises: Promise<any>[] = [];

        const newListenersList: DataListener[] = [];

        // Let's check if we need to remove the watch or re-activate any listener
        this._dataListeners.forEach((listener: DataListener) => {

          if (listener !== listenerToRemove) {
            newListenersList.push(listener);

            const path = listener.query.path;
            const toRemovePath = listenerToRemove.query.path;

            if (listenerToRemove.isActive && !listener.isActive && !listenerToRemove.query.hasQuery() && toRemovePath.includesOrEqualTo(path)) {
              // The listener we're removing is active and masks this one.

              if (!this.isListenerMaskedByAnyOther(listener)) {
                // This listener is not masked by any other listener, let's re-activate it
                // TODO: here's where we need to compute the hash to avoid triggering new data from the server
                listener.isActive = true;
                promises.push(this.addServerWatch(listener.query, listener.tag));
              }
            }

            if (shouldRemoveWatch && path.isEqual(toRemovePath) && listener.query.isEqual(listenerToRemove.query)) {
              // This other listener has the same path and same query as the one we're removing,
              // so we can't remove the server watch
              shouldRemoveWatch = false;
            }

          }
        });

        if (shouldRemoveWatch) {
          console.log('Removing watch', new Error('' + removeWatch));
          promises.push(this.removeServerWatch(listenerToRemove.query, listenerToRemove.tag));
        }

        listenerToRemove.isActive = false;
        this._dataListeners = newListenersList;

        // TODO: check model, we might be able to delete parts of it at this point

        // Wait for all promises before resolving
        Promise.all(promises).then(resolve);

      } catch (error) {
        reject(error);
      }

    });
  }

  sendDataMessage(type: string, query: Query | null, payload: any, optimisticEvents?: NotifierEvent[]): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this._ready) {
        // If the connection to the database is not ready yet, just queue the message for later
        this._dataMessageQueue.push({
          resolve,
          reject,
          type,
          query,
          payload,
          optimisticEvents
        });

        return;
      }

      const id = this._reqCounter++;
      const data = {
        r: id,
        a: type,
        b: payload
      };

      this._sentRequests[id] = {
        resolve,
        reject,
        data,
        query,
        optimisticEvents
      };

      this.send({
        t: 'd',
        d: data
      });
    });
  }

  updateModel(path: Path, value: any, {tag = 0, optimisticEvents}: { tag?: number, optimisticEvents?: NotifierEvent[] } = {}) {
    /*
     TODO: Figure out which approach is best:
     1. Current, naive approach: emit every single possible event and let the listeners' notifiers filter them out.
     2. Queue the events and later loop through all the listeners to figure out which ones we need to emit

     The current one is more flexible, but it might not offer very good performance with large updates and lots of listeners.
     I should probably do some complexity calculations to figure it out, and some perf benchmarking wouldn't hurt.
     */

    // Keep the current state of the model at this path
    const oldModel = this._model.child(path);

    // If the value is a DataModel, use it as the new model at this path (used for optimistic update rollbacks).
    // Otherwise clone the model at this path, discarding any data it had, and update it with the new data.
    const newModel = value instanceof DataModel ? value : oldModel.clone({keepData: false}).setData(value);

    // Set the new model's root as the current one
    this._model = newModel.cloneToRoot();

    // Trigger notication events for the listeners
    this._notifier.trigger(path, oldModel, this._model.child(path), tag, {bubbleUpValue: true, optimisticEvents});
  }

  get timeDiff(): number {
    return this._serverInfo.timeDiff;
  }

  get model(): DataModel {
    return this._model;
  }

  private init() {
    const dbURLmatch = this._databaseURL.trim().match(/^http(s?):\/\/(([^\.]+)\.(.+))$/);

    if (!dbURLmatch) {
      throw new Error('Missing or malformed databaseURL in config');
    }

    this._useTLS = dbURLmatch[1] === 's';
    this._projectName = dbURLmatch[3];

    const savedHost = localStorage.getItem(`firebase:host:${dbURLmatch[2]}`);

    if (savedHost) {
      this._host = JSON.parse(savedHost);
      this._useProjectName = true;
    } else {
      this._host = dbURLmatch[2];
    }
  }

  private connect() {
    let url = `ws${this._useTLS ? 's' : ''}://${this._host}/.ws?v=5` + (this._useProjectName ? `&ns=${this._projectName}` : '');

    this._socket$ = Observable.webSocket<any>({url, resultSelector: websocketResultSelector()});

    this._connection = this._socket$.subscribe(
      (msg: object) => this.processMessage(msg),
      (err: any) => console.error('WebSocket error:', err),
      () => console.info('WebSocket closed')
    );

    this.scheduleKeepAlive();
  }

  private disconnect() {
    // RxJS magic!
    !this._connection.closed && this._connection.unsubscribe();
  }

  private handleReset(host) {
    this.disconnect();

    if (this._host === host) {
      console.warn('The Firebase server is requesting a reconnect to the current host. Aborting.');
      return;
    }

    const currentHost = this._host;

    this._host = host;
    this._useProjectName = true;

    localStorage.setItem(`firebase:host:${currentHost}`, JSON.stringify(host));

    setTimeout(() => this.connect(), 1000);
  }

  private scheduleKeepAlive() {
    // Clear the keep-alive timeout, if any
    this._keepAliveHandler && clearTimeout(this._keepAliveHandler);

    // Schedule a keep-alive message
    this._keepAliveHandler = setTimeout(() => this.send(0), KEEPALIVE_PERIOD);
  }

  private send(data) {
    // The official SDK splits websocket messages in frames no larger than 16 KiB, but
    // the server seems to accept longer messages just fine.
    this._socket$.next(JSON.stringify(data));
    this.scheduleKeepAlive();
  }

  private resendDataMessage(req: SentDataRequest) {
    const id = this._reqCounter++;
    req.data['r'] = id;

    this._sentRequests[id] = {
      resolve: req.resolve,
      reject: req.reject,
      data: req.data,
      query: req.query,
      optimisticEvents: req.optimisticEvents
    };

    this.send({
      t: 'd',
      d: req.data
    });
  }

  private addServerWatch(query: Query, tag: number): Promise<any> {
    const path = query.path;

    const payload = {
      /* The path (duh) */
      p: path.toString(),

      /*
       This seems to be some sort of base64-encoded hash.
       I suspect it's used when attaching a listener to a path for which we already
       have data. As in, "here's what I have, don't resend the data if it's still the same".
       I'll have to figure out how this hash is computed... which means having to
       debug minified code. Sigh.
       EDIT: maybe it's something else? Even when the official SDK passes this hash, the server always
       returns the data even if it hasn't changed. Strange...
       EDIT 2: it's a bug on the web SDK. It's sending the wrong hash if the listener has a query.
       */
      h: this._model.child(path).hash
    };

    if (tag) {
      /*
       Querying parameters. If "q" is present then "t" is also present.
       q.l = limit, how many values to get
       q.vf = "values from"? It's either "r" (right, limitToLast) or "l" (left, limitToFirst)
       q.i: index used. Can be ".key" (orderByKey), ".value" (orderByValue), or the name of a child key (orderByChild)
       */
      payload['q'] = query.toObject();

      /*
       The SDK calls this the "tag". Since there can be more than one listener attached to
       the same path with different queries, this tag is used to uniquely identify data events
       associated with a listener that has a query... right?
       */
      payload['t'] = tag;
    }

    return this.sendDataMessage('q', null, payload);
  }

  private removeServerWatch(query: Query, tag: number): Promise<any> {
    const payload = {
      p: query.path.toString(),
    };

    if (tag) {
      payload['t'] = tag;
      payload['q'] = query.toObject();
    }

    return this.sendDataMessage('n', null, payload);
  }

  private processMessage(msg: object | null) {
    if (!msg) {
      return;
    }

    switch (msg['t']) {
      case 'c':
        this.processConnectionMessage(msg);
        break;
      case 'd':
        this.processDataMessage(msg);
        break;
      default:
        console.info('Unknown message type:', msg);
    }
  }

  private processConnectionMessage(msg: object) {
    const data: object = msg['d'];

    switch (data['t']) {

      case 'r':
        // Reconnect
        this.handleReset(data['d']);
        break;

      case 'h':
        // Handshake?
        this.handleHandshake(data, Date.now());
        break;

      case 'a':
        // I think this is the server requesting an ACK from the client
        // Let's send a ping
        this.send({
          t: 'c',
          d: {
            t: 'p',
            d: {}
          }
        });
        break;

      case 'o':
        // A pong from the server, responding to our ping
        // Let's send the ACK back to the server
        this.send({
          t: 'c',
          d: {
            t: 'a',
            d: {}
          }
        });
        break;

      case 'e':
        // Error message
        this._hasReceivedError = true;
        const err = data['d'].match(/^ClientId\[(.+)]:ErrorId\[(.+)]: (.+)$/);
        console.error(`FIREBASE ERROR! ClientId=${err[1]} - ErrorId=${err[2]} - ${err[3]}`);
        break;

      default:
        console.info('Unknown connection message:', msg);
    }
  }

  private processDataMessage(msg: { [k: string]: any }) {
    const data: { [k: string]: any } = msg.d;

    if (data.r) {
      this.processDataResponse(data);
    } else if (data.a) {
      switch (data.a) {
        case 'd':
          // New data for a specific key ("set" operation)
          this.processData(data.b);
          break;
        case 'm':
          // Multipath update
          this.processMultipathData(data.b);
          break;
        case 'ac':
          // Authentication?
          console.log('Auth message received:', data.b);
          break;
        case 'c':
          // We have lost read permission at a certain path/query
          this.processPermissionCancellation(<string>data.b.p, <QueryObject>data.b.q);
          break;
        default:
          console.info('Unknown data message (a):', msg);
      }
    } else {
      console.info('Wuuuut? Unknown data message:', msg);
    }

  }

  private processDataResponse(data: { [k: string]: any }) {
    const reqNumber: number = data.r;
    const response: { [k: string]: any } = data.b;

    // Check if there's any older request awaiting response and resend them
    const hadPending = this.checkPendingRequests(reqNumber);

    if (!hadPending && this._hasReceivedError) {
      this._hasReceivedError = false;
    }

    if (this._sentRequests[reqNumber]) {
      const request = this._sentRequests[reqNumber];
      const status: string = response.s;

      if (status === 'ok') {
        const responseData: { [k: string]: any } = response.d;

        request.resolve(responseData);

        if (responseData.w) {
          // The server is returning one or more warnings
          const warnings = <Array<string>> responseData.w;
          this.processDataMessageWarnings(reqNumber, warnings);
        }

      } else {
        const path = request.query ? ' at ' + request.query.path.toString() : '';

        // If this was an optimistic update, roll back any notified changes
        if (request.optimisticEvents) {
          this.rollbackOptimisticUpdate(request.optimisticEvents);
        }

        request.reject(new Error(`${status}${path}: ${response.d}`));
      }

      delete this._sentRequests[reqNumber];
    }
  }

  private processPermissionCancellation(pathStr: string, queryObject: QueryObject | null) {
    const query = new Reference(pathStr, this)._setOptions(queryObject);

    this._dataListeners.forEach((listener: DataListener) => {
      if (listener.query.isEqual(query)) {
        this.removeListener(listener, false);
        listener.observer.error(new Error(`permission_denied at ${query.path}: Client doesn't have permission to access the desired data.`));
      }
    });
  }

  /**
   * Responses always arrive in the same order they were sent. If we have a request with id number N awaiting a
   * response and at some point we get a response for a request with an id number larger than N, that means
   * that request has been skipped or lost for some reason (network error?). Let's resend those.
   *
   * TODO: is this how the official SDK handles this situation? Look into it.
   *
   * @param reqNumber
   */
  private checkPendingRequests(reqNumber) {
    const pending: SentDataRequest[] = [];

    Object.keys(this._sentRequests)
      .forEach((id: string) => {
        if (parseInt(id) < reqNumber) {
          // Before resending the requests we need to remove them from the registry, otherwise
          // we might enter an infinite resend loop.
          // Also: don't resend if we've just received an error.

          if (!this._hasReceivedError) {
            pending.push(this._sentRequests[id]);
          }

          delete this._sentRequests[id];
        }
      });

    pending.forEach((req: SentDataRequest) => this.resendDataMessage(req));
  }

  private handleHandshake(data: any, now: number) {
    const d = data['d'];

    this._serverInfo = {
      v: d['v'], // Version number? No idea
      host: d['h'],
      timeDiff: now - d['ts'],
      sessionKey: d['s'],
    };

    this._ready = true;

    this.sendDataMessage('s', null, {
      c: {
        [SDK_VERSION]: 1
      }
    });

    // Make sure we send any requests that had been added to the queue while we were connecting to the database
    this.flushDataMessageQueue();
  }

  /**
   * Sends any data messages that had been queued while the connection to the database was being initialized.
   */
  private flushDataMessageQueue() {
    // First of all, let's check if there's auth messages in the queue.
    // If there's any, we only keep the last one and discard the rest.
    let auth = null;
    const queue: any[] = [];
    this._dataMessageQueue.forEach((msg: any) => {
      if (msg['type'] === 'auth')
        auth = msg;
      else
        queue.push(msg);
    });

    const sendQueuedMessage = (msg: any) => {
      const {resolve, reject, type, query, payload, optimisticEvents} = msg;
      this.resendDataMessage({
        resolve,
        reject,
        query,
        optimisticEvents,
        data: {
          r: 0, // this will be discarded
          a: type,
          b: payload
        }
      });
    };

    // Send the auth message first, if there's one
    if (auth)
      sendQueuedMessage(auth);

    // Send the rest of the queue
    while (queue.length > 0) {
      sendQueuedMessage(queue.shift());
    }
  }

  private processData(data: { [k: string]: any }) {
    // TODO: sanity check on the data? It comes from the server, but still.

    // The path for the data we're recieving
    const path = new Path(data.p);

    // The value of the new data
    const value: any = data.d;

    // Query "tag"
    const tag: number = data.t;

    this.updateModel(path, value, {tag});
  }

  private processMultipathData(data: { [k: string]: any }) {
    // TODO: sanity check on the data? It comes from the server, but still.
    Object.getOwnPropertyNames(data.d).forEach((key: string) => {
      this.updateModel(new Path(data.p).child(key), data.d[key], {tag: data.t});
    });
  }

  private processDataMessageWarnings(reqNumber: number, warnings: string[]) {
    const req = this._sentRequests[reqNumber].data;

    warnings.forEach((warning: string) => {
      switch (warning) {
        case 'no_index':
          console.warn(`FIREBASE WARNING: Using an unspecified index. Consider adding ".indexOn": "${req['q']['i']}" at ${req['b']['p']} to your security rules for better performance`);
          break;
        default:
          console.warn(`FIREBASE WARNING ("${warning}"):`, req);
      }
    });
  }

  /**
   * Rolls back any model changes and notifier events triggered as part of
   * an optimistic update that was rejected.
   * @param optimisticEvents
   */
  private rollbackOptimisticUpdate(optimisticEvents: NotifierEvent[]) {
    while (optimisticEvents.length) {
      const event = optimisticEvents.shift();

      switch (event.type) {
        case 'value':
          this.updateModel(event.path, event.rollbackModel, {tag: event.tag});
          break;
        case 'child_added':
          this.updateModel(event.path.child(event.model.key), null, {tag: event.tag});
          break;
        case 'child_removed':
          this.updateModel(event.path.child(event.model.key), event.model, {tag: event.tag});
          break;
        case 'child_changed':
          this.updateModel(event.path.child(event.model.key), event.rollbackModel, {tag: event.tag});
          break;
        case 'child_moved':
          // TODO: handle "child_moved" rollbacks after implementing this type of event
          break;
      }
    }
  }
}

/**
 *
 */
export interface ServerInfo {
  timeDiff: number;
  host?: string;
  sessionKey?: string;
  v?: string;
}

/**
 *
 */
export type EventType =
  'value'
  | 'child_added'
  | 'child_removed'
  | 'child_moved'
  | 'child_changed';


/**
 *
 */
interface SentDataRequest {
  resolve: (val) => void;
  reject: (val) => void;
  data: any;
  query: Query | null;
  optimisticEvents?: NotifierEvent[];
}

/**
 *
 */
export interface DataListener {
  query: Query;
  type: EventType;
  isActive: boolean;
  tag: number;
  observer?: Observer<DataSnapshot>;
}

function websocketResultSelector(): (e: MessageEvent) => any {
  let _pendingFrames: number;
  let _buffer: string;

  return (e: MessageEvent): any => {
    if (_pendingFrames) {
      // FIXME: string concatenation might not be the most performant approach. Maybe ArrayBuffers? Look into it.
      _buffer += e.data;

      if (--_pendingFrames) {
        // Return null if there's pending frames
        return null;
      }

      if ((typeof _buffer === 'undefined') || !_buffer.length) {
        // There should be data in the buffer by now, but return null in case there isn't
        return null;
      }

      // Parse the JSON buffer
      const parsed = JSON.parse(_buffer);

      // Clear the buffer and the pending counter
      _pendingFrames = void 0;
      _buffer = void 0;

      return parsed;
    } else if (e.data.length) {
      if (isNaN(e.data[0])) {
        // We're getting a whole message in a single frame
        return JSON.parse(e.data);
      } else {
        // The server is telling us how many frames compose the next message
        _pendingFrames = parseInt(e.data);
        _buffer = '';
        return null;
      }
    } else {
      // We got an empty frame. Shouldn't happen but let's handle it gracefully just in case
      return null;
    }
  }
}
