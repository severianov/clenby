# Clenby

[clenby.dev](https://clenby.dev)

A browser extension for claude.ai. Chrome is the tested target; a Firefox build exists but hasn't been fully verified yet (see ROADMAP.md). It adds an outline navigator, themes, a command palette, code and table tools, trust checks, output repair, and a self-healing layer that keeps selectors working when claude.ai changes its markup. claude.ai is the first target; the long-term plan is to support other AI chat apps too.

Everything runs locally in your browser. No servers, no accounts, no analytics.

## Features

### Navigate

- **Outline navigator** — draggable panel with Questions / Answers / Marks tabs, per-tab search, and jump-to-message.
- **Command palette** — `Ctrl+Shift+K` (`⌘⇧K` on Mac), fuzzy access to every Clenby action.
- **Find in conversation** — a real Ctrl+F for chats: searches the full conversation content, not just what's rendered on screen (`Ctrl+Shift+F`).

### Read

- **Themes** — full restyling presets for claude.ai (classic, book, compact, code, true B&W, …), each with a hard light or dark rendering (True B&W pairs a true-black night half with a true-white day half) and adjustable text size.
- **Mini-window** — pop any answer into a true always-on-top window (Document Picture-in-Picture) so it stays visible while you work elsewhere. On Linux/Wayland the compositor owns stacking: to make keep-above unconditional, add a window rule matching the window title `Clenby — pinned answers` (KWin: Window Rules → title exact → "Keep above" Force; Hyprland: `windowrulev2 = pin, title:^(Clenby — pinned answers)$`).
- **Scroll lock** — stops claude.ai from pulling the viewport to the bottom while an answer is still streaming.
- **Folding** — collapse long messages down to a one-line head.
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
- **Live checklists** — turns Claude's step-by-step instructions into tickable checkboxes that remember their state per chat.
- **Answer meta-line** — stamps each answer with when it was written and which model wrote it.

### Code & data

- **Table toolbar** — every markdown table gets copy-as-TSV, CSV download, and a sortable full-screen view.
- **Export** — copy or download the conversation as clean Markdown, with an inline scope chooser; the gear menu's Export section can also send it straight to Claude Code.
- **Console relay** — catches runtime errors inside Claude's artifact previews and sends them back to Claude with one click.

### Trust

- **Secret detection** — warns before you send a draft that looks like it contains an API key, password, or credit card number.
- **Math checker** — recomputes simple arithmetic stated in answers and flags results that don't add up.
- **Usage meter** — your session and weekly limits, live, next to the composer.

### Output repair

- **Truncation guard** — detects when an answer got cut off and offers a one-click "Continue from where you stopped".
- **Fence fixer** — repairs the display when an unclosed code fence swallows the rest of a message.
- **Regen safety net** — snapshots an answer before a retry/regenerate replaces it, so a worse reroll can't lose the good one.

## Claude Code bridge

Claude on the web and Claude Code in your terminal don't share a login or any memory, so they can't see each other. The bridge closes that gap, locally. Once it's connected you can send any answer, or a whole conversation, straight into a running Claude Code session, and Claude Code can read your web chats and draft a reply back into the composer for you to review and send.

Everything stays on your machine. The link is a loopback-only connection (`127.0.0.1`) guarded by a pairing token. No server, no cloud relay, nothing published online.

### Setup

You need [Node.js](https://nodejs.org) installed (if you installed Claude Code with `npm`, you already have it; `npx` comes with it).

1. Install the extension (above), then run this in your terminal to register the bridge:
   ```sh
   claude mcp add --scope user clenby -- npx clenby-bridge@latest
   ```
2. Get your pairing code. This prints it any time, even months later:
   ```sh
   npx clenby-bridge@latest code
   ```
3. Paste the code in Clenby's gear menu → Claude Code → **Pair**, and confirm your browser's permission request.

Pairing happens once per machine, never again. After that everything is automatic: a session chip by the composer shows **clenby-bridge** (greyed, dashed) until a Claude Code session is running, then switches to the project name and the session's petname (e.g. `clenby · calm-falcon`), and "Send to Claude Code" lights up. Click the chip or the gear menu's **Rescan** (⟳) any time to check for sessions.

### How it works

Every answer gets a *Send to Claude Code* button. Pick what to send (whole conversation, this answer, a selection) and hit Send. The handoff travels as readable Markdown with a header telling Claude Code to treat it as data, not commands. What happens with it next is decided at pickup, on the Claude Code side.

The outline's Pinned and Marks toolbars, and the Notes panel, carry the same send button for their own content: all pins, all highlights, or this chat's notes.

Each Claude Code session is identified by its own id, not just its folder, so two terminals in the same repo don't collide. The chip by the composer shows and switches the target; ask any session `whoami` to match it to a row.

From Claude Code, you can read your conversations, pins, notes and highlights, and place a draft in the claude.ai composer. It never sends. You always review and press send yourself.

Delivery is deliberately pull-based: sending never interrupts or auto-prompts your session. In the terminal, run **`/mcp__clenby__handoff`** (it ships with the bridge, nothing to install) and tell it what you want. Run it bare to load the handoff as context, or add your own words, like `/mcp__clenby__handoff review this plan` or `…turn it into tests`. Plain English works too: just ask Claude to "pick up the clenby handoff." Nothing appears on its own; you decide when it enters the conversation.

If no session is connected, nothing queues. The Send button simply waits, greyed, until a session connects. Delivery is live-only; nothing about your conversations is ever stored on disk.

The bridge is not a daemon: it dies with its Claude Code session, so ending the session (or running `/mcp` in it and disabling `clenby`) stops that bridge instantly. Nothing keeps running on its own. To sever the link entirely, use the **`$ clenby unpair`** line in the gear menu's Claude Code terminal: it unpairs, wipes the stored token, and releases the 127.0.0.1 permission.

### Why not a claude.ai custom connector?

claude.ai supports [custom connectors](https://support.claude.com/en/articles/11503834-build-custom-connectors-via-remote-mcp-servers) (remote MCP servers), so it's worth explaining why this is a separate bridge instead. Connectors point the wrong way for this job.

Connectors are remote-only: a custom connector must be a public HTTPS server, and the connection is made from Anthropic's backend, so `127.0.0.1` is unreachable from there. Tunneling your machine to make it reachable would trade a loopback-only link for an internet-facing one.

Connectors also feed data into claude.ai, not out of it. They give the web model tools to pull from; they can't push a conversation out to a Claude Code session, can't place a draft in the composer, and can't see extension-local data like pins, notes, or highlights.

There's no native handoff either. claude.ai's own "Keep going in Claude Code" button opens a fresh session without the conversation, and there is no public API for claude.ai chat history. The bridge is currently the only way to move a web conversation into a live terminal session without anything leaving your machine.

### Security posture

The bridge binds to loopback only, authenticates every connection with a per-machine token (256-bit, compared in constant time), and rejects anything that isn't your browser extension. It will never run shell commands, read or write arbitrary files, touch your login cookies or tokens, open a non-loopback socket, or send a message on your behalf. `clenby-bridge` is open source and runs via `npx`: no daemon, no background service, nothing left running when Claude Code isn't. Full threat model: [`SECURITY.md`](./SECURITY.md).

### Troubleshooting

- **Chip says "clenby-bridge" (greyed/dashed)?** No Claude Code session is running (or it just started; click the chip to rescan). Start `claude` in a project folder and the chip switches to its project name and petname.
- **Lost your pairing code?** `npx clenby-bridge@latest code` prints it any time. You only need it again on a new browser profile.
- **Asked to pair again?** Your token was rotated (`npx clenby-bridge --rotate-token`); paste the new code once.
- **Send button greyed out?** No session connected. Start Claude Code in a project folder and it lights up.

## Self-healing

Clenby anchors onto claude.ai's DOM and API, and claude.ai changes without notice. Rather than waiting for an extension update every time that happens, every selector and API endpoint the extension uses lives in a central registry, and a storage-backed, data-only override store can re-aim any of those anchors without a code update. Shipped defaults always remain in the fallback chain, overrides are validated against a strict allowlist (no code, no cross-origin paths, ever), and each entry can be reset to stock with one click.

To be clear about the scope: the healing layer repairs *anchoring*, where Clenby attaches in the page and which endpoints it reads. It does not rewrite feature logic. If claude.ai changes something deeper than a selector or a path, that still needs a regular update.

There's also an optional repair tier: with your own Anthropic API key, Clenby can ask Claude to propose a replacement selector from a sanitized sketch of the changed page region. This tier is strictly opt-in: it requires you to explicitly grant the optional `api.anthropic.com` permission at runtime, and the default install grants nothing beyond claude.ai.

## Screenshots

<!-- TODO: add screenshots (outline navigator, themes, command palette, self-healing panel). -->

Coming soon.

## Install

Web Store and AMO listings: coming soon. Until then, build from source:

```sh
git clone <this repo>
cd clenby
npm install
```

### Chrome

```sh
npm run build            # outputs chrome-extension-build/
```

Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the `chrome-extension-build/` directory. For development with hot reload, use `npm run dev` instead.

### Firefox

```sh
npm run build:firefox    # outputs .output/firefox-mv2
```

Open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on…**, and select any file inside `.output/firefox-mv2`. For development, use `npm run dev:firefox`.

Built with [WXT](https://wxt.dev). Requires Node 23.6+ to develop (the test runner executes TypeScript natively); the published bridge package only needs Node 18.14+.

## Privacy

Clenby runs entirely client-side. Its only baseline host permission is `https://claude.ai/*`, its API permissions are `storage` and `alarms`, and nothing leaves your browser except: your own claude.ai session data that the page already loads; opt-in API-key repair calls to `api.anthropic.com` that you explicitly enable; and the opt-in Claude Code bridge, a loopback-only (`127.0.0.1`) connection you turn on by pairing, which also never leaves your machine. No servers, no accounts, no analytics.

## Disclaimer

Clenby is an independent, community open-source project. It is **not
affiliated with, endorsed by, or sponsored by Anthropic**. "Claude",
"claude.ai", and "Claude Code" are trademarks of Anthropic, PBC, used here
only to describe what the extension works with.

The software is provided **"as is", without warranty of any kind**, per the
[MIT license](./LICENSE); use it at your own risk. claude.ai changes without
notice and features may break at any time (the self-healing layer exists for
exactly that reason, but it's not a guarantee). You remain responsible for
what you send, store, and run, including anything a handoff asks Claude Code
to do on your machine.

## License

MIT. See [LICENSE](./LICENSE).

Take what's useful. If Anthropic builds any of this into claude.ai natively,
good — I'd rather use these features than maintain them.

## Contributing

Issues, ideas, and pull requests are welcome. If claude.ai broke an anchor or a feature could work better for you, open an issue. See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, repo layout, and the feature checklist.
