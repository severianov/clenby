# Changelog

All notable changes to Clenby will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Keyboard shortcuts are now written down.** The gear menu's Actions zone has
  a Keyboard shortcuts row that prints the command-palette chord on its face —
  visible the moment you open the menu, not hidden in a tooltip — and opens a
  full, filterable reference inside the command palette, grouped Anywhere / In
  the composer / In a panel. Fifteen bindings, including several that were
  never documented anywhere.
- **A Palette launcher tile in the gear menu**, beside Find. The command
  palette previously had no gear entry at all, and its only label anywhere was
  a tooltip on an unlabelled ⌘ glyph.
- **The command palette shows a key legend under its list**, leading with the
  chord that opens it — so a user who clicked their way in leaves knowing the
  keystroke.

- **Breakage reporting without telemetry** — claude.ai ships UI changes without
  notice, and until now the only way to hear about a break was someone
  describing it in prose. Three additions, none of which send anything:
  - The selector-health panel gained **Copy report** and **Open a GitHub
    issue ↗**. Both produce the same markdown: extension version, browser,
    claude.ai's own build identity, and every degraded anchor with its
    counters, the fallback variant it landed on and the features it takes
    down. The issue button opens a prefilled form the user reviews and
    submits themselves — anchor names, health counters and structural element
    paths only, never message text.
  - Rows carrying a local override gained **Share**, which copies that
    override as importable JSON stamped with the build it was written
    against. A repair that used to die on one machine can now ship as the
    default for everyone.
  - Clenby now reads claude.ai's `data-build-id`, `data-git-hash`,
    `data-color-version` and build timestamp. Nothing depends on them — they
    exist so ten separate reports collapse into one line: everyone on this
    build lost the same anchor.
- **A canary that watches claude.ai** (`.github/workflows/claude-canary.yml`) —
  hourly, it reads the build identity and bundle hash from the app shell and
  opens an issue when either moves, so a UI change is noticed before the first
  user report. It calls out palette-generation changes specially, since those
  are the ones that move themes rather than anchors.

### Changed

- **Every chord in the interface is now spelled from one table**
  (`src/shared/keymap.ts`) and rendered for your platform — ⇧⌘K on macOS,
  Ctrl+Shift+K elsewhere. Ctrl and ⌘ both still work everywhere; the platform
  only decides what is printed. This replaces three different spellings of the
  same bindings that had drifted apart across the gear menu, the find bar and
  the header.
- **Sends to Claude Code report back in the status bar** — the row that used to
  just show the chat id now narrates each send in that space: `⇄ sending to
  <node>…`, then `✓ received by <node> · pick up: /mcp__clenby__handoff` (held
  ~5s, so you learn the one command that grabs it in Claude Code), or
  `✕ <reason>` when it doesn't land. No confirm dialog and no extra click — the
  five send surfaces keep their own button flashes; this is the ambient "where
  did it go, and how do I pick it up" readout. Click-to-copy on the id is paused
  while a send line shows, and the latest send wins when two overlap.
- **Sending to Claude Code is one decision, not three** — the send popover now
  asks only *what* to send (whole chat / this answer / selection). What happens
  with it is chosen at pickup, where it belongs: `/mcp__clenby__handoff` in Claude Code
  follows your words ("review this", "turn it into tests", anything), so the
  old Continue/Review/Context picker became redundant and is gone.
- **Claude Code settings zone wears a "Terminal" skin** — the whole zone now
  renders as a small terminal window (`clenby-bridge`): status reads
  `○ not linked` / `● connected — N session(s)`, pairing is a
  `# 1 · register … # 2 · code … # 3 · paste` sequence with click-to-copy
  `$ …` command lines, Rescan is an inline `(⟳)`, and install / audit / rotate
  / uninstall live behind `$ clenby advanced`. The frame stays deliberately
  dark on light themes — a terminal is dark.

- **Themes: the mode is now a hard Light/Dark choice** (the Auto option was
  removed). A themed preset renders exactly the chosen mode: the compiler
  lays claude.ai's full stock palette for that mode under the preset's own
  tokens, so picking Light on a dark claude.ai (or vice versa) produces a
  complete, coherent page instead of the old half-flipped mix. "Off" stays
  stock claude.ai and follows its appearance (the mode segment disables
  there). Legacy stored "auto" resolves to claude.ai's current appearance
  until a side is picked.
