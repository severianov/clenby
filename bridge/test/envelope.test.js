import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

import { WsBridge, isAllowedOrigin } from '../src/ws-server.js';
import { HandoffStore } from '../src/handoffs.js';
import { createSession } from '../src/session.js';
import { generateToken } from '../src/token.js';
import { openSocket, nextFrame, awaitClose, handshake, EXT_ORIGIN } from '../test-helpers/fake-ext.js';

/** Spin up a bridge on an OS-assigned loopback port. */
async function startBridge(overrides = {}) {
  const token = generateToken();
  const bridge = new WsBridge({
    session: createSession(),
    store: new HandoffStore(),
    token,
    bridgeVersion: 'test',
    ...overrides,
  });
  const port = await bridge.start([0]);
  return { bridge, port, token };
}

test('isAllowedOrigin: extension origins pass, web origins fail', () => {
  assert.equal(isAllowedOrigin('chrome-extension://abc'), true);
  assert.equal(isAllowedOrigin('moz-extension://abc'), true);
  assert.equal(isAllowedOrigin('https://claude.ai'), false);
  assert.equal(isAllowedOrigin('http://127.0.0.1'), false);
  assert.equal(isAllowedOrigin(undefined), false);
  assert.equal(isAllowedOrigin(''), false);
});

test('valid handshake gets a welcome self-description', async () => {
  const { bridge, port, token } = await startBridge();
  const { ws, welcome } = await handshake(port, token);
  assert.equal(welcome.t, 'welcome');
  assert.equal(welcome.v, 1);
  assert.equal(typeof welcome.sessionId, 'string');
  assert.equal(typeof welcome.project, 'string');
  assert.equal(welcome.bridge_version, 'test');
  ws.close();
  await bridge.close();
});

test('bad token is rejected with an unauthorized error, then closed', async () => {
  const { bridge, port } = await startBridge();
  const ws = await openSocket(port);
  ws.send(JSON.stringify({ v: 1, t: 'hello', token: 'clenby_wrong', client: 'x' }));
  const frame = await nextFrame(ws);
  assert.equal(frame.t, 'error');
  assert.equal(frame.code, 'unauthorized');
  const code = await awaitClose(ws);
  assert.ok(code >= 1000, 'socket closed after unauthorized');
  await bridge.close();
});

test('non-extension Origin is refused at the handshake (no upgrade)', async () => {
  const { bridge, port } = await startBridge();
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'https://evil.example' });
  const err = await new Promise((resolve) => {
    ws.once('open', () => resolve(null));
    ws.once('error', (e) => resolve(e));
  });
  assert.ok(err, 'connection from a web origin must be rejected');
  await bridge.close();
});

test('first frame must be hello (a stray frame is closed)', async () => {
  const { bridge, port, token } = await startBridge();
  const ws = await openSocket(port);
  ws.send(JSON.stringify({ v: 1, t: 'req', id: 'x', method: 'whoami' }));
  const frame = await nextFrame(ws);
  assert.equal(frame.t, 'error');
  assert.equal(frame.code, 'unauthorized');
  await bridge.close();
  void token;
});

test('oversized frame is rejected by the size cap (close 1009)', async () => {
  // Small cap so the test stays fast; validates the mechanism, not the 8 MiB value.
  const { bridge, port } = await startBridge({ maxFrameBytes: 512 });
  const ws = await openSocket(port);
  const closed = awaitClose(ws);
  ws.send(JSON.stringify({ v: 1, t: 'hello', token: 'x'.repeat(2000) }));
  const code = await closed;
  assert.equal(code, 1009, 'oversized frame closes with 1009');
  await bridge.close();
});

test('malformed envelope (bad version) is closed', async () => {
  const { bridge, port } = await startBridge();
  const ws = await openSocket(port);
  const closed = awaitClose(ws);
  ws.send(JSON.stringify({ v: 99, t: 'hello', token: 'whatever' }));
  const code = await closed;
  assert.ok(code >= 1000);
  await bridge.close();
});

test('request rejects with friendly error when no extension is connected', async () => {
  const { bridge } = await startBridge();
  await assert.rejects(() => bridge.request('get_conversation', { id: 'current' }), /not connected/i);
  await bridge.close();
});

test('a proxied request round-trips to the fake extension and back', async () => {
  const { bridge, port, token } = await startBridge();
  const { ws } = await handshake(port, token);

  ws.on('message', (d) => {
    const f = JSON.parse(d.toString());
    if (f.t === 'req' && f.method === 'get_conversation') {
      ws.send(JSON.stringify({ v: 1, t: 'res', id: f.id, ok: true, result: { id: f.params.id, title: 'T' } }));
    }
  });

  const result = await bridge.request('get_conversation', { id: 'current' });
  assert.deepEqual(result, { id: 'current', title: 'T' });
  ws.close();
  await bridge.close();
});

test('a push is stored, notified, and acked in order', async () => {
  const seen = [];
  const { bridge, port, token } = await startBridge({
    onHandoff: (rec) => {
      seen.push(rec.id);
    },
  });
  const { ws } = await handshake(port, token);

  const ackP = new Promise((resolve) => {
    ws.on('message', (d) => {
      const f = JSON.parse(d.toString());
      if (f.t === 'ack') resolve(f);
    });
  });

  ws.send(JSON.stringify({
    v: 1,
    t: 'push',
    topic: 'handoff',
    id: 'h1',
    meta: { handle: 'continue', scope: 'conversation', source_id: 's', sent_at: 'now' },
    markdown: '---\nschema: clenby.handoff/1\nsource_title: Hello\n---\nbody',
  }));

  const ack = await ackP;
  assert.equal(ack.id, 'h1');
  assert.deepEqual(seen, ['h1'], 'onHandoff fired before ack');
  assert.equal(bridge.store.latest().source_title, 'Hello');
  ws.close();
  await bridge.close();
});

test('ping is answered with pong — the heartbeat contract is two-sided', async () => {
  const { bridge, port, token } = await startBridge();
  const { ws } = await handshake(port, token);
  const pongP = new Promise((resolve) => {
    ws.on('message', (d) => {
      const f = JSON.parse(d.toString());
      if (f.t === 'pong') resolve(f);
    });
  });
  ws.send(JSON.stringify({ v: 1, t: 'ping' }));
  const pong = await pongP;
  assert.equal(pong.v, 1);
  ws.close();
  await bridge.close();
});
