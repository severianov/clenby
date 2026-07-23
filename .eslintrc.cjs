/**
 * ESLint config — the project's structural bans expressed as lint rules. Each
 * one maps to a real bug class in a content-script extension of this shape.
 *
 * Note: `eslint` and `@typescript-eslint/*` are not yet in devDependencies (the
 * zero-runtime-dep rule is about the *shipped bundle*; dev tooling is separate).
 * Add them when wiring CI:
 *   npm i -D eslint @typescript-eslint/parser @typescript-eslint/eslint-plugin
 * The rules below are authored now so the contract is on disk from day one.
 */
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: { ecmaVersion: 2022, sourceType: "module" },
  plugins: ["@typescript-eslint"],
  env: { browser: true, es2022: true },
  ignorePatterns: ["node_modules/", ".output/", ".wxt/", "*.cjs"],
  rules: {
    // `browser` from WXT only; no chrome.* literals (Chrome/Firefox parity).
    "no-restricted-globals": [
      "error",
      { name: "chrome", message: "Use the unified `browser` import from wxt/browser (Chrome/Firefox parity)." },
    ],
  },
  overrides: [
    {
      // Features never touch global timer/observer/listener APIs. Only the
      // managed ctx.* variants, which auto-dispose at unmount.
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
        // Selectors/keys/endpoints come from their one home, never inline.
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
    {
      // Inline color/font/background/border on companion elements is a defect.
      // Geometry-only inline styles go through ui setGeometry(). (Enforced in review;
      // the regexes here catch the obvious offenders.)
      files: ["src/**/*.ts"],
      excludedFiles: ["src/core/**", "src/theme/**"],
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
  ],
};