- **True Black is now "True B&W"** — the preset gained a real light half. Its
  dark side is unchanged (OLED true black); its light side is a mirrored
  "True White": a pure-white page and sidebar with hairline borders, a near-
  black text ramp, and very-light-gray bubbles and code surfaces with subtle
  borders. The old `basePalette` dark pin is dropped, so choosing Light renders
  white instead of forcing black under both modes. The preset id stays
  `true-black` (stored settings keep working); only the display name changed.
- **Mini-window is always-on-top again**: pop-out opens the compact Document
  Picture-in-Picture window directly (visible over every tab and app
  window), with multiple answers stacking as cards in its scrollable column
  — replacing the interim one-popup-per-answer model. The answer-toolbar
  button is now a stateful toggle: lit while the answer is popped out, click
  again to remove it. The pinned window survives conversation switches. On
  Firefox (no Document PiP) each answer degrades to one small popup window.
- **Mini-window content wears the "Console" design**: a sticky mono status
  strip per card (title + step/todo counts + jump/unpin), accent-dashed
  uppercase headings, full-bleed code with an accent rail, `01.` step rows
  and mono checklists — flush against the window, no in-window
  titlebar/border/box (the PiP's own slim strip is the only chrome). The PiP
  window title ("Clenby — pinned answers") is a stable contract for
  compositor keep-above rules on Wayland, where only the compositor can truly
  enforce always-on-top.
- **Toolbar icon**: clicking the extension icon no longer opens the old
  popup settings page (removed). On a claude.ai tab it opens the in-page
  gear settings; elsewhere it focuses (or opens) claude.ai.
- Build framework upgraded from WXT 0.19 to 0.20.27. No user-facing change;
  the generated Chrome and Firefox manifests were verified byte-identical
  before and after. The `webextension-polyfill` that 0.19 bundled by default
  (0.20 drops it) is re-added via the `@wxt-dev/webextension-polyfill` module
  so `runtime.onMessage` keeps its promise-based response semantics.

### Removed

- The `/handoff` project slash command. `/mcp__clenby__handoff`, provided by the
  `clenby-bridge` MCP server, is the single supported way to pick up a handoff.
  The command file shipped only to people who cloned the repository, never to
  users, and duplicated the MCP prompt's text — two copies of one instruction,
  free to drift.

### Fixed

- **Code blocks are painted again — the big one for Light themes.** claude.ai
  inverted its code-block markup: the scroll container used to sit *inside* the
  `<pre>`, and now wraps it (`div.overflow-x-auto > pre.code-block__code`). The
  shipped selector still described the old shape, so it matched nothing and the
  theme never painted a code surface at all. Because claude's syntax colours
  are inline styles bound to the page's real appearance — near-white ink when
  claude.ai renders dark — a Light theme ended up showing near-white code on a
  light page. The anchor now targets the current markup, and keeps the old
  shape plus a bare `pre` as fallbacks.
- **Theme rules now emit every selector candidate, not just the primary.** A
  runtime lookup walks its fallbacks and reports what matched; generated CSS
  had no such path, so a theme rule could silently stop applying with nothing
  to notice it. Candidates are compiled into one `:is()` union, so a markup
  change degrades instead of disappearing.
- **Outline: the Questions tab numbers match the Answers tab.** Question rows
  rendered their number in the faint grey used for secondary text while answers
  used the body tone at weight 600, so two tabs that are deliberately numbered
  as one symmetric pair didn't look like a pair.
- **"Send to Claude Code" feels instant, and the first send after an idle spell
  is quick** — two changes to the send path. The background used to sleep a flat
  ~2.7 s whenever its socket map looked empty (the MV3 worker having just woken
  to handle the send), so the first send after a quiet stretch always dragged
  even though the loopback bridge answers in a fraction of that; it now polls and
  proceeds the instant the session's socket checks in (same worst case, far
  quicker typically). And every collection send button — outline pinned, outline
  marks, both notes send buttons, and the gear "Send to Claude Code" row — now
  dims/shows "Sending…" the moment it's clicked (aria-busy for screen readers),
  cleared by the ✓/✕ result or an 8 s failsafe, so waiting for the confirmation
  no longer reads as "nothing happened". Rapid double-clicks track the latest
  send, and the busy face survives the panels re-rendering mid-flight.
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
- **True B&W chrome is scoped to its mode**: the engine's static True Black
  chrome CSS (sidebar pills, new-chat circle, rail labels — hardcoded dark
  grays that resist var overrides) is now keyed to the effective mode
  (`html[data-cc-mode]`), with a mirrored light-gray-on-white block for the
  new white half, so the dark chrome no longer paints invisible controls onto
  the True White page.
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

