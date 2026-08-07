# Conflict-store fixture

The conflict resolver tests keep fixture claims inline so the fixture remains text-only and deterministic. This directory documents the shape used by those tests; it does not contain generated or binary content.

A fixture store is represented as an array of `MemoryClaim` values:

```ts
{
  claimKey: "constraint.deploy",
  text: "deploy only after review",
  type: "constraint",
  authority: "repository-reviewed",
  freshness: "2026-07-29T11:00:00.000Z",
  volatility: "stable",
  source: {
    uri: "global://fixture/review",
    scope: "global",
    relPath: "global/review.md",
    heading: "Deploy",
    startLine: 1,
    endLine: 3,
    authority: "repository-reviewed",
    volatility: "stable",
    updatedAt: "2026-07-29T11:00:00.000Z",
    digest: "fixture-digest"
  }
}
```

Multiple claims with the same `claimKey` form one conflict group. Claims with the same normalized `text` are agreement duplicates; distinct values exercise the authority, scope-specificity, freshness, volatility, and per-document-type rules. Decision cases may add inline `status`, `active`, `id`, or `supersedes` metadata to model active decisions and predecessor links without changing the public `MemoryClaim` shape.

The resolver receives an injected strict-UTC `asOf` value, never reads this directory, and returns one `ConflictResult` per normalized claim key. Every result contains deterministic explanations for all four dimensions and a UTF-8 ordered `rejected` list.
