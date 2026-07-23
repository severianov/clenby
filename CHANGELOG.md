# Changelog

All notable changes to Clenby will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Sending to Claude Code is one decision, not three** — the send popover now
  asks only *what* to send (whole chat / this answer / selection). What happens
  with it is chosen at pickup, where it belongs: `/handoff` in Claude Code
  follows your words ("review this", "turn it into tests", anything), so the
  old Continue/Review/Context picker became redundant and is gone.
- **Claude Code settings zone redesigned** — pairing is a numbered 3-step
  wizard with click-to-copy command chips; a status dot shows
  connected/paired/off at a glance; Rescan moved inline; and a collapsible
  "Terminal commands" drawer collects every CLI (pairing code, audit, rotate
  token) with plain-language labels.

- **Themes: the mode is now a hard Light/Dark choice** (the Auto option was
  removed). A themed preset renders exactly the chosen mode: the compiler
  lays claude.ai's full stock palette for that mode under the preset's own
  tokens, so picking Light on a dark claude.ai (or vice versa) produces a
  complete, coherent page instead of the old half-flipped mix. "Off" stays
  stock claude.ai and follows its appearance (the mode segment disables
  there). Legacy stored "auto" resolves to claude.ai's current appearance
  until a side is picked.
- **Mini-window is always-on-top again**: pop-out opens the compact Document
  Picture-in-Picture window directly (visible over every tab and app
  window), with multiple answers stacking as cards in its scrollable column
  — replacing the interim one-popup-per-answer model. The answer-toolbar
  button is now a stateful toggle: lit while the answer is popped out, click
  again to remove it. The pinned window survives conversation switches. On
  Firefox (no Document PiP) each answer degrades to one small popup window.
- **Mini-window content wears the "Console" design** (owner-picked from a
  three-way mockup, `internal/design/mockups/mini-window-designs.html`): a
  sticky mono status strip per card (title + step/todo counts + jump/unpin),
  accent-dashed uppercase headings, full-bleed code with an accent rail,
  `01.` step rows and mono checklists — flush against the window, no
  in-window titlebar/border/box (the PiP's own slim strip is the only
  chrome). The PiP window title ("Clenby — pinned answers")
  is a stable contract for compositor keep-above rules on Wayland, where
  only the compositor can truly enforce always-on-top.
- **Toolbar icon**: clicking the extension icon no longer opens the old
  popup settings page (removed). On a claude.ai tab it opens the in-page
  gear settings; elsewhere it focuses (or opens) claude.ai.

### Fixed

- **Selector health no longer cries wolf on virtualization**: content-
  dependent anchors (`assistantTable`, `messageImage`, …) can no longer be
  marked "broken" just because claude.ai unrendered them — scrolling away
  from a table used to trigger a false "anchor broke" alert a few seconds
  later. Absence now only counts as breakage for anchors that exist on every
  settled page (or, for the stop button, while generation is running) — and
  those "always present" anchors additionally only accrue misses while a
  conversation route is actually open, killing the sibling false alarm on
  /new and /settings.
- **Surface audit (projects/settings/artifacts)**: claude's newer CDS token
  family (`--cds-surface-*`, `--cds-text-*` — what project cards, the
  settings modal and the artifacts gallery are built from) is now part of the
  compiler's base layer, scoped to every `.cds-root` since claude re-declares
  tokens per root. Fixes dark project cards / washed headings on light
  themes. `--cds-fill-*` action tokens are deliberately left to claude (they
  invert per component; overriding them broke buttons). Known remaining
  gaps, documented: the /code artifact-viewer app's own chrome, and artifact
  iframe content (separate documents — unreachable by page CSS, by design).
- **Theme contrast audit (light mode especially)**: the gold used for
  pin/mark rows, the light terracotta accents, `textFaint` floors, the done-
  green, WhatsApp's link color, Focus/Code bar surfaces and Code's dark-mode
  blue all failed WCAG-ish contrast on the surfaces they render on —
  re-derived with computed ratios across all 16 preset halves.
- **Book theme (light)**: code blocks were compiled near-black behind
  light-mode syntax ink — now a readable parchment surface. Mode-literal
  claude colors (message body, composer input, header title, sidebar
  labels) are repainted by the compiler for the chosen mode — the theme
  owns the WHOLE frame, sidebar included. Only code-block surfaces follow
  the page's REAL mode, because syntax-highlighting ink cannot be restyled
  and must sit on a matching background.
- **True Black** pins its dark base palette in both modes (`basePalette`
  token) — choosing Light no longer leaks light danger/accent/border colors
  and light scrollbars onto the black page.
- **Outline unpin race**: the outline now takes pin state from the
  `pins:changed` broadcast instead of only a 1.2 s storage poll — a lingering
  stale 📌 row could otherwise silently RE-pin the answer when its ✕ was
  clicked.
- Managed-resource disposal survives dead foreign windows (per-listener
  guard), a reopened PiP window can't inherit phantom cards from a lost
  `pagehide`, and the toolbar icon no longer throws on Firefox for Android
  (no `windows` API there).
- `core/overrides.ts` no longer contains raw NUL bytes (git treated the
  repo's most security-sensitive file as binary — no diffs/blame); the
  unknown-placeholder sentinel is now a space with the same unforgeability
  guarantee.

### Fixed (bridge hardening pass, pre-publish review)

- **Bridge answers heartbeat pings** — the protocol's ping/pong was only
  implemented on the extension side; the bridge now pongs instead of logging
  "unknown frame type ping" every 15 seconds.
- **The extension reconnects on its own** — the rediscovery heartbeat now runs
  for as long as you're paired (plus a 30-second alarm that survives Chrome
  suspending the background worker). Previously a failed probe was never
  retried: restart Claude Code and the chip could stay dead until you touched
  the tab.
