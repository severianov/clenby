## What

A short description of the change and the user-visible behavior.

## Why

Link the issue this addresses, or explain the motivation.

## How

Anything a reviewer should know about the approach.

## Checklist

- [ ] `npx tsc --noEmit` passes
- [ ] `yarn build` passes
- [ ] `yarn test` passes (and a test was added where it made sense)
- [ ] Follows the conventions in [CONTRIBUTING.md](../CONTRIBUTING.md)
      (managed resources via `ctx`, own-UI only, `--cc-*` tokens, registry
      selectors, no new permissions)
- [ ] Tested on Chrome (and Firefox, if manifest/API-adjacent)
- [ ] Screenshots attached for UI changes
- [ ] `CHANGELOG.md` updated under `[Unreleased]`
