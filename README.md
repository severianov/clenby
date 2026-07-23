# Clenby

**The experience layer for AI chats — starting with claude.ai. Self-healing, open source.**

Clenby is a browser extension (Chrome + Firefox) that supercharges the claude.ai web app: an outline navigator, themes, a command palette, code and table tools, trust checks, output repair, and a self-healing config layer that survives claude.ai UI changes. claude.ai is the first host — the long-term goal is one great experience layer across all AI chat apps.

Everything runs locally in your browser. No servers, no accounts, no analytics.

## Features

### Navigate

- **Outline navigator** — a draggable panel with Questions / Answers / Marks tabs, per-tab search, and jump-to-message.
- **Conversation Atlas** — a full-viewport spatial map of the conversation: your questions as hub nodes, answer headings orbiting them, connected by a chronological spine.
- **Command palette** — `Ctrl+Shift+K` (`⌘⇧K` on Mac) fuzzy access to every Clenby action.
- **Find in conversation** — a real Ctrl+F for chats: searches the full conversation content, not just what's rendered on screen.
- **Answer TOC** — long answers get a compact, collapsible mini table-of-contents at the top.
- **Jump to bottom** — a "↓ new" pill when you're scrolled up and new content has arrived, with an unread line marking where you left off.

### Read

- **Themes** — full restyling presets for claude.ai (classic, book, compact, code, true black, …) with light/dark modes and adjustable text size.
- **Mini-window** — pop any answer out into a true always-on-top window (Document Picture-in-Picture) so it stays visible while you work elsewhere. On Linux/Wayland the compositor owns stacking: to make keep-above unconditional, add a window rule matching the window title `Clenby — pinned answers` (KWin: Window Rules → title exact → "Keep above" Force; Hyprland: `windowrulev2 = pin, title:^(Clenby — pinned answers)$`).
- **Scroll lock** — stops claude.ai from yanking the viewport to the bottom while an answer is still streaming.
- **Folding** — collapse long messages down to a one-line head.
- **Zebra rhythm** — a subtle alternating tint per exchange so turns are easy to tell apart.
- **Image lightbox** — click any image in a thread to view it full-screen.
- **Status bar** — live generation status: elapsed time, activity, and progress at a glance.
- **Done ping** — a tab-title indicator (● generating / ✓ done) so you can switch tabs while Claude writes.

### Compose

- **Draft keeper** — autosaves your unsent draft per conversation; it survives refresh, crash, and navigation.
- **Undo send** — a configurable delay window to cancel a message you just sent.
- **Composer counter** — live words / characters / rough token estimate for the current draft.
- **Enter behavior** — optional Enter-inserts-newline mode (send with Ctrl+Enter), off by default.

### Remember

- **Pins** — pin important answers and find them again from the outline's Marks tab.
- **Highlights** — highlight any passage in an answer; highlights persist per conversation.
- **Notes** — a per-chat live-markdown notepad in the header.
- **Copied-things tray** — a session history of everything you copied from answers, one click to re-copy.
- **Live checklists** — turns Claude's step-by-step instructions into tickable checkboxes that remember their state per chat.

### Code & data

- **Code toolbar** — every code block gets a language badge and clean line numbers that never pollute your copies.
- **Table extractor** — export any markdown table as CSV or copy it in spreadsheet-ready form.
- **Export** — copy or download the conversation as clean Markdown, with an inline scope chooser.
- **Tool-call inspector** — open up Claude's collapsed tool / search / thinking blocks and inspect what actually happened.
- **Console relay** — catches runtime errors inside Claude's artifact previews and sends them back to Claude with one click, closing the debug loop.

### Trust

- **Risk lens** — marks the most error-prone parts of an answer (hedge phrases, numbers, dates, URLs) so they're one-glance checkable.
- **Math checker** — recomputes simple arithmetic stated in answers and flags results that don't add up.
- **Link checker** — flags likely-hallucinated links by checking whether the linked domain responds at all.
- **Link previews** — hover a link to see its full URL, domain, and favicon before you click.
- **Citation collector** — one reference list of every external link Claude gave in the chat, with the message it came from.

