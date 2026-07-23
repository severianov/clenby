/**
 * Shared constants for clenby-bridge.
 *
 * The values here encode invariants from the design spec
 * (internal/design/claude-code-bridge-spec.md). Changing them changes the
 * wire contract with the Clenby extension.
 */

/** WS envelope version. Bump on a breaking envelope change. */
export const ENVELOPE_VERSION = 1;

/** Handoff schema id carried in the markdown frontmatter (spec §2). */
export const HANDOFF_SCHEMA = 'clenby.handoff/1';

/** Loopback host — the socket binds here and nowhere else (spec §5, §6). */
export const LOOPBACK_HOST = '127.0.0.1';

/**
 * Port range the bridge binds within, inclusive. 10 ports ⇒ at most 10
 * concurrent bridges on a machine (spec §4 concurrency cap).
 */
export const PORT_RANGE_START = 47850;
export const PORT_RANGE_END = 47859;

/** All candidate ports, in bind-preference order. */
export const PORT_RANGE = Array.from(
  { length: PORT_RANGE_END - PORT_RANGE_START + 1 },
  (_, i) => PORT_RANGE_START + i,
);

/**
 * Hard cap on an inbound WS frame. Handoffs are whole conversations but still
 * bounded; anything larger is rejected by the transport (ws `maxPayload`,
 * close code 1009). Security invariant: cap message sizes (spec §6).
 */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024; // 8 MiB

/** How many handoffs to retain in the in-session store, newest kept. */
export const MAX_HANDOFFS = 50;

/** Default timeout for a tool proxied to the extension over the WS. */
export const PROXY_TIMEOUT_MS = 20_000;

/** Milliseconds a client has to send its `hello` before we drop it. */
export const HELLO_TIMEOUT_MS = 5_000;

/** Origin schemes the WS handshake accepts — browser-extension pages only. */
export const ALLOWED_ORIGIN_SCHEMES = ['chrome-extension://', 'moz-extension://'];

/** Token prefix, so a leaked value is recognizable as a Clenby pairing code. */
export const TOKEN_PREFIX = 'clenby_';

/** Resource URIs (spec §5). */
export const RESOURCE_LATEST = 'clenby://handoff/latest';
export const resourceForId = (id) => `clenby://handoff/${id}`;

/** Friendly error surfaced to the model when no extension is connected. */
export const ERR_NOT_CONNECTED = 'Clenby extension not connected';
