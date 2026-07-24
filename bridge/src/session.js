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
 * @property {string} shortId   First 4 hex of the UUID (technical disambiguator).
 * @property {string} petname   Human handle derived from the UUID (`calm-falcon`).
 * @property {string} project   basename(cwd) — labels, never addresses.
 * @property {string} path      cwd.
 * @property {number} pid       Process id.
 * @property {string} startedAt ISO-8601 UTC spawn time.
 */

// Petname wordlists — the ONLY place these live. The extension never computes
// names; it displays what the welcome frame carries, so the lists can't drift
// across the wire seam. 32×32 = 1024 combinations; collisions between two
// concurrently-running sessions are rare and shortId still disambiguates.
const PET_ADJECTIVES = [
  'amber', 'bold', 'brave', 'bright', 'calm', 'clever', 'cosmic', 'crisp',
  'daring', 'deep', 'eager', 'fleet', 'gentle', 'golden', 'happy', 'keen',
  'lively', 'lucky', 'mellow', 'noble', 'quick', 'quiet', 'rapid', 'ready',
  'silent', 'solid', 'sturdy', 'sunny', 'swift', 'tidy', 'vivid', 'warm',
];
const PET_NOUNS = [
  'aspen', 'badger', 'bison', 'cedar', 'comet', 'coral', 'crane', 'delta',
  'ember', 'falcon', 'fjord', 'gecko', 'harbor', 'heron', 'juniper', 'koala',
  'lagoon', 'lynx', 'maple', 'meadow', 'nebula', 'otter', 'panda', 'pine',
  'raven', 'reef', 'ridge', 'river', 'sparrow', 'summit', 'tundra', 'willow',
];

/**
 * Deterministic human handle for a session id (FNV-1a over the UUID).
 * Same id ⇒ same name, so every surface agrees without coordination.
 * @param {string} sessionId
 * @returns {string}
 */
export function petnameOf(sessionId) {
  let h = 2166136261;
  for (let i = 0; i < sessionId.length; i++) {
    h ^= sessionId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h >>>= 0;
  const adj = PET_ADJECTIVES[h % PET_ADJECTIVES.length];
  const noun = PET_NOUNS[Math.floor(h / PET_ADJECTIVES.length) % PET_NOUNS.length];
  return `${adj}-${noun}`;
}

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
    petname: petnameOf(sessionId),
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
    petname: session.petname,
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
    petname: session.petname,
    project: session.project,
    path: session.path,
    pid: session.pid,
    startedAt: session.startedAt,
  };
}