- **Send collections to Claude Code** — the outline's Pinned and Marks
  toolbars gain a send button next to copy/download: one click hands ALL
  pinned answers (or all highlights) to your connected session as a normal
  fenced handoff. The Notes panel gets the same button (list and editor
  views), sending this chat's notes. Same pull-based pickup as any handoff.
- **Bridge: sessions get human names** — every Claude Code session now has a
  deterministic petname derived from its id (`calm-falcon`, `quiet-maple`)
  instead of asking people to tell hex digits apart. Shown on the composer
  chip, the session dropdown, the gear roster, and the send popover; `whoami`
  reports it, so asking a terminal "which one are you?" matches the chip.
  Generated on the bridge side only — the extension displays what the
  handshake carries, so names can't drift between the two halves.
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
  dashed **"clenby-bridge"** label instead, so connected-vs-not is never a
  guess. Clicking the idle chip rescans the loopback ports on the spot, and
  the gear menu's Claude Code zone gains a matching **Rescan** button.
- **Bridge: `clenby-bridge code`** — prints your pairing code any time (and
  creates the token on first run), so recovering the code is one command
  instead of hunting for a dotfile. The README setup now includes it as the
  explicit "get your code" step.
- **Claude Code bridge** — an opt-in, local, secure link between claude.ai and
  a running Claude Code session. Send any answer or whole conversation into
  Claude Code, and let Claude Code read your web chats and draft a reply back
  into the composer (never auto-sent). Setup is one line — `claude mcp add
  --scope user clenby -- npx clenby-bridge@latest` — then Pair in the gear
  menu. A session chip on the composer button row shows/switches which
  project folder a conversation is linked to; sessions are identified
  per-process (two terminals in one repo don't collide) with a `whoami` tool
  to match them. Loopback-only (`127.0.0.1`), per-machine 256-bit token,
  live-only delivery (nothing queued or stored on disk). The `clenby-bridge`
  npm package (new `bridge/`) runs via `npx` — no daemon; it can never run
  shell commands, touch files outside its token, read login credentials, open
  a non-loopback socket, or send a message on your behalf. Passed an
  adversarial security review. Full spec + threat model in `SECURITY.md`.
- Unpin crosses in the outline's "📌 Pinned" group — pinned answers can be
  dropped right where they surface, same affordance as highlight rows.
- Theme-compiler unit tests (mode completeness, cascade order, Off purity)
  plus a node test-runner alias hook for `@/` imports.

- Initial feature set (~30 features) for claude.ai:
  - **Navigation** — outline navigator with Questions/Answers/Marks tabs,
    command palette, find-in-conversation.
  - **Reading** — theme presets with light/dark modes and text sizing,
    mini-window pop-out (Document Picture-in-Picture), scroll lock, message
    folding, image lightbox, live status bar, tab-title done ping.
  - **Composing** — draft keeper (per-conversation autosave), undo send,
    words/characters/token counter, optional Enter-inserts-newline mode.
  - **Memory** — pins, persistent highlights, per-chat notes, live
    checklists.
  - **Code & data** — table-to-CSV extractor, Markdown conversation export,
    artifact console relay.
  - **Trust** — secret detection, math checker.
  - **Output repair** — truncation guard with one-click continue, fence
    fixer, regen safety net.
- Self-healing config layer: central selector/endpoint registry with a
  storage-backed, data-only, allowlist-validated override store; selector
  health panel; optional opt-in API-key repair tier.
- Chrome (MV3) and Firefox (MV2) builds via WXT.
