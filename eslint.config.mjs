/**
 * ESLint flat config (ESLint v10). Replaces the legacy `.eslintrc.cjs` and
 * preserves its intent rule-for-rule: the same structural bans, expressed as
 * lint rules, each mapping to a real bug class in a content-script extension of
 * this shape. See CLAUDE.md / CONTRIBUTING.md for the house rules they encode.
 *
 * Non-type-aware on purpose — the legacy `parserOptions` set no `project`, so
 * nothing here needs the TypeScript program (keeps lint fast and CI-simple).
 */

import globals from "globals";
import tseslint from "typescript-eslint";

export default [
  // ── Ignores ────────────────────────────────────────────────────────────
  // Build output, dependencies, generated dirs, internal docs, and any
  // vendored/minified JS. `bridge/` is a separate Node/JS package with its own
  // toolchain and was NOT covered by the legacy config; linting it is a
  // possible follow-up (it would need its own flat block with node globals).
  {
    ignores: [
      "node_modules/",
      ".output/",
      ".wxt/",
      "chrome-extension-build/",
      "coverage/",
      "bridge/",
      "internal/",
      "website/",
      "**/*.min.js",
    ],
  },

  // ── Linter options ─────────────────────────────────────────────────────
  // Restore the legacy (ESLint 8) default: don't report unused eslint-disable
  // directives. ESLint 10 flipped this default to "warn", which flags the
  // repo's deliberate inline suppressions for rules this curated config doesn't
  // enable — e.g. the `@typescript-eslint/no-deprecated` (type-aware) disable on
  // the required-for-ProseMirror execCommand, and the `no-control-regex` disable
  // on an intentional control-char sanitizer. Those directives are meaningful,
  // not stale, so keep them silent rather than delete author intent.
  {
    linterOptions: { reportUnusedDisableDirectives: "off" },
  },

  // ── Base: every TypeScript source file ─────────────────────────────────
  // Mirrors the legacy root block: the @typescript-eslint parser, browser +
  // es2022 globals, and the bare-`chrome` ban (Chrome/Firefox parity is only
  // possible through the unified `browser` import).
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "chrome", message: "Use the unified `browser` import from wxt/browser (Chrome/Firefox parity)." },
      ],
    },
  },

  // ── Inline-style backstop: src/** except the token-emitting layers ─────
  // Mirrors legacy overrides[1]. A soft (warn) net for inline
  // color/font/background on companion elements — those must come from a class
  // reading a `--cc-*` token. core/ and theme/ legitimately emit those values,
  // so they're excluded (matching the legacy `excludedFiles`).
  //
  // Ordered BEFORE the features block deliberately: ESLint applies a single
  // `no-restricted-syntax` config per file, and for feature files the
  // error-level managed-API bans below must win over this warn. (The legacy
  // `overrides` array ordered these the other way, which silently clobbered the
  // managed-API syntax bans on the very feature files they target; restoring
  // them is the documented intent.)
  {
    files: ["src/**/*.ts"],
    ignores: ["src/core/**", "src/theme/**"],
    rules: {
      "no-restricted-syntax": [
        "warn",
        {
          selector:
            "AssignmentExpression[left.property.name=/^(color|background|backgroundColor|font|fontSize|fontFamily|borderColor)$/]",
          message: "No inline color/font/background on companion elements — use a class reading var(--cc-*).",
        },
      ],
    },
  },

  // ── Features: the content-script lifecycle contract ────────────────────
  // Mirrors legacy overrides[0]. Features touch only the managed ctx.* variants
  // (auto-disposed at unmount), never raw global timers/listeners/observers,
  // and never import another feature (they go through the event bus or a core
  // service).
  {
    files: ["src/features/**/*.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "setInterval", message: "Use ctx.setInterval — managed + auto-disposed." },
        { name: "setTimeout", message: "Use ctx.setTimeout — managed + auto-disposed." },
        { name: "chrome", message: "Use the `browser` import from wxt/browser." },
      ],
      "no-restricted-properties": [
        "error",
        { object: "window", property: "setInterval", message: "Use ctx.setInterval." },
        { object: "window", property: "setTimeout", message: "Use ctx.setTimeout." },
        { object: "document", property: "addEventListener", message: "Use ctx.listen." },
        { object: "window", property: "addEventListener", message: "Use ctx.listen." },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "NewExpression[callee.name='MutationObserver']",
          message: "Use ctx.observe — managed + auto-disposed.",
        },
        {
          selector: "CallExpression[callee.property.name='addEventListener']",
          message: "Use ctx.listen instead of raw addEventListener.",
        },
        {
          selector: "MemberExpression[object.name='document'][property.name='body'] ~ *",
          message: "Only ui/root.ts may append to document.body.",
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["../*/features/*", "@/features/*"], message: "A feature must never import another feature — go through the event bus or a core service." },
          ],
        },
      ],
    },
  },

  // ── Bridge background-worker carve-out ─────────────────────────────────
  // manager.ts runs ONLY in the MV3 background worker (it opens the loopback
  // WebSocket a content script cannot), where the feature `ctx` — and thus
  // ctx.setInterval / ctx.setTimeout — does not exist; it owns its timer
  // handles by hand and clears them on teardown. Lift the ctx-timer globals ban
  // here (the chrome-parity ban stays). All other feature bans still apply.
  {
    files: ["src/features/claude-code-bridge/manager.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "chrome", message: "Use the `browser` import from wxt/browser." },
      ],
    },
  },
];
