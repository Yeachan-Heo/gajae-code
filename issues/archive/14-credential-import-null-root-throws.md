# 14 — Credential import throws on a valid-JSON non-object (null) root instead of skipping it

- **Severity:** Medium (contract violation; degenerate trigger, but aborts the whole import flow)
- **Scope:** `packages/coding-agent/src/setup/credential-import.ts:161-172` (`parseClaudeCredentials`), `packages/coding-agent/src/setup/credential-import.ts:250-257` (`parseCodexAuth`)
- **Surface:** `gjc` setup credential import (PR #654 / commit 32578059)
- **Found by:** post-0.5.1 dogfood (G003), architect `2-ArchG003-SetupModelTheme`

## Summary

The module contract is explicit: *"Never throws for individual unreadable or
malformed sources — those land in `CredentialDiscoveryResult.skipped`."* The
parsers honor this for **unparseable** JSON (the `JSON.parse` try/catch), but
once `JSON.parse` succeeds they dereference the root without proving it is an
object:

```ts
// parseCodexAuth
parsed = JSON.parse(raw);        // succeeds for `null`
const tokens = parsed.tokens;    // null.tokens -> TypeError (uncaught here)
```

`parseClaudeCredentials` has the same shape (`parsed.claudeAiOauth`). The
`null`-guard at `typeof oauth !== "object" || oauth === null` only covers the
nested field, not the parsed root. The TypeError is not caught by the
`JSON.parse`-only try/catch, so it propagates out of `discoverCodex` /
`discoverClaudeCode` → `discoverExternalCredentials`, aborting discovery of
**all** sources.

## Reproduction (live, dev source)

`~/.codex/auth.json` (or `~/.claude/.credentials.json`) containing the literal
`null`:

```
codex auth.json = null   -> THREW: null is not an object (evaluating 'parsed.tokens')
codex auth.json = 42     -> OK; skipped: ["no OAuth tokens or OPENAI_API_KEY present (unsupported shape)"]
codex auth.json = ["x"]  -> OK; skipped: ["no OAuth tokens or OPENAI_API_KEY present (unsupported shape)"]
```

Only `null` crashes (number/array property access returns `undefined`); the
never-throw contract is still violated for that input.

## Impact

A credentials file that parses to `null` (e.g. a truncated/emptied file written
as `null`, or a tool that writes `null` on logout) crashes the entire setup
credential-import discovery instead of skipping that one source — defeating the
"import other valid sources independently" design.

## Suggested fix

In both parsers, after `JSON.parse`, reject a non-object root before
dereferencing:

```ts
if (typeof parsed !== "object" || parsed === null) {
  return { origin, source, reason: "unsupported shape (root is not an object)" };
}
```

Add negative tests for `null`, number, string, and array roots in
`credential-import.test.ts`.

## Resolution

**Resolved on current `dev`.** Both credential parsers reject non-object and array roots before dereferencing. The guards are present at `packages/coding-agent/src/setup/credential-import.ts:190-192` and `:291-293`.
