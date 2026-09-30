### Fixed

- Restored TypeScript/TSX highlighting speed: `ts`/`tsx` go back to syntect's JavaScript grammar instead of the pinned upstream TypeScript grammars, which made first-use syntax loading ~60x slower (~600ms) and each TypeScript highlight ~3x slower (diff rendering 48ms → 160ms on an 86-hunk edit). Astro frontmatter and expressions now embed the JavaScript grammar.