### Output repair

- **Truncation guard** — detects when an answer got cut off and offers a one-click "Continue from where you stopped".
- **Fence fixer** — repairs the display when an unclosed code fence swallows the rest of a message.
- **Regen safety net** — snapshots an answer before a retry/regenerate replaces it, so a worse reroll can't lose the good one.

## Claude Code bridge

Claude on the web and Claude Code in your terminal can't see each other — different logins, no shared memory. The bridge closes that gap, locally and securely. Once it's connected you can **send any answer (or a whole conversation) straight into a running Claude Code session** with a chosen intent, and Claude Code can **read your web chats** and **draft a reply back into the composer** for you to review and send.

Everything stays on your machine. The link is a loopback-only connection (`127.0.0.1`) guarded by a pairing token — no server, no cloud relay, nothing published online.

### Setup — three steps

You need [Node.js](https://nodejs.org) installed (if you installed Claude Code with `npm`, you already have it — `npx` comes with it).

1. **Install the extension** (above), then run this in your terminal to register the bridge:
   ```sh
   claude mcp add clenby -- npx clenby-bridge@latest
   ```
2. **Get your pairing code** — this prints it any time, even months later:
   ```sh
   npx clenby-bridge@latest code
   ```
3. **Paste the code** in Clenby's gear menu → Claude Code → **Pair**, and confirm your browser's permission request.

That's it — pairing happens once per machine, never again. After that everything is automatic: a session chip by the composer shows **not connected** (greyed, dashed) until a Claude Code session is running, then flips to the project folder name, and "Send to Claude Code" lights up. Click the chip or the gear menu's **Rescan** any time to check for sessions on the spot.

### How it works

- **Send from claude.ai** — every answer gets a *Send to Claude Code* button. Pick an intent (Continue the work · Review it · Context only) and a scope (whole conversation · this answer · a selection). The handoff travels as readable Markdown with a header telling Claude Code to treat it as data, not commands.
- **Which session** — each Claude Code session is identified by its own id (not just its folder, so two terminals in the same repo don't collide). The chip by the composer shows and switches the target; ask any session `whoami` to match it to a row.
- **From Claude Code** — it can read your conversations, pins, notes and highlights, and place a draft in the claude.ai composer. It **never sends** — you always review and press send yourself.
- **Receiving in Claude Code** — delivery is deliberately pull-based: sending never interrupts or auto-prompts your session. After you press Send, just ask Claude in that terminal to *"pick up the clenby handoff"* — it fetches the full Markdown with the `get_latest_handoff` tool. Nothing appears on its own; you decide when it enters the conversation.
- **No session? Nothing queues.** The Send button simply waits, greyed, until a session connects. Delivery is live-only — nothing about your conversations is ever stored on disk.
- **Stopping it.** The bridge is not a daemon: it dies with its Claude Code session, so ending the session (or running `/mcp` in it and disabling `clenby`) stops that bridge instantly. Nothing keeps running on its own. To sever the link entirely, use **Forget** in the gear menu — it unpairs, wipes the stored token, and releases the 127.0.0.1 permission.

### Why not a claude.ai custom connector?

A fair question — claude.ai supports [custom connectors](https://support.claude.com/en/articles/11503834-build-custom-connectors-via-remote-mcp-servers) (remote MCP servers), so why build a bridge? Because connectors can't reach your machine and point the wrong way:

- **Connectors are remote-only.** A custom connector must be a public HTTPS server, and the connection is made from Anthropic's backend — `127.0.0.1` is unreachable from there. Exposing your machine through a tunnel would trade a loopback-only link for an internet-facing one.
- **Connectors feed data *into* claude.ai.** They give the web model tools to pull from; they can't push a conversation *out* to a Claude Code session, can't place a draft in the composer, and can't see extension-local data like pins, notes, or highlights.
- **There's no native handoff.** claude.ai's own "Keep going in Claude Code" button opens a fresh session without the conversation, and there is no public API for claude.ai chat history. The bridge is currently the only way to move a web conversation into a live terminal session — and it does it without anything leaving your machine.

### Security posture

The bridge is designed to be safe to run publicly. It binds to loopback only, authenticates every connection with a per-machine token (256-bit, compared in constant time), and rejects anything that isn't your browser extension. It will **never** run shell commands, read or write arbitrary files, touch your login cookies or tokens, open a non-loopback socket, or send a message on your behalf. `clenby-bridge` is open source and runs via `npx` — no daemon, no background service, nothing left running when Claude Code isn't. Full threat model: [`internal/design/claude-code-bridge-spec.md`](./internal/design/claude-code-bridge-spec.md).

### Troubleshooting

- **Chip says "not connected"?** No Claude Code session is running (or it just started — click the chip to rescan). Start `claude` in a project folder and the chip flips to its name.
- **Lost your pairing code?** `npx clenby-bridge@latest code` prints it any time. You only ever need it again on a new browser profile.
- **Asked to pair again?** Your token was rotated (`npx clenby-bridge --rotate-token`) — paste the new code once.
- **Send button greyed out?** No session connected. Start Claude Code in a project folder and it lights up.

## Self-healing

Clenby anchors onto claude.ai's DOM and API — and claude.ai changes without notice. Instead of waiting for an extension update every time that happens, Clenby ships a **self-healing override layer**: every selector and API endpoint the extension uses lives in a central registry, and a storage-backed, data-only override store can re-aim any of those anchors without a code update. Shipped defaults always remain in the fallback chain, overrides are validated against a strict allowlist (no code, no cross-origin paths — ever), and each entry can be reset to stock with one click.

To be clear about the scope: the healing layer repairs *anchoring* — where Clenby attaches in the page and which endpoints it reads. It does not rewrite feature logic. If claude.ai changes something deeper than a selector or a path, that still takes a regular update.

There is also an optional repair tier: with your own Anthropic API key, Clenby can ask Claude to propose a replacement selector from a sanitized sketch of the changed page region. This tier is strictly opt-in — it requires you to explicitly grant the optional `api.anthropic.com` permission at runtime, and the default install grants nothing beyond claude.ai.

## Screenshots

<!-- TODO: add screenshots (outline navigator, Atlas, themes, command palette, self-healing panel). -->

*Coming soon.*

## Install

Web Store and AMO listings: **coming soon**. Until then, build from source:

```sh
git clone <this repo>
cd clenby
yarn install
```

### Chrome

```sh
yarn build            # outputs chrome-extension-build/
```

Then open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the `chrome-extension-build/` directory. For development with hot reload, use `yarn dev` instead.

### Firefox

```sh
yarn build:firefox    # outputs .output/firefox-mv2
```

Then open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on…**, and select any file inside `.output/firefox-mv2`. For development, use `yarn dev:firefox`.

Built with [WXT](https://wxt.dev). Requires Node 18+ and Yarn.

## Privacy

Clenby runs entirely client-side — its only baseline host permission is `https://claude.ai/*`, its only API permission is `storage`, and nothing leaves your browser except (a) your own claude.ai session data that the page already loads, (b) opt-in API-key repair calls to `api.anthropic.com` that you explicitly enable, and (c) the opt-in Claude Code bridge, a loopback-only (`127.0.0.1`) connection you turn on by pairing — which also never leaves your machine. No servers, no accounts, no analytics.

## License

MIT — see [LICENSE](./LICENSE).

## Contributing

Issues, ideas, and pull requests are very welcome — if claude.ai broke an anchor or a feature could serve you better, open an issue and let's fix it. See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, repo layout, and the feature checklist.
