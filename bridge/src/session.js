/**
 * Session identity (spec §4).
 *
 * Each bridge generates a `sessionId` (UUID) at spawn — the address a handoff
 * routes to — and inherits the session's cwd, whose basename is the human
 * label. `shortId` (first 4 hex of the UUID) disambiguates two same-folder
 * sessions. Surfaced in the WS `welcome` frame and the `whoami` tool.
 */

import path from 'node:path';
import crypto from 'node:crypto';

import { ENVELOPE_VERSION } from './constants.js';

/**
 * @typedef {object} Session
 * @property {string} sessionId Routing address (UUID).
 * @property {string} shortId   First 4 hex of the UUID (human disambiguator).
 * @property {string} project   basename(cwd) — labels, never addresses.
 * @property {string} path      cwd.
 * @property {number} pid       Process id.
 * @property {string} startedAt ISO-8601 UTC spawn time.
 */

/**
 * Build this process's session identity.
 * @param {object} [opts]
 * @param {string} [opts.cwd] Override cwd (tests).
 * @returns {Session}
 */
export function createSession({ cwd = process.cwd() } = {}) {
  const sessionId = crypto.randomUUID();
  return {
    sessionId,
    shortId: sessionId.slice(0, 4),
    project: path.basename(cwd) || cwd,
    path: cwd,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
}

/**
 * The `welcome` self-description sent to the extension (spec §5).
 * @param {Session} session
 * @param {string} bridgeVersion
 */
export function welcomeFrame(session, bridgeVersion) {
  return {
    v: ENVELOPE_VERSION,
    t: 'welcome',
    sessionId: session.sessionId,
    bridge_version: bridgeVersion,
    project: session.project,
    path: session.path,
    pid: session.pid,
    startedAt: session.startedAt,
  };
}

/**
 * The `whoami` tool payload (spec §4/§5).
 * @param {Session} session
 */
export function whoami(session) {
  return {
    sessionId: session.sessionId,
    shortId: session.shortId,
    project: session.project,
    path: session.path,
    pid: session.pid,
    startedAt: session.startedAt,
  };
}
