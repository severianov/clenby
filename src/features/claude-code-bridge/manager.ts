/**
 * Background WS client manager — the extension half of the Claude Code bridge
 * (spec §4–§5). Runs ONLY in the background worker: a content script on
 * https://claude.ai cannot open `ws://127.0.0.1` (Reviewer note 2).
 *
 * Responsibilities:
 * - Scan the loopback port range and hold ONE socket per live bridge, keeping
 *   every port that returns `welcome` (spec §5). Roster = one entry per socket.
 * - Present the per-machine pairing token (storage.local) on connect; drop any
 *   socket that fails the Origin/token gate (the bridge closes it).
 * - Push a handoff to a bound session and resolve on its `ack` — no ack ⇒
 *   "nothing sent" (spec §3). Nothing is buffered or replayed.
 * - Answer inbound `req` frames (delegated to `reqHandler` — the background
 *   routes `push_to_composer` to a content tab).
 * - Keep the MV3 worker warm while connected via a WS-ping heartbeat, and
 *   reconnect dropped sockets with capped-exponential backoff (spec §5).
 *
 * Every inbound frame passes the envelope guards in shared/bridge-protocol.ts;
 * anything else is refused (threat model §6).
 */

import { browser } from "wxt/browser";
import {
  BRIDGE_HOST_PERMISSION,
  BRIDGE_PORTS,
  BRIDGE_SCAN_TIMEOUT_MS,
  BRIDGE_TOKEN_KEY,
  bridgeWsUrl,
  helloFrame,
  parseInboundFrame,
  pingFrame,
  pongFrame,
  pushFrame,
  resErr,
  resOk,
  shortIdOf,
  type BridgeAckResult,
  type BridgePairResult,
  type BridgeSession,
  type BridgeStatus,
  type PushMeta,
  type ResFrame,
} from "@/shared/bridge-protocol";

/** How long a push waits for its ack before reporting "nothing sent". */
const ACK_TIMEOUT_MS = 6000;
/** No `welcome` within this window ⇒ the socket is not a bridge; drop it. */
const WELCOME_TIMEOUT_MS = 2500;
/** Poll cadence while a push waits for its target session's socket to welcome
 *  (MV3 respawn race): resolve the instant it lands instead of sleeping the
 *  whole settle window — same worst case, far better typical. */
const SETTLE_POLL_MS = 150;
/** Heartbeat: ping open sockets + rescan missing ports. < 30 s keeps the
 *  Chrome MV3 worker warm off WS traffic (spec §5). */
const HEARTBEAT_MS = 15_000;
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

type ConnState = "connecting" | "open" | "welcomed" | "closed";

interface Conn {
  port: number;
  ws: WebSocket;
  state: ConnState;
  session: BridgeSession | null;
  openTimer: ReturnType<typeof setTimeout> | null;
  welcomeTimer: ReturnType<typeof setTimeout> | null;
  /** Pending handoff acks keyed by push id. */
  acks: Map<string, { resolve: (r: BridgeAckResult) => void; timer: ReturnType<typeof setTimeout> }>;
}

export interface BridgeManagerOptions {
  extVersion: string;
  /** Push the fresh roster/status to content tabs. */
  onRosterChanged: (status: BridgeStatus) => void;
  /** Answer an inbound tool call. `push_to_composer` is routed to a tab; other
   *  methods may be added later. */
  reqHandler: (method: string, params: unknown) => Promise<
    { ok: true; result: unknown } | { ok: false; code: string; message: string }
  >;
}