- **First send after a background-worker restart no longer false-fails** — the
  push now waits for the rescan to settle before declaring a session gone.
- **Conversation titles with `#` or quotes arrive intact** — the title now
  travels in the push metadata, and the bridge's frontmatter reader decodes
  JSON-quoted values properly instead of truncating at `#`.
- **Oversized handoffs fail honestly** — a handoff too big for one frame is
  refused up front with "send an answer or a selection instead", rather than
  crashing the socket and reporting a bogus "session disconnected".
- **Honest error messages** — a slow read now says the extension didn't answer
  in time (instead of "not connected", which sent users off to re-pair), and a
  failed delivery distinguishes "no confirmation" from "disconnected".
- **Composer widgets stay in the composer** — the undo-send timer, usage
  gauge, and bridge chip could attach themselves to a list row on the chats &
  tasks page if an item's button mentioned voice/recording. The composer
  anchor now requires the actual text-input area nearby before it accepts a
  match.
- **Orphaned tabs go quiet** — after the extension updates or reloads,
  already-open claude.ai tabs shut the companion down cleanly instead of
  error-spamming the extensions card until refreshed.
- Bridge internals: loopback bind can no longer be overridden by options;
  unauthenticated sockets are hard-terminated; port scan survives Windows
  EACCES; tool responses only accepted from the socket the request went to;
  duplicate `welcome` can't rebind a session's identity; push ids must be
  strings; `welcome` uses the shared envelope-version constant.

### Added

- **Bridge: one-command handoff pickup, zero setup** — the bridge now ships a
  `handoff` MCP prompt, which Claude Code automatically exposes as the
  `/mcp__clenby__handoff` slash command for every user who registered the
  bridge. Run it bare to follow the intent chosen at send time, or pass your
  own instructions ("/mcp__clenby__handoff summarize this") to override. No
  extra files, no configuration — it arrives inside the npm package.
- **Bridge: `clenby-bridge audit`** — prints every runtime file with its
  SHA-256 and the install path, so anyone can verify the exact code running on
  their machine before pairing. The gear-menu pairing panel now shows this
  command alongside the setup line.
- **Bridge: always-visible session chip** — once paired, the composer chip no
  longer vanishes when no Claude Code session is running: it shows a muted,
  dashed **"not connected"** state instead, so connected-vs-not is never a
  guess. Clicking the idle chip rescans the loopback ports on the spot, and
  the gear menu's Claude Code zone gains a matching **Rescan** button.
- **Bridge: `clenby-bridge code`** — prints your pairing code any time (and
  creates the token on first run), so recovering the code is one command
  instead of hunting for a dotfile. The README setup now includes it as the
  explicit "get your code" step.
- **Claude Code bridge** — an opt-in, local, secure link between claude.ai and
  a running Claude Code session. Send any answer or whole conversation into
  Claude Code with a chosen intent (Continue / Review / Context), and let
  Claude Code read your web chats and draft a reply back into the composer
  (never auto-sent). Setup is one line — `claude mcp add clenby -- npx
  clenby-bridge@latest` — then Pair in the gear menu. A session chip on the
  composer button row shows/switches which project folder a conversation is
  linked to; sessions are identified per-process (two terminals in one repo
  don't collide) with a `whoami` tool to match them. Loopback-only
  (`127.0.0.1`), per-machine 256-bit token, live-only delivery (nothing
  queued or stored on disk). The `clenby-bridge` npm package (new `bridge/`)
  runs via `npx` — no daemon; it can never run shell commands, touch files
  outside its token, read login credentials, open a non-loopback socket, or
  send a message on your behalf. Passed an adversarial security review. Full
  spec + threat model in `internal/design/claude-code-bridge-spec.md`.
- Unpin crosses in the outline's "📌 Pinned" group — pinned answers can be
  dropped right where they surface, same affordance as highlight rows.
- Theme-compiler unit tests (mode completeness, cascade order, Off purity)
  plus a node test-runner alias hook for `@/` imports.

- Initial feature set (~40 features) for claude.ai:
  - **Navigation** — outline navigator with Questions/Answers/Marks tabs,
    Conversation Atlas spatial map, command palette, find-in-conversation,
    per-answer table of contents, jump-to-bottom with unread line.
  - **Reading** — theme presets with light/dark modes and text sizing,
    mini-window pop-out (Document Picture-in-Picture), scroll lock, message
    folding, zebra rhythm, image lightbox, live status bar, tab-title done
    ping.
  - **Composing** — draft keeper (per-conversation autosave), undo send,
    words/characters/token counter, optional Enter-inserts-newline mode.
  - **Memory** — pins, persistent highlights, per-chat notes, copied-things
    tray, live checklists.
  - **Code & data** — code block toolbar with language badge and copy-safe
    line numbers, table-to-CSV extractor, Markdown conversation export,
    tool-call inspector, artifact console relay.
  - **Trust** — risk lens, math checker, link checker, link previews,
    citation collector.
  - **Output repair** — truncation guard with one-click continue, fence
    fixer, regen safety net.
- Self-healing config layer: central selector/endpoint registry with a
  storage-backed, data-only, allowlist-validated override store; selector
  health panel; optional opt-in API-key repair tier.
- Chrome (MV3) and Firefox (MV2) builds via WXT.
