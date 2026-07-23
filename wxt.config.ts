import { defineConfig } from "wxt";

// WXT config.
//
// Layout note: `entrypoints/` sits at the repo root while all other code lives
// under `src/`. WXT force-binds the `@` alias to srcDir (resolve-config.mjs),
// so srcDir MUST be "src" for `@/core/feature` imports to work; entrypointsDir
// points back up to the repo-top `entrypoints/`, and publicDir likewise.
//
// Permissions are intentionally minimal: `storage` is the ONLY API permission
// and `https://claude.ai/*` is the ONLY baseline host permission. No
// `<all_urls>`, no `tabs`/`scripting`/`activeTab`/`webRequest`, no remote
// code, ever. We keep MV3's default extension CSP (`script-src 'self'`)
// untouched.
//
// The ONE optional exception: `https://api.anthropic.com/*` is declared as an
// OPTIONAL host permission (Chrome MV3: optional_host_permissions; Firefox
// MV2: optional_permissions) for the self-healing layer's opt-in API repair
// tier. It is requested at runtime via permissions.request only when the user
// explicitly enables that tier — the default install grants nothing beyond
// claude.ai.
export default defineConfig({
  srcDir: "src",
  entrypointsDir: "../entrypoints",
  publicDir: "../public",
  outDir: ".output",

  // Chrome builds MV3; Firefox builds MV2 (WXT default for `-b firefox`).
  // MV2 on Firefox is deliberate: Firefox MV3 makes host
  // permissions opt-in at install, which would silently break the extension.
  manifest: ({ browser }) => {
    // Toolbar icon. The top-level `icons` field is auto-discovered by WXT from
    // public/icon/{size}.png; `default_icon` must be declared explicitly.
    // Chrome MV3 puts it on `action`, Firefox MV2 on `browser_action`.
    // Deliberately NO default_popup (the popup settings page was removed
    // 2026-07-22 — settings live in the in-page gear menu): the icon click
    // fires action.onClicked in the background, which opens the in-page
    // settings on claude.ai tabs and focuses/opens claude.ai elsewhere.
    const defaultIcon = {
      16: "icon/16.png",
      32: "icon/32.png",
      48: "icon/48.png",
      128: "icon/128.png",
    };
    return {
      name: "Clenby",
      description:
        "The experience layer for AI chats — starting with claude.ai. Self-healing, open source.",
      // `alarms`: the bridge's rescan tick — an MV3 worker evicted while no
      // bridge socket is open would otherwise never rediscover a session
      // started later. Fires locally, reads nothing.
      permissions: ["storage", "alarms"],
      host_permissions: ["https://claude.ai/*"],
      ...(browser === "firefox"
        ? {
            // MV2 has no optional_host_permissions — origins go in
            // optional_permissions (runtime-requested, same semantics).
            // `http://127.0.0.1/*` is the Claude Code bridge loopback grant,
            // requested at pairing (spec §7). Match patterns forbid ports, so
            // it reads broader than 47850–47859 — the gear-menu explainer,
            // shown before the browser's own popup, is the mitigation.
            optional_permissions: ["https://api.anthropic.com/*", "http://127.0.0.1/*"],
            browser_action: { default_icon: defaultIcon },
            // Firefox add-on id (required by AMO for MV2 background pages).
            browser_specific_settings: {
              gecko: {
                id: "clenby@clenby.dev",
                strict_min_version: "115.0",
              },
            },
          }
        : {
            // `http://127.0.0.1/*` is the Claude Code bridge loopback grant,
            // requested at pairing (spec §7 — see the Firefox note above).
            optional_host_permissions: ["https://api.anthropic.com/*", "http://127.0.0.1/*"],
            action: { default_icon: defaultIcon },
          }),
    };
  },
});
