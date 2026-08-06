# Contributing to Gajae-Code

Thanks for contributing. This guide is intentionally short so pull requests land on the right branch with enough context to review.

## Branch policy

Open pull requests against `dev`.

Do not target `main` unless a maintainer explicitly asks you to. `main` is reserved for maintainer-directed release flow, so PRs opened against `main` may be closed and asked to reopen against `dev`.

## Local setup

This repository uses Bun workspaces.

```sh
bun install
bun run dev:doctor
```

To run Gajae-Code from the checkout:

```sh
bun run dev
```

## Focused tests

Run the smallest command that covers your change before opening a PR. Common options are:

```sh
bun test path/to/file.test.ts
bun run check:tools
bun run check
```

Use focused tests first for code changes, then broader checks when the change affects shared behavior or release-critical paths.

## Rebasing onto `dev`

`dev` moves often, so expect to rebase. Two files behave in ways worth knowing about up front.

**`packages/*/CHANGELOG.md` conflicts are normal.** These files have no custom merge driver: if your branch and `dev` both added entries under `## [Unreleased]`, git reports a real conflict. Resolve it by keeping **both** entries under `## [Unreleased]`. Never move an entry into a released `## [X.Y.Z]` section, and never edit a released section — that version already shipped and its notes are historical record.

**`packages/coding-agent/src/internal-urls/docs-index.generated.ts` is generated and untracked.** `bun install` rebuilds it through the root `prepare` hook, and `bun run generate-docs-index` rebuilds it on demand. Do not commit it. If you see it in `git status`, something forced it back into the index — `git rm --cached` it. A tracked copy inlines every doc onto a single line, which git cannot three-way merge, so it conflicts on every rebase.

## PR checklist

- Target branch is `dev`, not `main`.
- The PR description explains what changed and why.
- Relevant focused tests or checks are listed in the PR description.
- User-facing changes include a changelog entry when appropriate.
