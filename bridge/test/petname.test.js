/**
 * Petnames: the human session handle. Deterministic from sessionId (same id,
 * same name, every surface agrees) and carried in welcome + whoami.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSession, petnameOf, welcomeFrame, whoami } from '../src/session.js';

test('petnameOf is deterministic and adjective-noun shaped', () => {
  const id = 'c40f6cb8-754c-43c1-8f7c-7f1569fb3ba3';
  const a = petnameOf(id);
  assert.equal(a, petnameOf(id));
  assert.match(a, /^[a-z]+-[a-z]+$/);
  assert.notEqual(petnameOf('00000000-0000-0000-0000-000000000000'), petnameOf(id));
});

test('welcome and whoami carry the session petname', () => {
  const session = createSession({ cwd: '/tmp/demo' });
  assert.equal(session.petname, petnameOf(session.sessionId));
  assert.equal(welcomeFrame(session, 'x').petname, session.petname);
  assert.equal(whoami(session).petname, session.petname);
});
