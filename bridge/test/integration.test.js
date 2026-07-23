import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

import { WsBridge } from '../src/ws-server.js';
import { HandoffStore } from '../src/handoffs.js';
import { createSession } from '../src/session.js';
import { createMcpServer } from '../src/mcp-server.js';
import { generateToken } from '../src/token.js';
import { handshake } from '../test-helpers/fake-ext.js';

/**
 * Full stack: MCP Client ↔ (InMemory) ↔ MCP Server ↔ WsBridge ↔ fake extension.
 * A real MCP client drives tools; a fake extension answers proxied calls and
 * pushes a handoff. Exercises: welcome, local tool, proxied tool, push →
 * resource + notification, resource read.
 */
async function setup() {
  const token = generateToken();
  const session = createSession();
  const store = new HandoffStore();
  const bridge = new WsBridge({ session, store, token, bridgeVersion: 'itest' });
  const { server, notifyHandoff } = createMcpServer({ session, store, bridge, version: 'itest' });
  bridge.onHandoff = notifyHandoff;
  const port = await bridge.start([0]);

  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'test-client', version: '1' });
  await client.connect(clientT);

  return { bridge, server, client, session, store, port, token };
}

test('e2e: handshake, local tool, proxied tool, and handoff push', async (t) => {
  const { bridge, server, client, session, port, token } = await setup();
  const { ws, welcome } = await handshake(port, token);
  t.after(async () => {
    ws.close();
    await client.close();
    await server.close();
    await bridge.close();
  });

  // Welcome self-description matches this session (spec §4/§5).
  assert.equal(welcome.sessionId, session.sessionId);
  assert.equal(welcome.project, session.project);

  // The full tool surface is advertised.
  const { tools } = await client.listTools();
  const names = tools.map((x) => x.name).sort();
  assert.deepEqual(names, [
    'get_conversation', 'get_highlights', 'get_latest_handoff', 'get_notes',
    'get_pins', 'list_handoffs', 'list_recent_conversations', 'push_to_composer',
    'search_conversations', 'whoami',
  ]);

  // Local tool: whoami answered without touching the extension.
  const who = await client.callTool({ name: 'whoami', arguments: {} });
  assert.equal(who.structuredContent.shortId, session.shortId);
  assert.equal(who.structuredContent.sessionId, session.sessionId);

  // Proxied tool: bridge → fake extension → back.
  ws.on('message', (d) => {
    const f = JSON.parse(d.toString());
    if (f.t !== 'req') return;
    if (f.method === 'get_conversation') {
      ws.send(JSON.stringify({ v: 1, t: 'res', id: f.id, ok: true, result: { id: f.params.id, title: 'Ingest queue', url: 'https://claude.ai/chat/x', markdown: '# hi' } }));
    } else if (f.method === 'push_to_composer') {
      ws.send(JSON.stringify({ v: 1, t: 'res', id: f.id, ok: true, result: { ok: true, drafted: true } }));
    }
  });

  const conv = await client.callTool({ name: 'get_conversation', arguments: { id: 'current' } });
  assert.equal(conv.isError, undefined);
  assert.equal(conv.structuredContent.title, 'Ingest queue');

  const draft = await client.callTool({ name: 'push_to_composer', arguments: { text: 'draft me' } });
  assert.deepEqual(draft.structuredContent, { ok: true, drafted: true });

  // Empty handoff store first.
  const empty = await client.callTool({ name: 'get_latest_handoff', arguments: {} });
  assert.deepEqual(empty.structuredContent, { handoff: null });

  // Subscribe, then push a handoff and expect a resources/updated notification.
  const updated = new Promise((resolve) => {
    // capture the first resources/updated notification
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => resolve(n.params.uri));
  }).catch(() => null);
  await client.subscribeResource({ uri: 'clenby://handoff/latest' });

  const ackP = new Promise((resolve) => {
    ws.on('message', (d) => {
      const f = JSON.parse(d.toString());
      if (f.t === 'ack') resolve(f.id);
    });
  });
  ws.send(JSON.stringify({
    v: 1, t: 'push', topic: 'handoff', id: 'H-1',
    meta: { handle: 'continue', scope: 'conversation', source_id: 's1', sent_at: '2026-07-24T00:00:00Z' },
    markdown: '---\nschema: clenby.handoff/1\nhandle: continue\nsource_title: Rate limiter\n---\n\nbody text',
  }));

  assert.equal(await ackP, 'H-1', 'push was acked');
  assert.equal(await updated, 'clenby://handoff/latest', 'resources/updated fired for latest');

  // get_latest_handoff now returns the payload, answered locally.
  const latest = await client.callTool({ name: 'get_latest_handoff', arguments: {} });
  assert.equal(latest.structuredContent.handle, 'continue');
  assert.equal(latest.structuredContent.source_title, 'Rate limiter');
  assert.match(latest.structuredContent.markdown, /body text/);

  // list_handoffs shows it with this session's target.
  const listed = await client.callTool({ name: 'list_handoffs', arguments: {} });
  assert.equal(listed.structuredContent.handoffs.length, 1);
  assert.deepEqual(listed.structuredContent.handoffs[0].target, {
    project: session.project, path: session.path,
  });

  // The handoff is readable as an MCP resource.
  const res = await client.readResource({ uri: 'clenby://handoff/latest' });
  assert.match(res.contents[0].text, /Rate limiter/);
  const byId = await client.readResource({ uri: 'clenby://handoff/H-1' });
  assert.match(byId.contents[0].text, /body text/);

  const list = await client.listResources();
  assert.ok(list.resources.some((r) => r.uri === 'clenby://handoff/latest'));
});

test('e2e: proxied tool returns friendly error when no extension is connected', async (t) => {
  const { bridge, server, client } = await setup();
  t.after(async () => {
    await client.close();
    await server.close();
    await bridge.close();
  });
  // No extension connected: proxied read tool reports it, non-fatally.
  const r = await client.callTool({ name: 'list_recent_conversations', arguments: {} });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /not connected/i);
});

test('the handoff prompt ships in the package and honors its argument', async (t) => {
  const { bridge, server, client } = await setup();
  t.after(async () => {
    await client.close();
    await server.close();
    await bridge.close();
  });

  // Advertised: this is what Claude Code turns into /mcp__clenby__handoff.
  const { prompts } = await client.listPrompts();
  assert.deepEqual(prompts.map((p) => p.name), ['handoff']);

  // Default: falls back to the handle sent with the handoff.
  const plain = await client.getPrompt({ name: 'handoff', arguments: {} });
  const plainText = plain.messages[0].content.text;
  assert.match(plainText, /get_latest_handoff/);
  assert.match(plainText, /handle/);
  assert.match(plainText, /fence/i);

  // With instructions: the user's text overrides the sent intent.
  const custom = await client.getPrompt({
    name: 'handoff',
    arguments: { instructions: 'summarize it in three bullets' },
  });
  assert.match(custom.messages[0].content.text, /summarize it in three bullets/);
  assert.doesNotMatch(custom.messages[0].content.text, /follow the handoff's own/);
});
