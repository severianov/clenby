# Contributing to Clenby

Thanks for helping build the experience layer for AI chats. This document covers everything you need to go from clone to merged PR.

## Getting set up

Requirements: **Node 18+** and **Yarn** (classic).

```sh
git clone <this repo>
cd clenby
yarn install
```

| Command | What it does |
| --- | --- |
| `yarn dev` | Chrome dev build with hot reload (WXT) |
| `yarn dev:firefox` | Firefox dev build |
| `yarn build` | Production Chrome (MV3) build → `chrome-extension-build/` |
| `yarn build:firefox` | Production Firefox (MV2) build → `.output/firefox-mv2` |
| `yarn compile` | Typecheck (`tsc --noEmit`) — the main quality gate |
| `yarn test` | Run the test suite (`node --test`) |

For `yarn dev`, load the unpacked output from `.output/chrome-mv3` at `chrome://extensions` once; WXT reloads it as you edit.

## Repo layout

```
entrypoints/          WXT entrypoints — deliberately thin
  background.ts         extension background
  claude.content.ts     THE content script (claude.ai only); boots the runtime
  popup/                toolbar popup
src/
  core/               runtime, feature lifecycle, event bus, selector registry,
                      self-healing overrides, storage, conversation store
  features/           one folder per feature (~40 of them) — all product logic
  api/                the claude.ai API client, endpoint registry, type guards
  theme/              theme engine, tokens, presets, structural CSS
  shared/             pure helpers (text, links, time, outline parsing)
  ui/                 companion root element + motion helpers
  styles/             base companion CSS
tests/                node:test suites
public/               static assets (icons)
wxt.config.ts         manifest + build config — permissions live here
```

## How features work

Every feature is a self-contained module in `src/features/<name>/` that implements the `FeatureModule` contract from `src/core/feature.ts`:

- **`id`** — kebab-case identifier, used for DOM ownership tagging and logging.
- **`scope`** — `"session"` (mounted once per page load) or `"conversation"` (unmounted and remounted on every conversation switch).
- **`mount(ctx)`** — create UI, subscribe to events, start observers — **only via `ctx`**.
- **`unmount()`** (optional) — feature-specific teardown (e.g. flush a pending save); must not throw.

The `FeatureContext` is the whole game. Features never call global `setInterval`, `addEventListener`, or `new MutationObserver` directly — they use the managed equivalents on `ctx` (`ctx.setInterval`, `ctx.listen`, `ctx.observe`, `ctx.on`, `ctx.onCleanup`, `ctx.signal`). The runtime records every resource acquired through the context and disposes all of them at unmount, so a feature that follows the contract cannot leak timers, listeners, or observers across remounts.

`ctx` also carries the core services: the event bus, the API client, conversation-scoped storage, the conversation store, the selector registry, the composer service, decorations, and the self-healing override slice.

## Conventions (enforced in review)

1. **Own-UI only — never mutate the host page's DOM structure.** Clenby renders its own elements (tagged with a `data-cc-owner` attribute) and appends top-level UI only under the companion root (`ctx.root`). Reading claude.ai's DOM is fine; reparenting, deleting, or rewriting the page's own nodes is not. Visual changes to the host page go through CSS (the theme layer), not DOM surgery.
2. **All colors via CSS tokens.** No hardcoded hex/rgb in feature styles — use the `--cc-*` custom properties provided by the theme engine so every feature works across all themes and light/dark modes automatically.
3. **All selectors via the registry.** Never inline a `querySelector` string for a claude.ai element inside a feature. Add or reuse a named entry in `src/core/selectors.ts` and resolve it through `ctx.selectors` — that is what makes the self-healing override layer able to repair it later.
4. **All network via the API client.** Endpoints are named entries in `src/api/endpoints.ts`; features call `ctx.api`, never `fetch` claude.ai URLs directly.
5. **No new permissions.** `storage` + `https://claude.ai/*` (plus the optional, runtime-requested `api.anthropic.com`) is the complete permission surface. A PR that widens it needs prior discussion in an issue.
6. **No remote or dynamically executed code.** Ever. The self-healing layer is data-only by design; keep it that way.

## Adding a feature

1. Create `src/features/<kebab-name>/index.ts` exporting a `FeatureModule`.
2. Register it with **one line** in `src/core/registry.ts` (the only place features are enumerated). Respect the ordering notes at the top of that file.
3. Acquire every resource through `ctx`; put any top-level UI under `ctx.root`; style with `--cc-*` tokens.
4. If it needs a new page anchor or endpoint, add it to the selector/endpoint registry first.
5. Add it to the feature list in `README.md`, and to `CHANGELOG.md` under `[Unreleased]`.

## Pull requests

- Keep PRs focused — one feature or fix per PR.
- Describe the user-visible behavior; screenshots or a short clip for UI changes help a lot.
- Both of these must pass locally (they are also run in CI):
  ```sh
  npx tsc --noEmit
  yarn build
  ```
- Run `yarn test`, and add a test when the change is pure logic that lends itself to one (see `tests/`).
- Test on Chrome; if you touched anything manifest- or API-adjacent, please test `yarn dev:firefox` too.
- No breaking the conventions above — reviews will hold the line on the lifecycle contract, token-only colors, and registry-only selectors.

## Reporting bugs

claude.ai ships UI changes without notice, so "a feature stopped attaching" is a normal, expected bug class. Please include your browser, the extension version, and what the selector-health panel reports — that usually pinpoints the broken anchor immediately.

## Code of conduct

Be kind. See [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
