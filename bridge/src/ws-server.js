/**
 * Loopback WebSocket listener (spec §4, §5, §6).
 *
 * Binds 127.0.0.1 ONLY, on the first free port in the range. The extension is
 * the client; it connects out, sends `hello` with the pairing token, and gets
 * a self-describing `welcome`. Two independent gates defeat drive-by pages:
 *   (a) the handshake Origin must be a browser-extension origin;
 *   (b) the first frame must carry the correct pairing token.
 * Missing either ⇒ immediate close (spec §6 threat model).
 *
 * Requests flow bridge → extension (tool proxy); pushes flow extension →
 * bridge (handoff delivery). Frames are size-capped by ws `maxPayload`.
 */

import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

import {
  ENVELOPE_VERSION,
  LOOPBACK_HOST,
  MAX_FRAME_BYTES,
  ALLOWED_ORIGIN_SCHEMES,
  PROXY_TIMEOUT_MS,
  HELLO_TIMEOUT_MS,
  ERR_NOT_CONNECTED,
} from './constants.js';
import { welcomeFrame } from './session.js';
import { tokenEquals } from './token.js';
import { log, warn } from './log.js';

/** True if an Origin header is a browser-extension origin (spec §6). */
export function isAllowedOrigin(origin) {
  if (typeof origin !== 'string' || !origin) return false;
  return ALLOWED_ORIGIN_SCHEMES.some((scheme) => origin.startsWith(scheme));
}

/**
 * Bind a WebSocketServer on the first free port in `ports` (loopback only).
 * @param {number[]} ports
 * @param {object} wssOpts Extra WebSocketServer options.
 * @returns {Promise<{ wss: import('ws').WebSocketServer, port: number }>}
 */
export function bindFirstFreePort(ports, wssOpts) {
  return new Promise((resolve, reject) => {
    let i = 0;
    const tryNext = () => {
      if (i >= ports.length) {
        reject(new Error(`no free port in range ${ports[0]}–${ports[ports.length - 1]}`));
        return;
      }
      const port = ports[i++];
      // Spread first so host/port can never be overridden by options — the
      // loopback bind is a security invariant, not a default.
      const wss = new WebSocketServer({ ...wssOpts, host: LOOPBACK_HOST, port });
      const onError = (err) => {
        wss.removeListener('listening', onListening);
        // Any per-port bind failure ⇒ try the next port. EADDRINUSE is the
        // common case; Windows raises EACCES for excluded port ranges and
        // EADDRNOTAVAIL exists on exotic stacks — none of them should kill
        // the whole scan while free ports remain.
        if (err && (err.code === 'EADDRINUSE' || err.code === 'EACCES' || err.code === 'EADDRNOTAVAIL')) {
          tryNext();
        } else {
          reject(err);
        }
      };
      const onListening = () => {
        wss.removeListener('error', onError);
        const addr = wss.address();
        resolve({ wss, port: addr && typeof addr === 'object' ? addr.port : port });
      };
      wss.once('error', onError);
      wss.once('listening', onListening);
    };
    tryNext();
  });
}

export class WsBridge {
  /**
   * @param {object} opts
   * @param {import('./session.js').Session} opts.session
   * @param {import('./handoffs.js').HandoffStore} opts.store
   * @param {string} opts.token
   * @param {string} opts.bridgeVersion
   * @param {(rec: import('./handoffs.js').HandoffRecord) => (void|Promise<void>)} [opts.onHandoff]
   * @param {number} [opts.maxFrameBytes]
   * @param {number} [opts.helloTimeoutMs]
   */
  constructor(opts) {
    this.session = opts.session;
    this.store = opts.store;
    this.token = opts.token;
    this.bridgeVersion = opts.bridgeVersion;
    this.onHandoff = opts.onHandoff || (() => {});
    this.maxFrameBytes = opts.maxFrameBytes ?? MAX_FRAME_BYTES;
    this.helloTimeoutMs = opts.helloTimeoutMs ?? HELLO_TIMEOUT_MS;

    /** @type {import('ws').WebSocketServer|null} */
    this.wss = null;
    /** @type {number|null} */
    this.port = null;
    /** authenticated sockets, insertion order (last = most recent) @type {Set<import('ws').WebSocket>} */
    this._authed = new Set();
    /** @type {Map<string, {resolve:Function, reject:Function, timer:NodeJS.Timeout, socket:any}>} */
    this._pending = new Map();
  }

  /**
   * Bind and start listening on the first free port in `ports`.
   * @param {number[]} ports
   * @returns {Promise<number>} the bound port
   */
  async start(ports) {
    const { wss, port } = await bindFirstFreePort(ports, {
      maxPayload: this.maxFrameBytes,
      // Gate (a): reject any non browser-extension Origin at the handshake.
      verifyClient: (info) => {
        const ok = isAllowedOrigin(info.origin);
        if (!ok) warn('rejected handshake: bad origin', info.origin || '(none)');
        return ok;
      },
    });
    this.wss = wss;
    this.port = port;
    wss.on('connection', (socket, req) => this._onConnection(socket, req));
    return port;
  }

