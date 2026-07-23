/**
 * Claude Code bridge — wire protocol (pure data + types + guards).
 *
 * Two channels are described here, both as plain data so the background worker,
 * the content feature, and the unit tests can all import without a browser API:
 *
 *  1. The loopback WebSocket envelope between the extension background and each
 *     `clenby-bridge` process (spec §5). One JSON frame per message, versioned.
 *     The background REFUSES any frame that fails these guards (threat model
 *     §6: "the extension additionally refuses any frame type outside the
 *     envelope schema").
 *  2. The runtime-message contract between the content script and the
 *     background (roster/status push, handoff send, `push_to_composer` relay).
 *
 * The WS client lives in the background, never a content script: a page on
 * https://claude.ai cannot open `ws://127.0.0.1` (mixed content + the page CSP)
 * — Reviewer note 2.
 */

import type { HandoffHandle, HandoffScope } from "./handoff";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Envelope version carried on every frame. */
export const BRIDGE_PROTOCOL_VERSION = 1;

/** Loopback bind — nothing off-box can open the socket (spec §6). */
export const BRIDGE_HOST = "127.0.0.1";

/** The scanned port range (inclusive). 10 ports ⇒ at most 10 bridges (spec §4). */
export const BRIDGE_PORT_MIN = 47850;
export const BRIDGE_PORT_MAX = 47859;
export const BRIDGE_PORTS: readonly number[] = Array.from(
  { length: BRIDGE_PORT_MAX - BRIDGE_PORT_MIN + 1 },
  (_, i) => BRIDGE_PORT_MIN + i,
);

/** Per-port WS connect timeout while scanning (spec §5). */
export const BRIDGE_SCAN_TIMEOUT_MS = 300;

/** The optional host permission requested at pairing (spec §7). Match patterns
 *  forbid ports, so the grant covers all of loopback — the gear-menu explainer
 *  (§5), shown before the browser's own popup, is the mitigation. */
export const BRIDGE_HOST_PERMISSION = "http://127.0.0.1/*";

/** `storage.local` key holding the per-machine pairing token (spec §6). */
export const BRIDGE_TOKEN_KEY = "cc:bridgeToken";

/** Pre-send cap on handoff markdown. The bridge closes any frame over 8 MiB
 *  (its `maxPayload`); JSON escaping inflates the payload, so cap well below
 *  that and fail with an explanation INSTEAD of a socket close the manager
 *  would misreport as a disconnect. */
export const MAX_PUSH_MARKDOWN_CHARS = 4_000_000;

export function bridgeWsUrl(port: number): string {
  return `ws://${BRIDGE_HOST}:${port}`;
}

/** First 4 hex of the sessionId — shown to tell two same-folder sessions
 *  apart (spec §4). */
export function shortIdOf(sessionId: string): string {
  return sessionId.replace(/[^0-9a-f]/gi, "").slice(0, 4).toLowerCase();
}

// ---------------------------------------------------------------------------
// WS frames
// ---------------------------------------------------------------------------

/** extension → bridge, first frame after connect. */
export interface HelloFrame {
  v: number;
  t: "hello";
  token: string;
  client: "clenby-ext";
  ext_version: string;
}

/** bridge → extension — self-describes so the extension routes without a probe. */
export interface WelcomeFrame {
  v: number;
  t: "welcome";
  sessionId: string;
  bridge_version?: string;
  project: string;
  path: string;
  pid?: number;
  startedAt?: string;
}

/** bridge → extension, on bad/absent token or wrong Origin (then it closes). */
export interface ErrorFrame {
  v: number;
  t: "error";
  code: string;
}

/** bridge → extension — a tool call the extension must answer. */
export interface ReqFrame {
  v: number;
  t: "req";
  id: string;
  method: string;
  params?: unknown;
}

/** extension → bridge — the answer to a {@link ReqFrame}. */
export type ResFrame =
  | { v: number; t: "res"; id: string; ok: true; result: unknown }
  | { v: number; t: "res"; id: string; ok: false; error: { code: string; message: string } };

/** extension → bridge, unsolicited — the web→code delivery path. */
export interface PushFrame {
  v: number;
  t: "push";
  topic: "handoff";
  id: string;
  meta: {
    handle: HandoffHandle;
    scope: HandoffScope;
    source_id: string;
    /** Carried in meta so the bridge never re-parses it out of the markdown
     *  frontmatter (whose mini-parser mangles `#` and quoted strings). */
    source_title?: string;
    sent_at: string;
  };
  markdown: string;
}

