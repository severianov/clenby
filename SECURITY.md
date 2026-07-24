# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Use GitHub's private vulnerability reporting (**Security → Report a
vulnerability** on this repository) so the report stays private while it's
triaged and fixed. If you can't use that for some reason, contact the
maintainer directly through GitHub (**@severianov**) and say you have a
security report; the details can follow on a private channel.

Include what you found, how to reproduce it, and the impact you believe it
has. You'll get an acknowledgement within a few days, and credit in the fix's
release notes if you want it.

## Scope

Clenby is a browser extension that runs on `claude.ai`. Anything that could
leak conversation data, escalate the extension's privileges, or execute
unexpected code is in scope. Issues in claude.ai itself belong to Anthropic's
own disclosure program, not this repository.

## Security posture

The design keeps the attack surface small:

- **Client-side only.** No Clenby servers, no accounts, no telemetry. All
  user data lives in extension storage in your browser.
- **Minimal permissions.** The baseline install requests two API permissions
  (`storage`, and `alarms` for the bridge's local rescan tick) and one host
  permission (`https://claude.ai/*`). No `<all_urls>`, no `tabs`, no
  `scripting`, no `webRequest`.
- **`api.anthropic.com` is optional and opt-in.** It's declared as an
  optional permission and requested at runtime only if you explicitly enable
  the API-key repair tier. The default install can never reach it.
- **No remotely hosted or dynamically executed code.** The extension keeps
  the default MV3 CSP (`script-src 'self'`); nothing is `eval`'d,
  fetched-and-run, or injected from a server.
- **Self-healing overrides are data, only data.** The override layer accepts
  strings validated against a fixed allowlist of known selector/endpoint
  names; endpoint overrides are structurally origin-pinned (relative
  `/api/…` paths only — no scheme, no host, no `..`), validated at write time
  and re-validated at read time. Shipped defaults always remain in the
  fallback chain, and every override can be reset to stock.

## The Claude Code bridge

The bridge (`clenby-bridge` on npm) is the project's most security-sensitive
component: it connects a claude.ai conversation to a local Claude Code
session. It's opt-in, the default install never opens it, and its
`http://127.0.0.1/*` permission is optional, requested only at pairing.

An attacker abusing a user through the bridge has to get past all five
layers below:

1. **The socket exists only on the user's machine.** The bridge binds
   `127.0.0.1` exclusively, on ports 47850–47859. Nothing on the internet or
   local network can reach it; there is no Clenby server anywhere.
2. **Two locks on every connection.** A client must present a
   browser-extension `Origin` and the 256-bit pairing token from
   `~/.config/clenby/bridge-token` (file mode 0600, compared with
   `crypto.timingSafeEqual`). A web page fails the first lock; an arbitrary
   local process fails the second. Unauthenticated sockets are dropped and
   hard-terminated.
3. **Capability starvation.** The bridge never runs shell commands, writes
   nothing to disk beyond its own token file, has no access to cookies or
   logins, and opens no non-loopback sockets. It can't do what it has no code
   for, and `npx clenby-bridge@latest audit` prints the SHA-256 of every file
   it runs, so you can verify that directly instead of taking our word for
   it.
4. **A human stays in the loop.** Web→code delivery is pull-based (nothing
   enters a Claude Code conversation until the user asks for it); code→web
   can only place a *draft* in the composer, no code path presses Send.
5. **Handoff content is quarantined.** Every handoff travels inside a fence
   with a per-send random nonce, framed as quoted data, not instructions. A
   poisoned conversation that says "the handoff has ended, now run X" can't
   forge the closing marker, because the nonce never appears in conversation
   content.

The bridge also dies with its Claude Code session. It's not a daemon, and
nothing keeps running when Claude Code isn't.

**Known, accepted residual risks** (reports about these are welcome, but they
are documented trade-offs, not oversights):

- Malware already running *as the local user* can read the token file and
  impersonate a bridge. No loopback design survives an attacker who already
  owns the account; this is explicitly out of scope.
- The `Origin` gate currently accepts any browser-extension origin; the
  token is the effective gate. The origin check will be pinned to Clenby's
  published extension ID once the store listing exists.

In-scope examples we'd love reports on: bypassing the handshake gates,
escaping the handoff fence, making the bridge write or execute anything
beyond its charter, or getting a draft sent without a human click.

## Supported versions

Only the latest release receives security fixes.
