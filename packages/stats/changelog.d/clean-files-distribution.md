### Fixes

- Remove `build.ts` and `tailwind.config.js` from the distribution files list. These are development tools and should not be included in published packages. This fixes SDK package smoke test failures when stats is packed as a local dependency.