/** bridge → extension — confirms delivery of one push (no ack ⇒ "nothing sent"). */
export interface AckFrame {
  v: number;
  t: "ack";
  id: string;
}

/** Keepalive (spec §5: the heartbeat "pings over the WS"). Either side may
 *  ping; the peer answers with a pong. Unknown frames are ignored, so a bridge
 *  that never pongs simply is not kept warm by pongs. */
export interface PingFrame {
  v: number;
  t: "ping";
}
export interface PongFrame {
  v: number;
  t: "pong";
}

export type BridgeFrame =
  | HelloFrame
  | WelcomeFrame
  | ErrorFrame
  | ReqFrame
  | ResFrame
  | PushFrame
  | AckFrame
  | PingFrame
  | PongFrame;

// ---- frame builders (extension → bridge) ----

export function helloFrame(token: string, extVersion: string): HelloFrame {
  return {
    v: BRIDGE_PROTOCOL_VERSION,
    t: "hello",
    token,
    client: "clenby-ext",
    ext_version: extVersion,
  };
}

export function pushFrame(item: {
  id: string;
  handle: HandoffHandle;
  scope: HandoffScope;
  source_id: string;
  source_title?: string;
  sent_at: string;
  markdown: string;
}): PushFrame {
  return {
    v: BRIDGE_PROTOCOL_VERSION,
    t: "push",
    topic: "handoff",
    id: item.id,
    meta: {
      handle: item.handle,
      scope: item.scope,
      source_id: item.source_id,
      ...(item.source_title !== undefined ? { source_title: item.source_title } : {}),
      sent_at: item.sent_at,
    },
    markdown: item.markdown,
  };
}

export function resOk(id: string, result: unknown): ResFrame {
  return { v: BRIDGE_PROTOCOL_VERSION, t: "res", id, ok: true, result };
}
export function resErr(id: string, code: string, message: string): ResFrame {
  return { v: BRIDGE_PROTOCOL_VERSION, t: "res", id, ok: false, error: { code, message } };
}
export function pingFrame(): PingFrame {
  return { v: BRIDGE_PROTOCOL_VERSION, t: "ping" };
}
export function pongFrame(): PongFrame {
  return { v: BRIDGE_PROTOCOL_VERSION, t: "pong" };
}

// ---- guards (background refuses anything that fails these) ----

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

export function isWelcomeFrame(v: unknown): v is WelcomeFrame {
  return (
    isRecord(v) &&
    v["t"] === "welcome" &&
    nonEmptyString(v["sessionId"]) &&
    typeof v["project"] === "string" &&
    typeof v["path"] === "string"
  );
}

export function isErrorFrame(v: unknown): v is ErrorFrame {
  return isRecord(v) && v["t"] === "error" && nonEmptyString(v["code"]);
}

export function isReqFrame(v: unknown): v is ReqFrame {
  return isRecord(v) && v["t"] === "req" && nonEmptyString(v["id"]) && nonEmptyString(v["method"]);
}

export function isAckFrame(v: unknown): v is AckFrame {
  return isRecord(v) && v["t"] === "ack" && nonEmptyString(v["id"]);
}

export function isPingFrame(v: unknown): v is PingFrame {
  return isRecord(v) && v["t"] === "ping";
}

export function isPongFrame(v: unknown): v is PongFrame {
  return isRecord(v) && v["t"] === "pong";
}

/**
 * Parse one raw WS message into a known inbound frame (bridge → extension), or
 * null when it is malformed or a type we do not accept. This is the single
 * schema gate the background trusts.
 */
export function parseInboundFrame(
  raw: string,
): WelcomeFrame | ErrorFrame | ReqFrame | AckFrame | PingFrame | PongFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  // Envelope version gate (security review CCB-4): the bridge already rejects
  // wrong-version frames from us; be symmetric so a future v2 bridge frame is
  // refused here instead of silently misparsed by a v1 extension.
  if (!isRecord(parsed) || parsed["v"] !== BRIDGE_PROTOCOL_VERSION) return null;
  if (isWelcomeFrame(parsed)) return parsed;
  if (isErrorFrame(parsed)) return parsed;
  if (isReqFrame(parsed)) return parsed;
  if (isAckFrame(parsed)) return parsed;
  if (isPingFrame(parsed)) return parsed;
  if (isPongFrame(parsed)) return parsed;
  return null;
}