  /** @param {import('ws').WebSocket} socket @param {import('http').IncomingMessage} req */
  _onConnection(socket, req) {
    let authed = false;
    const helloTimer = setTimeout(() => {
      if (!authed) {
        warn('no hello within timeout — closing');
        this._sendError(socket, 'unauthorized');
        // terminate(), not close(): an unauthenticated peer that ignores the
        // close handshake would otherwise hold the TCP socket ~30 s.
        this._closeThenTerminate(socket);
      }
    }, this.helloTimeoutMs);

    socket.on('message', (data, isBinary) => {
      // Defense-in-depth beyond ws maxPayload.
      if (data.length > this.maxFrameBytes) {
        socket.close(1009, 'frame too large');
        return;
      }
      let frame;
      try {
        // ws hands Buffers for text and binary alike; isBinary is irrelevant
        // to decoding here — the envelope is always UTF-8 JSON.
        frame = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
      } catch {
        warn('dropping unparseable frame');
        socket.close(1003, 'bad frame');
        return;
      }
      if (!frame || frame.v !== ENVELOPE_VERSION || typeof frame.t !== 'string') {
        socket.close(1003, 'bad envelope');
        return;
      }

      if (!authed) {
        // Gate (b): first frame must be a hello carrying the correct token.
        if (frame.t !== 'hello' || !tokenEquals(frame.token, this.token)) {
          warn('rejected connection: bad or missing token');
          this._sendError(socket, 'unauthorized');
          this._closeThenTerminate(socket);
          return;
        }
        authed = true;
        clearTimeout(helloTimer);
        this._authed.add(socket);
        this._send(socket, welcomeFrame(this.session, this.bridgeVersion));
        log(`extension connected (${frame.client || 'unknown'} ${frame.ext_version || ''})`.trim());
        return;
      }

      this._onAuthedFrame(socket, frame);
    });

    socket.on('close', () => {
      clearTimeout(helloTimer);
      this._authed.delete(socket);
      // Fail any in-flight requests routed to this socket.
      for (const [id, p] of this._pending) {
        if (p.socket === socket) {
          clearTimeout(p.timer);
          this._pending.delete(id);
          p.reject(new Error('session disconnected'));
        }
      }
    });

    socket.on('error', (err) => warn('socket error', err.message));
  }

  /** @param {import('ws').WebSocket} socket @param {any} frame */
  _onAuthedFrame(socket, frame) {
    switch (frame.t) {
      case 'res': {
        const pending = this._pending.get(frame.id);
        if (!pending) return; // late/duplicate — ignore
        // A response only counts from the socket the request went out on —
        // with two paired browsers connected, answers must not cross-wire.
        if (pending.socket !== socket) return;
        clearTimeout(pending.timer);
        this._pending.delete(frame.id);
        if (frame.ok) pending.resolve(frame.result);
        else {
          const err = frame.error || {};
          pending.reject(new Error(err.message || err.code || 'extension error'));
        }
        return;
      }
      case 'push': {
        this._handlePush(socket, frame);
        return;
      }
      case 'ping':
        // Heartbeat (spec §5): the extension pings ~every 15 s; answer so the
        // contract is two-sided and stderr stays quiet.
        this._send(socket, { v: ENVELOPE_VERSION, t: 'pong' });
        return;
      case 'pong':
        return; // answer to a ping of ours — nothing to do
      case 'hello':
        return; // already authenticated; ignore repeat
      default:
        warn('ignoring unknown frame type', frame.t);
    }
  }

  /** Ingest a handoff push: store → notify → ack (spec §5 ordering). */
  async _handlePush(socket, frame) {
    if (frame.topic !== 'handoff' || typeof frame.id !== 'string' || frame.id.length === 0) {
      warn('ignoring malformed push');
      return;
    }
    const rec = this.store.add(frame);
    try {
      await this.onHandoff(rec);
    } catch (err) {
      warn('onHandoff failed', err.message);
    }
    this._send(socket, { v: ENVELOPE_VERSION, t: 'ack', id: rec.id });
  }

  /** @returns {boolean} */
  hasClient() {
    for (const s of this._authed) if (s.readyState === s.OPEN) return true;
    return false;
  }

  /** Most recently connected live socket, or null. */
  _pickClient() {
    let chosen = null;
    for (const s of this._authed) if (s.readyState === s.OPEN) chosen = s;
    return chosen;
  }

  /**
   * Proxy a tool call to the extension and await its response.
   * @param {string} method
   * @param {object} [params]
   * @param {number} [timeoutMs]
   * @returns {Promise<any>}
   */
  request(method, params = {}, timeoutMs = PROXY_TIMEOUT_MS) {
    const socket = this._pickClient();
    if (!socket) return Promise.reject(new Error(ERR_NOT_CONNECTED));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        // Distinct from ERR_NOT_CONNECTED: the extension IS connected, it just
        // didn't answer in time (large conversation, busy tab). Saying
        // "not connected" here used to send users off to re-pair for nothing.
        reject(
          new Error(
            `The Clenby extension didn't answer "${method}" within ${Math.round(timeoutMs / 1000)}s — ` +
              'it may be busy with a large conversation. Try again, or ask for a smaller scope.',
          ),
        );
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer, socket });
      this._send(socket, { v: ENVELOPE_VERSION, t: 'req', id, method, params });
    });
  }

  _send(socket, frame) {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
  }

  _sendError(socket, code) {
    this._send(socket, { v: ENVELOPE_VERSION, t: 'error', code });
  }

  /** Polite close first (so the error frame flushes), hard terminate for
   *  peers that ignore the close handshake. Unauthenticated sockets only. */
  _closeThenTerminate(socket) {
    try {
      socket.close();
    } catch {
      /* ignore */
    }
    const t = setTimeout(() => {
      try {
        socket.terminate();
      } catch {
        /* ignore */
      }
    }, 1000);
    if (typeof t.unref === 'function') t.unref();
  }

  /** Close the listener and reject anything in flight. */
  async close() {
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(new Error('bridge closing'));
    }
    this._pending.clear();
    for (const s of this._authed) {
      try {
        s.close();
      } catch {
        /* ignore */
      }
    }
    this._authed.clear();
    if (this.wss) {
      await new Promise((resolve) => this.wss.close(() => resolve()));
      this.wss = null;
    }
  }
}
