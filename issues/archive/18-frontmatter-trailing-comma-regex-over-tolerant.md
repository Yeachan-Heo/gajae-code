# 18 — Frontmatter trailing-comma fallback strips commas from non-scalar lines (over-tolerant)

- **Severity:** Low (can accept malformed non-scalar YAML after strict parse fails)
- **Scope:** `packages/utils/src/frontmatter.ts:9-16` (`stripLooseScalarTrailingCommas` regex)
- **Surface:** frontmatter parsing for skills/agents/specs (PR #608 / commit 711ae73d)
- **Found by:** post-0.5.1 dogfood (G002), architect `1-ArchG002-StateSession`

## Summary

PR #608 is correct on the important axes (dogfood-confirmed): the loose pass
only runs as a fallback *after* strict `YAML.parse` throws; if the loose retry
still fails the **original** strict error is rethrown; and inner commas inside
quoted values are preserved (only a terminal comma is removed).

The remaining gap is breadth: the regex

```ts
line.match(/^(\s*[\w-]+\s*:\s+.+),(\s*)$/)
```

strips a terminal comma from *any* one-line `key: value` whose value ends in a
comma — including flow-collection or block-indicator values, not just scalar
("Cursor-style quoted scalar") values. After a strict failure, a malformed
non-scalar line could be coerced into a parse instead of surfacing the real
error.

## Impact

Low: genuine metadata mistakes in non-scalar values may be silently accepted
rather than reported. No crash; no data loss. Narrowing the tolerance keeps the
intended Cursor-compat fix while not masking real YAML errors.

## Suggested fix

Restrict stripping to quoted or plain scalar-shaped values (skip lines whose
value begins with a flow indicator `[`/`{` or a block indicator `|`/`>`). Add
negative tests for flow collections and block scalars with trailing commas.

## Resolution

**Resolved on current `dev`.** The loose fallback skips values beginning with flow or block indicators (`[`, `{`, `|`, `>`), while preserving the intended scalar trailing-comma compatibility behavior.