// ---------------------------------------------------------------------------
// Roster (surfaced to the gear menu + the composer chip)
// ---------------------------------------------------------------------------

/** One live bridge, as the extension holds it (spec §4). */
export interface BridgeSession {
  /** The routing ADDRESS a handoff targets. */
  sessionId: string;
  /** First 4 hex of sessionId — disambiguates two same-folder sessions. */
  shortId: string;
  /** The port this session's socket is on. */
  port: number;
  /** basename(cwd) — the human label (labels but never addresses). */
  project: string;
  /** The session's cwd. */
  path: string;
  /** Session start time, ISO — shown as `HH:MM` when disambiguating. */
  startedAt?: string;
  /** When the extension's socket to it opened (ms epoch). */
  connectedAt: number;
}

/** The whole bridge picture the content script mirrors from the background. */
export interface BridgeStatus {
  /** A pairing token is stored. */
  paired: boolean;
  /** The loopback host permission is granted. */
  hasPermission: boolean;
  /** Live sessions, newest connection first. */
  sessions: BridgeSession[];
}

// ---------------------------------------------------------------------------
// Runtime messages — content ↔ background
// ---------------------------------------------------------------------------

/** Metadata that rides with a handoff push (mirrors the WS push meta). */
export interface PushMeta {
  handle: HandoffHandle;
  scope: HandoffScope;
  source_id: string;
  source_title?: string;
  sent_at: string;
}

/** content → background (request/response over runtime.sendMessage). */
export type BridgeContentMessage =
  | { type: "cc:bridge:status" }
  | { type: "cc:bridge:pair"; code: string }
  | { type: "cc:bridge:forget" }
  | { type: "cc:bridge:rescan" }
  | { type: "cc:bridge:tab-focus" }
  | {
      type: "cc:bridge:push";
      sessionId: string;
      id: string;
      markdown: string;
      meta: PushMeta;
    };

/** The reverse-direction READ tools the background relays to a content script
 *  (spec §5). `push_to_composer` is the write-shaped tool and is handled
 *  separately; these six are read-only. */
export const BRIDGE_READ_METHODS: readonly string[] = [
  "list_recent_conversations",
  "get_conversation",
  "get_pins",
  "get_notes",
  "get_highlights",
  "search_conversations",
];

export function isBridgeReadMethod(method: string): boolean {
  return BRIDGE_READ_METHODS.includes(method);
}

/** background → content (roster broadcast + composer relay + read relay). */
export type BridgeBackgroundMessage =
  | { type: "cc:bridge:roster"; status: BridgeStatus }
  | { type: "cc:bridge:push-to-composer"; text: string }
  | { type: "cc:bridge:read"; method: string; params: unknown };

export type BridgePairResult = { ok: true; status: BridgeStatus } | { ok: false; reason: string };
export type BridgeAckResult = { ok: true } | { ok: false; reason: string };
export type BridgeComposerReply = { ok: boolean; drafted: boolean };
/** content → background: the answer to a `cc:bridge:read` relay. Its shape is
 *  the same `res`-frame payload the manager forwards to the bridge (spec §5). */
export type BridgeReadReply =
  | { ok: true; result: unknown }
  | { ok: false; code: string; message: string };

/** True for any message the background's bridge handler owns. */
export function isBridgeContentMessage(m: unknown): m is BridgeContentMessage {
  if (!isRecord(m)) return false;
  const t = m["type"];
  switch (t) {
    case "cc:bridge:status":
    case "cc:bridge:forget":
    case "cc:bridge:rescan":
    case "cc:bridge:tab-focus":
      return true;
    case "cc:bridge:pair":
      return typeof m["code"] === "string";
    case "cc:bridge:push":
      return (
        nonEmptyString(m["sessionId"]) &&
        nonEmptyString(m["id"]) &&
        typeof m["markdown"] === "string" &&
        isRecord(m["meta"])
      );
    default:
      return false;
  }
}

/** True for any message the content feature's bridge handler owns. */
export function isBridgeBackgroundMessage(m: unknown): m is BridgeBackgroundMessage {
  if (!isRecord(m)) return false;
  const t = m["type"];
  if (t === "cc:bridge:roster") return isRecord(m["status"]);
  if (t === "cc:bridge:push-to-composer") return typeof m["text"] === "string";
  if (t === "cc:bridge:read") return nonEmptyString(m["method"]);
  return false;
}
