# Contributing to Gajae-Code

This guide is based on the repository contract in `AGENTS.md` and on PRs that were merged or sent back for changes in `Yeachan-Heo/gajae-code` through 2026-06-30. The maintainer tends to merge PRs that are narrow, adversarially verified, and explicit about the exact user-facing contract they change.

## What maintainers seem to merge quickly

The strongest merged PRs share the same shape:

- They fix one concrete problem and keep the diff focused. Good examples include [#1306](https://github.com/Yeachan-Heo/gajae-code/pull/1306), [#1302](https://github.com/Yeachan-Heo/gajae-code/pull/1302), and [#1164](https://github.com/Yeachan-Heo/gajae-code/pull/1164).
- They explain the problem, root cause, fix, and verification in the PR body. Larger changes such as [#1300](https://github.com/Yeachan-Heo/gajae-code/pull/1300) and [#1166](https://github.com/Yeachan-Heo/gajae-code/pull/1166) used explicit validation lists rather than vague confidence claims.
- They add a regression test for the actual failure path, not just a nearby happy path. [#1303](https://github.com/Yeachan-Heo/gajae-code/pull/1303) was accepted after it proved the exact Windows/psmux registration-race path that blocked [#1282](https://github.com/Yeachan-Heo/gajae-code/pull/1282).
- They address prior review blockers directly. Accepted follow-ups usually name the previous PR or issue, describe the blocker, and state how the new diff prevents it.
- They update all tool/runtime contract surfaces when exposing behavior. [#827](https://github.com/Yeachan-Heo/gajae-code/pull/827) was accepted after the goal pause lifecycle blocker was fixed at the runtime boundary and the tool, SDK, renderer, prompts, changelog, and regression tests agreed.
- They call out known baseline failures honestly and explain why they are unrelated. Do not hide failures or treat a partially failing suite as green.
- They update every exposed contract surface touched by the change: code, tests, prompts, docs, changelog, CLI routing, generated docs, install smokes, and default-surface gates where applicable.

## What gets sent back

Maintainer reviews are adversarial. Green CI is not enough when the changed behavior is still wrong in a realistic path.

- Unreachable or late failure handling gets blocked. [#1282](https://github.com/Yeachan-Heo/gajae-code/pull/1282) had green checks, but the retry path was ordered after an earlier profile-tagging failure path.
- UI changes get blocked if the visible state is stale. [#1297](https://github.com/Yeachan-Heo/gajae-code/pull/1297) removed duplicate previews but initially left the parent preview text without a refresh path.
- User-controlled strings must be safe in the exact target surface. [#1304](https://github.com/Yeachan-Heo/gajae-code/pull/1304) was blocked until tmux format metacharacters were escaped for `set-titles-string`.
- Workflow or default-surface changes need contract consistency. [#113](https://github.com/Yeachan-Heo/gajae-code/pull/113) showed that docs, comments, tests, and actual caller paths must agree before merge.
- Stale prompt or docs guidance is a blocker when surfaces are removed or renamed. [#922](https://github.com/Yeachan-Heo/gajae-code/pull/922) needed prompt/docs cleanup before the four role-agent surface was considered coherent.

## Before opening a PR

Start with the smallest faithful fix. If the bug is broad, split the PR so each branch has one reviewable contract.

For code changes:

- Read the surrounding implementation and tests before editing.
- Add a failing regression first when the change fixes behavior.
- Prefer focused tests over broad snapshots or tautological assertions.
- Use Bun commands. Do not run `tsc` or `npx tsc`; use `bun check`, `bun run check:ts`, or the package scripts.
- Do not use `any`, `ReturnType<>`, inline imports, or dynamic type imports.
- In `packages/coding-agent/`, do not use `console.log`, `console.warn`, or `console.error`; use the centralized logger.
- Keep prompts in static Markdown files imported as text. Do not build prompt bodies inline in TypeScript.

For documentation-only changes:

- Verify links, commands, and public names against the current repository.
- Avoid documenting extra default workflow skills or role agents. The public default surface is four workflow skills and four bundled role agents.
- If docs mention behavior, include the command or file that proves it is still true.

## Required checks

Run the smallest checks that prove your change first, then broaden only as the touched surface requires.

Common focused checks:

```sh
bun test <focused-test-file>
bun --cwd=packages/coding-agent run check
bun run check:ts
git diff --check
```

Workflow-definition, default-surface, or rebrand-related changes must also run:

```sh
bun scripts/check-visible-definitions.ts
bun scripts/verify-g002-gates.ts
bun scripts/rebrand-inventory.ts --strict
bun test packages/coding-agent/test/default-gjc-definitions.test.ts
```

Model catalog changes must not edit `packages/ai/src/models.json` directly. Change the generator, descriptors, or resolvers, then regenerate:

```sh
bun --cwd=packages/ai run generate-models
```

Native, package, install, or release-path changes usually need package-specific tests, dry runs, and install smokes. PR [#1300](https://github.com/Yeachan-Heo/gajae-code/pull/1300) is a good reference for the expected level of release/install validation.

## PR body template

Use this shape unless the change is trivial:

```md
## Summary
- What changed.
- Why this is the smallest correct fix.

## Problem / Root cause
- The observable failure.
- The specific code path or contract that caused it.

## Fix
- The implementation decision.
- How it handles the risky edge case.

## Regression coverage
- The test that would fail before this PR.
- The exact path it proves.

## Verification
- `bun test ...`
- `bun --cwd=packages/<pkg> run check`
- Any manual smoke or real-surface check.

## Notes
- Known unrelated failures, if any, with evidence.
- Out-of-scope follow-ups that should not block this PR.
```

## Changelog and docs

Package changelogs live at `packages/*/CHANGELOG.md`. Add user-facing changes under `## [Unreleased]` and do not edit released sections.

Update docs when the public CLI, workflow surface, install path, user-visible behavior, or prompt contract changes. If you touch generated docs or indexes, explain how they were regenerated.

## Branch hygiene

- Target `dev` for PRs. Do not open contribution PRs against `main` unless the maintainer explicitly asks for it.
- Rebase or update against current upstream before review when the base has moved.
- Keep unrelated local notes, generated artifacts, and worktree churn out of the PR.
- Do not commit repo-visible `.gjc` default definitions. Runtime state, plans, specs, and workflow ledgers belong under `.gjc/`.
- Do not commit unless the maintainer asked you to commit from this worktree.

## Review expectations

Expect review to check:

- exact head and base branch,
- merge state and CI status,
- whether the diff is scoped,
- whether the failure path is actually covered,
- whether visible UI/CLI state matches the claimed behavior,
- whether public names use `gjc` and `.gjc`,
- whether removed or renamed surfaces still appear in prompts, docs, tests, or generated indexes,
- whether baseline failures are honestly separated from regressions.

If review requests changes, open a corrected follow-up or update the branch with a direct blocker fix. The PR body should name the blocker and the new proof that it is fixed.
