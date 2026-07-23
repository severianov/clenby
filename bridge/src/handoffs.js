/**
 * In-session handoff store (spec §3, §5).
 *
 * A handoff exists only as a transient WS `push` frame and, here, an in-session
 * resource that dies with the process. There is no outbox, no store at rest —
 * this is a bounded in-memory ring, newest kept (spec §6: no content at rest).
 */

import { MAX_HANDOFFS } from './constants.js';

/**
 * @typedef {object} HandoffRecord
 * @property {string} id
 * @property {string} handle       continue | review | context
 * @property {string} scope        conversation | answer | selection
 * @property {string|null} source_title
 * @property {string|null} source_id
 * @property {string|null} sent_at
 * @property {string} markdown     Full §2 payload.
 * @property {string} receivedAt   ISO-8601 UTC, bridge receive time.
 */

/**
 * Minimal, dependency-free frontmatter reader. Extracts a single scalar field
 * from the leading `--- … ---` block. Not a general YAML parser — just enough
 * to recover `source_title` (and friends) when the push `meta` omits them.
 * @param {string} markdown
 * @param {string} field
 * @returns {string|null}
 */
export function readFrontmatterField(markdown, field) {
  if (typeof markdown !== 'string' || !markdown.startsWith('---')) return null;
  const end = markdown.indexOf('\n---', 3);
  if (end === -1) return null; // unterminated block — never scan the body
  const block = markdown.slice(3, end);
  for (const raw of block.split('\n')) {
    const idx = raw.indexOf(':');
    if (idx === -1) continue;
    if (raw.slice(0, idx).trim() !== field) continue;
    let val = raw.slice(idx + 1).trim();
    // The extension JSON-quotes every string it writes; decode the same way,
    // so `#`, quotes, and escapes inside values survive intact. The old
    // strip-#-comments-first approach truncated titles like `Fix #42`.
    if (val.startsWith('"')) {
      const m = /^("(?:[^"\\]|\\.)*")/.exec(val);
      if (!m) return null;
      try {
        const parsed = JSON.parse(m[1]);
        return typeof parsed === 'string' ? parsed || null : String(parsed);
      } catch {
        return null;
      }
    }
    // Unquoted scalar (hand-written files): comments only start a comment
    // when preceded by whitespace, per YAML.
    val = val.replace(/(^|\s)#.*$/, '$1').trim();
    if (val.startsWith("'") && val.endsWith("'") && val.length >= 2) {
      val = val.slice(1, -1);
    }
    return val || null;
  }
  return null;
}

/** Bounded in-memory handoff store, newest-first read order. */
export class HandoffStore {
  /** @param {number} [max] */
  constructor(max = MAX_HANDOFFS) {
    this._max = max;
    /** @type {HandoffRecord[]} newest last */
    this._items = [];
  }

  /**
   * Ingest a `push` frame's payload. Fills missing meta from the frontmatter.
   * @param {object} push { id, meta?, markdown }
   * @returns {HandoffRecord}
   */
  add(push) {
    const meta = push.meta || {};
    const markdown = typeof push.markdown === 'string' ? push.markdown : '';
    /** @type {HandoffRecord} */
    const rec = {
      id: String(push.id),
      handle: meta.handle ?? readFrontmatterField(markdown, 'handle') ?? 'context',
      scope: meta.scope ?? readFrontmatterField(markdown, 'scope') ?? 'conversation',
      source_title:
        meta.source_title ?? readFrontmatterField(markdown, 'source_title'),
      source_id: meta.source_id ?? readFrontmatterField(markdown, 'source_id'),
      sent_at: meta.sent_at ?? readFrontmatterField(markdown, 'sent_at'),
      markdown,
      receivedAt: new Date().toISOString(),
    };
    this._items.push(rec);
    if (this._items.length > this._max) this._items.shift();
    return rec;
  }

  /** @returns {HandoffRecord|null} */
  latest() {
    return this._items.length ? this._items[this._items.length - 1] : null;
  }

  /** @param {string} id @returns {HandoffRecord|null} */
  byId(id) {
    for (let i = this._items.length - 1; i >= 0; i--) {
      if (this._items[i].id === id) return this._items[i];
    }
    return null;
  }

  /** @param {number} [limit] @returns {HandoffRecord[]} newest-first */
  list(limit = 10) {
    return this._items.slice().reverse().slice(0, limit);
  }

  /** @returns {HandoffRecord[]} all, newest-first */
  all() {
    return this._items.slice().reverse();
  }
}
