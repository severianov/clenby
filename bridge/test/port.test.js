import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { bindFirstFreePort } from '../src/ws-server.js';
import { LOOPBACK_HOST } from '../src/constants.js';

/** Occupy a loopback port with a plain TCP server; resolve with its number. */
function occupy() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, LOOPBACK_HOST, () => resolve({ srv, port: srv.address().port }));
  });
}

/** Grab a currently-free loopback port number (then release it). */
function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, LOOPBACK_HOST, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

test('binds the first free port in the list', async () => {
  const p = await freePort();
  const { wss, port } = await bindFirstFreePort([p], {});
  assert.equal(port, p);
  await new Promise((r) => wss.close(r));
});

test('skips an occupied port and falls back to the next', async () => {
  const { srv, port: taken } = await occupy();
  const spare = await freePort();
  const { wss, port } = await bindFirstFreePort([taken, spare], {});
  assert.equal(port, spare, 'fell back past the occupied port');
  await new Promise((r) => wss.close(r));
  await new Promise((r) => srv.close(r));
});

test('rejects when every port in the range is occupied', async () => {
  const a = await occupy();
  const b = await occupy();
  await assert.rejects(() => bindFirstFreePort([a.port, b.port], {}), /no free port/);
  await new Promise((r) => a.srv.close(r));
  await new Promise((r) => b.srv.close(r));
});

test('binds loopback only (address is 127.0.0.1)', async () => {
  const p = await freePort();
  const { wss, port } = await bindFirstFreePort([p], {});
  assert.equal(wss.address().address, LOOPBACK_HOST);
  assert.equal(port, p);
  await new Promise((r) => wss.close(r));
});
