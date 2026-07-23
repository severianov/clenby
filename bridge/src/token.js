/**
 * Per-machine pairing token: create, load, rotate, compare.
 *
 * One token authenticates the WS channel between the extension and every
 * bridge on the machine (spec §4, §6). It is the only secret persisted at
 * rest. The file is created owner-only (`0600` on POSIX; owner-scoped by
 * location on Windows, where chmod is a no-op — Reviewer note 4).
 *
 * Security invariants honored here (spec §6):
 *   - the token is never logged (callers print the pairing banner deliberately;
 *     this module never console-writes the value);
 *   - the ONLY filesystem write the bridge performs is this token file;
 *   - comparison is constant-time.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { TOKEN_PREFIX } from './constants.js';
import { tokenPath as defaultTokenPath, configDir } from './paths.js';

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const IS_POSIX = process.platform !== 'win32';

/**
 * Generate a fresh pairing code: prefix + 256 bits of CSPRNG hex (≥128-bit
 * requirement of spec §6, comfortably exceeded).
 * @returns {string}
 */
export function generateToken() {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('hex');
}

/**
 * Ensure the config directory exists with owner-only intent, then enforce
 * `0600` on the token file (POSIX only; no-op on Windows).
 * @param {string} file
 */
function enforceOwnerOnly(file) {
  if (!IS_POSIX) return; // Windows: owner-scoped by %APPDATA% location; chmod is a no-op.
  try {
    fs.chmodSync(file, FILE_MODE);
  } catch {
    /* best-effort; a chmod failure must not crash the bridge */
  }
}

/**
 * Write a token to disk ATOMICALLY (security review CCB-5): write a uniquely
 * named temp file in the same directory, fix its perms, then `rename` it over
 * the final path. rename is atomic on POSIX and Windows, so a concurrent
 * reader (e.g. during `--rotate-token`) never observes a truncated/empty
 * file, and two simultaneous first-run writers each land a whole token —
 * last rename wins cleanly instead of interleaving bytes.
 * @param {string} token
 * @param {string} file
 */
function writeToken(token, file) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  const tmp = path.join(dir, `.token.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    // `mode` on writeFileSync is masked by umask, so chmod after to be exact.
    fs.writeFileSync(tmp, token + '\n', { mode: FILE_MODE, flag: 'wx' });
    enforceOwnerOnly(tmp);
    fs.renameSync(tmp, file); // atomic replace
    enforceOwnerOnly(file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* temp already gone / never created — nothing to clean */
    }
    throw err;
  }
}

/**
 * Load the token from disk, or create it on first run.
 * @param {object} [opts]
 * @param {string} [opts.dir] Config directory (defaults to per-OS location).
 * @returns {{ token: string, created: boolean, path: string }}
 */
export function loadOrCreateToken({ dir = configDir() } = {}) {
  const file = defaultTokenPath(dir);
  if (fs.existsSync(file)) {
    const token = fs.readFileSync(file, 'utf8').trim();
    if (token) {
      enforceOwnerOnly(file); // self-heal perms on every load.
      return { token, created: false, path: file };
    }
  }
  const token = generateToken();
  writeToken(token, file);
  return { token, created: true, path: file };
}

/**
 * Regenerate the token file (spec §5 `--rotate-token`). Running bridges keep
 * the old token until restarted; the user re-pairs once.
 * @param {object} [opts]
 * @param {string} [opts.dir]
 * @returns {{ token: string, path: string }}
 */
export function rotateToken({ dir = configDir() } = {}) {
  const file = defaultTokenPath(dir);
  const token = generateToken();
  writeToken(token, file);
  return { token, path: file };
}

/**
 * Constant-time token comparison. Length mismatch ⇒ false without leaking
 * timing beyond the mismatch itself.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function tokenEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
