# Clenby roadmap

What's coming, in rough order. No dates; items ship when they're solid.
Have an idea or a need? [Open an issue](../../issues); the roadmap follows
real usage.

## Now — hardening the Claude Code bridge for release

- **Firefox pairing.** The bridge works on Firefox once paired, but the
  permission prompt can't currently be triggered from the pairing panel
  there. A small extension settings page will host the grant.
- **Publishing `clenby-bridge` to npm** so the one-line setup works
  everywhere, with provenance (the package verifiably built from this
  repository).
- **Extension identity pinning.** Once the store listing exists, the bridge
  will accept only Clenby's published extension ID at the handshake.
- **More connection-layer tests** on the extension side, to match the
  bridge's suite.

## Next — smoothing the bridge experience

- **Hands-free handoff pickup.** An optional Claude Code hook so a pending
  handoff attaches itself to your next message, no more asking Claude to
  fetch it, plus a status-line indicator ("◍ 1 handoff pending") so you see
  arrivals at a glance.
- **Settings backup.** Export/import of your themes, toggles, and overrides,
  so a reinstall or a new machine doesn't mean reconfiguring.
- **Pairing-panel polish.** The connect flow works; it deserves better visual
  design than a stack of commands.

## Later — bigger swings

- **Handoffs from any AI web UI.** The bridge protocol doesn't care that the
  conversation came from claude.ai. Sending work into Claude Code from other
  AI chat interfaces (ChatGPT, Gemini, Kimi, and friends) is a natural
  extension of the same local, secure pipe.
- **Richer conversation tooling** across the existing feature set — see the
  changelog for the current surface.

## Principles that don't change

Everything stays client-side: no servers, no accounts, no telemetry. The
bridge stays loopback-only, human-in-the-loop, and auditable
(`npx clenby-bridge audit`). Security fixes always jump the queue.
