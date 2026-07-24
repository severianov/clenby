#!/usr/bin/env node
/**
 * clenby-bridge — bin entry (spec §5).
 *
 * Claude Code spawns this as a stdio MCP server. It is NOT a daemon: it lives
 * and dies with the session. On start it loads (or creates) the per-machine
 * pairing token, binds a loopback-only WebSocket on the first free port in the
 * range, prints the port + pairing code, and serves MCP over stdio.
 *
 * `clenby-bridge code` (or `--code`) prints the pairing code and exits,
 * creating the token first if none exists yet.
 * `clenby-bridge audit` (or `--audit`) prints every runtime file with its
 * SHA-256 so anyone can verify exactly what is running on their machine.
 * `clenby-bridge --rotate-token` regenerates the token file and exits.
 *
 * NOTE on output: MCP stdio uses STDOUT for JSON-RPC, so the human-readable
 * pairing banner is written to STDERR (Claude Code surfaces server stderr).
 * The spec says "stdout"; writing the banner there would corrupt the protocol
 * stream — see the deviation note in the README/report.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { PORT_RANGE, LOOPBACK_HOST } from './src/constants.js';
import { loadOrCreateToken, rotateToken } from './src/token.js';
import { tokenPath } from './src/paths.js';
import { createSession } from './src/session.js';
import { HandoffStore } from './src/handoffs.js';
import { WsBridge } from './src/ws-server.js';
import { createMcpServer } from './src/mcp-server.js';
import { log, warn } from './src/log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @returns {string} package version */
function pkgVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** `code` / `--code`: print the pairing code (creating the token if needed), exit. */
function runShowCode() {
  const { token, created, path: file } = loadOrCreateToken();
  // CLI mode (no MCP running) — stdout is free; the user ran this directly.
  process.stdout.write(`Clenby pairing code:\n  ${token}\n`);
  if (created) {
    process.stdout.write('(no token existed yet — created one)\n');
  }
  process.stdout.write(
    `Stored at ${file}. Paste it in claude.ai: Clenby gear menu → Claude Code → Pair.\n`,
  );
}

/** `audit` / `--audit`: print the install location and the SHA-256 of every
 *  runtime file, so a user can verify the code on their disk against the
 *  published source before pairing. Trust must be checkable, not asked for. */
function runAudit() {
  const files = ['index.js', ...fs.readdirSync(path.join(__dirname, 'src'))
    .filter((f) => f.endsWith('.js'))
    .sort()
    .map((f) => path.join('src', f))];
  process.stdout.write(`clenby-bridge v${pkgVersion()} — runtime files at ${__dirname}\n\n`);
  for (const rel of files) {
    const buf = fs.readFileSync(path.join(__dirname, rel));
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    process.stdout.write(`  ${hash}  ${rel}\n`);
  }
  process.stdout.write(
    '\nCompare against the tagged release in the Clenby repository, or just read the files —\n' +
      'the whole bridge is a few hundred lines. It binds 127.0.0.1 only, runs no shell\n' +
      'commands, and writes nothing to disk except its own token file.\n',
  );
}

/** `remove-token` / `--remove-token`: delete the pairing token — the one
 *  thing the bridge ever writes to disk. After this (plus Forget in the
 *  extension and `claude mcp remove clenby`), no trace of the bridge remains. */
function runRemoveToken() {
  const file = tokenPath();
  try {
    fs.unlinkSync(file);
    process.stdout.write(`Pairing token deleted (${file}).\n`);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      process.stdout.write(`No token to delete (${file} does not exist).\n`);
    } else {
      throw err;
    }
  }
  process.stdout.write(
    'Running bridges keep their in-memory copy until their sessions end. ' +
      'To remove everything: Forget in the extension gear menu, then `claude mcp remove clenby`.\n',
  );
}

/** `--rotate-token`: regenerate the file, print the new code to stdout, exit. */
function runRotate() {
  const { token, path: file } = rotateToken();
  // CLI mode (no MCP running) — stdout is free; the user ran this directly.
  process.stdout.write(`Clenby pairing code rotated (${file}):\n  ${token}\n`);
  process.stdout.write('Re-pair once in the extension. Running bridges keep the old token until restarted.\n');
}

async function runServer() {
  const version = pkgVersion();
  const { token, created } = loadOrCreateToken();

  const session = createSession();
  const store = new HandoffStore();

  const bridge = new WsBridge({ session, store, token, bridgeVersion: version });
  const { server, notifyHandoff } = createMcpServer({ session, store, bridge, version });
  bridge.onHandoff = notifyHandoff; // close the loop: push → store → notify → ack

  // Bind the loopback listener. If every port is taken (>10 bridges, spec §4),
  // run MCP-only: local tools still answer; proxy tools report "not connected".
  let port = null;
  try {
    port = await bridge.start(PORT_RANGE);
  } catch (err) {
    warn(
      `no free bridge port (${err.message}) — all ${PORT_RANGE.length} are in use, ` +
        'likely by other Claude Code sessions. This session still answers local tools ' +
        '(whoami, handoffs already received) but has no live link to the extension; ' +
        'end another session to free a port, then restart this one.',
    );
  }

  // Pairing banner — STDERR (see file header). The token is printed here
  // deliberately; it is never sent through the logger or any network path.
  if (port !== null) {
    process.stderr.write(
      `Clenby bridge on ${LOOPBACK_HOST}:${port} — pairing code: ${token}\n`,
    );
    if (created) {
      process.stderr.write('First run: created the per-machine token. Paste the code into the Clenby extension to pair (once).\n');
    }
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`MCP server ready (session ${session.shortId} · ${session.project})`);

  const shutdown = async () => {
    try {
      await bridge.close();
      await server.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--rotate-token')) {
    runRotate();
    return;
  }
  if (argv.includes('code') || argv.includes('--code')) {
    runShowCode();
    return;
  }
  if (argv.includes('audit') || argv.includes('--audit')) {
    runAudit();
    return;
  }
  if (argv.includes('remove-token') || argv.includes('--remove-token')) {
    runRemoveToken();
    return;
  }
  await runServer();
}

main().catch((err) => {
  warn('fatal', err && err.stack ? err.stack : String(err));
  process.exit(1);
});
