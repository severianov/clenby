import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  loadOrCreateToken,
  rotateToken,
  tokenEquals,
  generateToken,
} from '../src/token.js';
import { tokenPath } from '../src/paths.js';
import { TOKEN_PREFIX } from '../src/constants.js';

const IS_POSIX = process.platform !== 'win32';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clenby-token-'));
}

test('generateToken: prefixed, ≥128-bit entropy, unique', () => {
  const a = generateToken();
  const b = generateToken();
  assert.ok(a.startsWith(TOKEN_PREFIX));
  // 32 bytes → 64 hex chars after the prefix (256 bits).
  assert.equal(a.length - TOKEN_PREFIX.length, 64);
  assert.notEqual(a, b);
});

test('loadOrCreateToken: creates file on first run, stable thereafter', () => {
  const dir = tmpDir();
  const first = loadOrCreateToken({ dir });
  assert.equal(first.created, true);
  assert.ok(first.token.startsWith(TOKEN_PREFIX));
  assert.ok(fs.existsSync(tokenPath(dir)));

  const second = loadOrCreateToken({ dir });
  assert.equal(second.created, false);
  assert.equal(second.token, first.token, 'token is stable across loads');
});

test('token file is created owner-only (0600 on POSIX)', { skip: !IS_POSIX }, () => {
  const dir = tmpDir();
  loadOrCreateToken({ dir });
  const mode = fs.statSync(tokenPath(dir)).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got 0${mode.toString(8)}`);
});

test('loadOrCreateToken self-heals loose permissions on load (POSIX)', { skip: !IS_POSIX }, () => {
  const dir = tmpDir();
  const file = tokenPath(dir);
  loadOrCreateToken({ dir });
  fs.chmodSync(file, 0o644); // simulate a loosened file
  loadOrCreateToken({ dir });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('rotateToken: replaces the token, keeps 0600', () => {
  const dir = tmpDir();
  const before = loadOrCreateToken({ dir }).token;
  const rotated = rotateToken({ dir });
  assert.notEqual(rotated.token, before, 'rotation changes the token');
  assert.equal(loadOrCreateToken({ dir }).token, rotated.token, 'new token persists');
  if (IS_POSIX) {
    assert.equal(fs.statSync(tokenPath(dir)).mode & 0o777, 0o600);
  }
});

test('tokenEquals: constant-time compare, length + type safe', () => {
  const t = generateToken();
  assert.equal(tokenEquals(t, t), true);
  assert.equal(tokenEquals(t, t + 'x'), false);
  assert.equal(tokenEquals(t, 'clenby_short'), false);
  assert.equal(tokenEquals(t, undefined), false);
  assert.equal(tokenEquals(null, null), false);
});
