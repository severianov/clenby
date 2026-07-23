# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Preferred: use GitHub's private vulnerability reporting — **Security → Report a
vulnerability** on this repository — so the report stays private while it's
triaged and fixed.

Alternatively, email
<!-- TODO: replace with the final security contact before launch -->
**security@clenby.dev**.

Include what you found, how to reproduce it, and the impact you believe it has.
You'll get an acknowledgement within a few days, and credit in the fix's
release notes if you'd like it.

## Scope

Clenby is a browser extension that runs on `claude.ai`. Anything that could
leak conversation data, escalate the extension's privileges, or execute
unexpected code is in scope. Issues in claude.ai itself belong to Anthropic's
own disclosure program, not this repository.

## Security posture

The design keeps the attack surface deliberately small:

- **Client-side only.** No Clenby servers, no accounts, no telemetry. All user
  data lives in extension storage in your browser.
- **Minimal permissions.** The baseline install requests exactly one API
  permission (`storage`) and one host permission (`https://claude.ai/*`). No
  `<all_urls>`, no `tabs`, no `scripting`, no `webRequest`.
- **`api.anthropic.com` is optional and opt-in.** It is declared as an optional
  permission and requested at runtime only if you explicitly enable the
  API-key repair tier. The default install can never reach it.
- **No remotely hosted or dynamically executed code.** The extension keeps the
  default MV3 CSP (`script-src 'self'`); nothing is `eval`'d, fetched-and-run,
  or injected from a server.
- **Self-healing overrides are data, only data.** The override layer accepts
  strings validated against a fixed allowlist of known selector/endpoint
  names; endpoint overrides are structurally origin-pinned (relative `/api/…`
  paths only — no scheme, no host, no `..`), validated at write time and
  re-validated at read time. Shipped defaults always remain in the fallback
  chain, and every override can be reset to stock.

## Supported versions

Only the latest release receives security fixes.