export class BridgeManager {
  readonly #opts: BridgeManagerOptions;
  readonly #conns = new Map<number, Conn>();
  #token: string | null = null;
  #hasPermission = false;
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #backoffMs = BACKOFF_MIN_MS;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: BridgeManagerOptions) {
    this.#opts = opts;
  }

  /** Load stored token + permission and, when paired, scan. Safe to call again
   *  after a worker respawn. */
  async init(): Promise<void> {
    await this.#refreshCreds();
    if (this.#token && this.#hasPermission) {
      this.scan();
      // Paired ⇒ the heartbeat runs for good (not only while sessions exist):
      // it is what discovers a bridge that starts LATER and what retries after
      // a failed probe. Stopping it on an empty roster was the "extension
      // never reconnects until you touch the tab" bug.
      this.#startHeartbeat();
    }
  }

  status(): BridgeStatus {
    return {
      paired: this.#token !== null,
      hasPermission: this.#hasPermission,
      sessions: this.roster(),
    };
  }

  roster(): BridgeSession[] {
    const out: BridgeSession[] = [];
    for (const c of this.#conns.values()) {
      if (c.state === "welcomed" && c.session) out.push(c.session);
    }
    return out.sort((a, b) => b.connectedAt - a.connectedAt);
  }

  /** Any content message wakes the worker — take the chance to reconnect. */
  wake(): void {
    if (this.#token && this.#hasPermission) this.scan();
  }

  // ---- pairing ------------------------------------------------------------

  /** Request the loopback permission (needs the forwarded user gesture), store
   *  the pasted token, and scan. Empty sessions is the "paired, no session"
   *  state — not an error. */
  async pair(code: string): Promise<BridgePairResult> {
    const token = code.trim();
    if (token.length === 0) return { ok: false, reason: "Paste the pairing code from your terminal first." };
    let granted = false;
    try {
      granted = await browser.permissions.request({ origins: [BRIDGE_HOST_PERMISSION] });
    } catch {
      return {
        ok: false,
        reason:
          "The browser refused the permission prompt from here (Firefox requires it from extension UI).",
      };
    }
    if (!granted) {
      return { ok: false, reason: "Access to 127.0.0.1 was not granted — nothing was saved." };
    }
    await browser.storage.local.set({ [BRIDGE_TOKEN_KEY]: token });
    this.#token = token;
    this.#hasPermission = true;
    this.#startHeartbeat();
    await this.#scanAndSettle();
    return { ok: true, status: this.status() };
  }

  /** Forget the pairing: drop sockets, wipe the token, release the permission. */
  async forget(): Promise<{ ok: true }> {
    this.#token = null;
    for (const c of [...this.#conns.values()]) this.#drop(c, /* broadcast */ false);
    this.#stopHeartbeat();
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    await browser.storage.local.remove(BRIDGE_TOKEN_KEY).catch(() => undefined);
    try {
      await browser.permissions.remove({ origins: [BRIDGE_HOST_PERMISSION] });
      this.#hasPermission = false;
    } catch {
      // Some browsers refuse programmatic removal — the token is gone regardless.
    }
    this.#hasPermission = await this.#permissionGranted();
    this.#broadcast();
    return { ok: true };
  }

  // ---- push (web → code) --------------------------------------------------

  async push(sessionId: string, id: string, markdown: string, meta: PushMeta): Promise<BridgeAckResult> {
    let conn = this.#connForSession(sessionId);
    if (!conn) {
      // MV3 respawn race: the worker may have just been revived by this very
      // message, before its rescan finished. Scan and give the handshake a
      // moment before declaring the session gone — otherwise the FIRST send
      // after a worker restart always false-fails. Poll for THIS session so we
      // proceed the instant its socket welcomes rather than sleeping the whole
      // settle window (a loopback bridge usually welcomes in a fraction of it).
      await this.#scanAndSettle(sessionId);
      conn = this.#connForSession(sessionId);
    }
    if (!conn) return { ok: false, reason: "session disconnected — nothing sent" };
    const socket = conn;
    return new Promise<BridgeAckResult>((resolve) => {
      const timer = setTimeout(() => {
        socket.acks.delete(id);
        resolve({
          ok: false,
          reason: "Claude Code didn't confirm receipt in time — nothing sent. Try again.",
        });
      }, ACK_TIMEOUT_MS);
      socket.acks.set(id, { resolve, timer });
      try {
        socket.ws.send(
          JSON.stringify(
            pushFrame({
              id,
              handle: meta.handle,
              scope: meta.scope,
              source_id: meta.source_id,
              ...(meta.source_title !== undefined ? { source_title: meta.source_title } : {}),
              sent_at: meta.sent_at,
              markdown,
            }),
          ),
        );
      } catch {
        clearTimeout(timer);
        socket.acks.delete(id);
        resolve({ ok: false, reason: "session disconnected — nothing sent" });
      }
    });
  }

  // ---- scanning / connections --------------------------------------------

  scan(): void {
    if (!this.#token || !this.#hasPermission) return;
    for (const port of BRIDGE_PORTS) {
      if (!this.#conns.has(port)) this.#connect(port);
    }
  }

  /** Scan once, then give sockets a moment to hand back `welcome`.
   *
   *  With a target `sessionId` (the push path) POLL and resolve the instant
   *  that session is welcomed — same worst case as the fixed wait (it never
   *  shows up ⇒ we sit out the whole window then fail), but the common MV3
   *  respawn case settles in ~a poll or two instead of a flat 2.7 s. Whoever
   *  opens the socket (this scan or the concurrent init() scan) the poll picks
   *  it up. Without a target (pairing UX) wait the whole window so the entire
   *  roster can populate before we report status. */
  async #scanAndSettle(sessionId?: string): Promise<void> {
    this.scan();
    const deadline = Date.now() + WELCOME_TIMEOUT_MS + 200;
    if (sessionId === undefined) {
      await new Promise((r) => setTimeout(r, WELCOME_TIMEOUT_MS + 200));
      return;
    }
    while (Date.now() < deadline) {
      if (this.#connForSession(sessionId)) return; // welcomed — stop waiting
      await new Promise((r) => setTimeout(r, SETTLE_POLL_MS));
    }
  }

  #connect(port: number): void {
    if (!this.#token) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(bridgeWsUrl(port));
    } catch {
      return;
    }
    const conn: Conn = {
      port,
      ws,
      state: "connecting",
      session: null,
      openTimer: setTimeout(() => this.#drop(conn, false), BRIDGE_SCAN_TIMEOUT_MS),
      welcomeTimer: null,
      acks: new Map(),
    };
    this.#conns.set(port, conn);

    ws.onopen = () => {
      if (conn.openTimer) clearTimeout(conn.openTimer);
      conn.openTimer = null;
      conn.state = "open";
      conn.welcomeTimer = setTimeout(() => this.#drop(conn, false), WELCOME_TIMEOUT_MS);
      try {
        ws.send(JSON.stringify(helloFrame(this.#token ?? "", this.#opts.extVersion)));
      } catch {
        this.#drop(conn, false);
      }
    };
    ws.onmessage = (ev: MessageEvent) => {
      this.#onFrame(conn, typeof ev.data === "string" ? ev.data : "");
    };
    ws.onerror = () => this.#drop(conn, conn.state === "welcomed");
    ws.onclose = () => this.#drop(conn, conn.state === "welcomed");
  }

  #onFrame(conn: Conn, raw: string): void {
    const frame = parseInboundFrame(raw);
    if (!frame) return; // refuse anything outside the envelope schema (§6)
    // Handshake gate (security review CCB-1): until a `welcome` has landed,
    // the ONLY frame we honor is `welcome` (and `error`, which just tears us
    // down). A port-squatter that accepted our socket but never welcomed must
    // NOT be able to drive push_to_composer or fake a session by sending a
    // bare `req`/`ack`/`ping` — those are ignored pre-welcome.
    if (conn.state !== "welcomed" && frame.t !== "welcome" && frame.t !== "error") {
      return;
    }
    switch (frame.t) {
      case "welcome": {
        // One identity per socket: a repeat `welcome` on an already-welcomed
        // connection must not rebind the session (roster churn / id swap).
        if (conn.state === "welcomed") break;
        if (conn.welcomeTimer) clearTimeout(conn.welcomeTimer);
        conn.welcomeTimer = null;
        conn.state = "welcomed";
        conn.session = {
          sessionId: frame.sessionId,
          shortId: shortIdOf(frame.sessionId),
          ...(typeof frame.petname === "string" && frame.petname.length > 0 && frame.petname.length <= 40
            ? { petname: frame.petname }
            : {}),
          port: conn.port,
          project: frame.project || "session",
          path: frame.path,
          ...(frame.startedAt ? { startedAt: frame.startedAt } : {}),
          connectedAt: Date.now(),
        };
        this.#backoffMs = BACKOFF_MIN_MS;
        this.#startHeartbeat();
        this.#broadcast();
        break;
      }
      case "error":
        // Bad token / wrong Origin — the bridge is about to close us. Drop
        // quietly; a rescan retries (a wrong token just keeps failing).
        this.#drop(conn, false);
        break;
      case "ack": {
        const pending = conn.acks.get(frame.id);
        if (pending) {
          clearTimeout(pending.timer);
          conn.acks.delete(frame.id);
          pending.resolve({ ok: true });
        }
        break;
      }
      case "ping":
        this.#send(conn, pongFrame());
        break;
      case "pong":
        break; // heartbeat answer — liveness is implicit in the open socket
      case "req":
        void this.#handleReq(conn, frame.id, frame.method, frame.params);
        break;
    }
  }

  async #handleReq(conn: Conn, id: string, method: string, params: unknown): Promise<void> {
    let res: ResFrame;
    try {
      const out = await this.#opts.reqHandler(method, params);
      res = out.ok ? resOk(id, out.result) : resErr(id, out.code, out.message);
    } catch {
      res = resErr(id, "internal", "The extension failed to handle that tool call.");
    }
    this.#send(conn, res);
  }

  #send(conn: Conn, frame: unknown): void {
    try {
      conn.ws.send(JSON.stringify(frame));
    } catch {
      // socket gone — the close handler will clean up
    }
  }

  #drop(conn: Conn, wasLive: boolean): void {
    if (this.#conns.get(conn.port) === conn) this.#conns.delete(conn.port);
    if (conn.openTimer) clearTimeout(conn.openTimer);
    if (conn.welcomeTimer) clearTimeout(conn.welcomeTimer);
    for (const p of conn.acks.values()) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, reason: "session disconnected — nothing sent" });
    }
    conn.acks.clear();
    conn.state = "closed";
    try {
      conn.ws.onopen = conn.ws.onmessage = conn.ws.onerror = conn.ws.onclose = null;
      conn.ws.close();
    } catch {
      // already closed
    }
    // NOTE: the heartbeat intentionally keeps running on an empty roster —
    // while paired it doubles as the rediscovery loop (see init()).
    if (wasLive) {
      this.#broadcast();
      this.#scheduleReconnect();
    }
  }

  #connForSession(sessionId: string): Conn | null {
    for (const c of this.#conns.values()) {
      if (c.state === "welcomed" && c.session?.sessionId === sessionId) return c;
    }
    return null;
  }

  // ---- heartbeat + reconnect ---------------------------------------------

  #startHeartbeat(): void {
    if (this.#heartbeat !== null) return;
    this.#heartbeat = setInterval(() => {
      for (const c of this.#conns.values()) {
        if (c.state === "welcomed") this.#send(c, pingFrame());
      }
      this.scan(); // discover new sessions + retry missing ports
    }, HEARTBEAT_MS);
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat !== null) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = null;
    }
  }

  #scheduleReconnect(): void {
    if (this.#reconnectTimer !== null) return;
    const delay = this.#backoffMs;
    this.#backoffMs = Math.min(BACKOFF_MAX_MS, this.#backoffMs * 2);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.scan();
    }, delay);
  }

  // ---- creds --------------------------------------------------------------

  async #refreshCreds(): Promise<void> {
    try {
      const raw = await browser.storage.local.get(BRIDGE_TOKEN_KEY);
      const t = raw[BRIDGE_TOKEN_KEY];
      this.#token = typeof t === "string" && t.length > 0 ? t : null;
    } catch {
      this.#token = null;
    }
    this.#hasPermission = await this.#permissionGranted();
  }

  async #permissionGranted(): Promise<boolean> {
    try {
      return await browser.permissions.contains({ origins: [BRIDGE_HOST_PERMISSION] });
    } catch {
      return false;
    }
  }

  #broadcast(): void {
    this.#opts.onRosterChanged(this.status());
  }
}
