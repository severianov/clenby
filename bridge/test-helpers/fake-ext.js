/**
 * Test helper: a fake Clenby extension WS client. Not a test file.
 */
import { WebSocket } from 'ws';

const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

/**
 * Open a raw WS to the bridge with a chosen origin. Resolves on 'open'.
 * @param {number} port
 * @param {string} [origin]
 * @returns {Promise<WebSocket>}
 */
export function openSocket(port, origin = EXT_ORIGIN) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin });
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

/** Await the next JSON frame from a socket. */
export function nextFrame(ws) {
  return new Promise((resolve, reject) => {
    ws.once('message', (d) => {
      try {
        resolve(JSON.parse(d.toString()));
      } catch (e) {
        reject(e);
      }
    });
    ws.once('close', (code) => reject(new Error(`closed ${code}`)));
  });
}

/** Await a socket close, resolving with the close code. */
export function awaitClose(ws) {
  return new Promise((resolve) => ws.once('close', (code) => resolve(code)));
}

/**
 * Complete the handshake: connect, send hello, await welcome.
 * @returns {Promise<{ ws: WebSocket, welcome: any }>}
 */
export async function handshake(port, token, origin = EXT_ORIGIN) {
  const ws = await openSocket(port, origin);
  ws.send(JSON.stringify({ v: 1, t: 'hello', token, client: 'clenby-ext', ext_version: 'test' }));
  const welcome = await nextFrame(ws);
  return { ws, welcome };
}

export { EXT_ORIGIN };
