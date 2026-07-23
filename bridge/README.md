# clenby-bridge

A loopback MCP bridge between a **claude.ai** conversation (via the [Clenby](https://github.com/) browser extension) and a **local Claude Code session**. It lets you push a conversation, answer, or selection from the web into a live Claude Code session, and lets Claude Code pull live conversation state back — all client-side, all on your machine.

It is a **stdio MCP server** that Claude Code spawns; it opens a **loopback-only** WebSocket the extension connects out to. Not a daemon: it lives and dies with the session.

## Setup

One line, ever:

```
claude mcp add clenby -- npx clenby-bridge@latest
```

Print your pairing code (creates the token on first run — works any time you've lost it):

```
npx clenby-bridge code
```

Paste it under **Pair** in the extension's gear menu and confirm your browser's prompt. New Claude Code sessions authenticate automatically after that.

Rotate the pairing token if it may have leaked:

```
npx clenby-bridge --rotate-token
```

Running bridges keep the old token until restarted; re-pair once in the extension.

## What it exposes (MCP)

Read-mostly tools — `list_recent_conversations`, `get_conversation`, `get_pins`, `get_notes`, `get_highlights`, `search_conversations` (proxied to the extension), plus `get_latest_handoff`, `list_handoffs`, `whoami` (answered locally). The single write-shaped tool, `push_to_composer`, only **drafts** into the composer — it **never sends**. Pushed handoffs are also surfaced as MCP resources (`clenby://handoff/latest` and `clenby://handoff/{id}`) with a `resources/updated` notification on arrival.

## Security posture

- **Loopback only.** The socket binds `127.0.0.1` — nothing off-box can reach it. No cloud relay; nothing transits any server.
- **Two gates on every connection.** The handshake `Origin` must be a browser-extension origin, **and** the first frame must carry the per-machine pairing token. Missing either ⇒ immediate close.
- **One secret at rest.** The pairing token lives in your per-user config dir (`~/.config/clenby/bridge-token` on Linux; the OS equivalent elsewhere), created owner-only (`0600` on POSIX). It is never logged and never leaves loopback.
- **No conversation content at rest.** Handoffs exist only as transient frames and an in-session resource that dies with the process. No outbox, no queue, no stored payloads.
- **The bridge NEVER:** runs shell commands; reads or writes files other than the token; sends a message on your behalf; reads cookies, tokens, or auth storage; opens a non-loopback socket; accepts a connection lacking the extension Origin **and** the token; transmits anything to a non-loopback host.

## Spec

Full design, threat model, and wire protocol: `internal/design/claude-code-bridge-spec.md` in the Clenby repo.

## License

MIT
