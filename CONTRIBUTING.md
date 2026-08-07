# Contributing to Gajae-Code
Maintainers and their access are listed in [MAINTAINERS.md](./MAINTAINERS.md).

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

Resolving one of these by emptying the file is a real hazard, not a hypothetical: ten pull requests across six authors did exactly that within ten minutes of the merge driver being removed, each leaving a one-byte changelog with every released section gone. CI now fails a PR that removes any `## [X.Y.Z]` heading (`scripts/changelog-history-guard.ts`), but check before you push:

```sh
git cat-file -s HEAD:packages/coding-agent/CHANGELOG.md   # expect ~300 KB, not 1
```

If it is already lost, recover with `git checkout origin/dev -- packages/<pkg>/CHANGELOG.md` and re-add only your own entry.

**`packages/coding-agent/src/internal-urls/docs-index.generated.ts` is generated and untracked.** `bun install` rebuilds it through the root `prepare` hook, and `bun run generate-docs-index` rebuilds it on demand. Do not commit it. If you see it in `git status`, something forced it back into the index — `git rm --cached` it. A tracked copy inlines every doc onto a single line, which git cannot three-way merge, so it conflicts on every rebase.

## Nightly release operations

The `CI` workflow publishes a scheduled nightly prerelease from `main` at 04:23 UTC. Maintainers can run the same cycle with **Run workflow → nightly-release**, but manual dispatches must select the `dev` branch: the workflow's `release_metadata` gate rejects manual nightlies from `main` or any other ref. The run must pass the complete dev check/test graph before publication, then publishes all public packages under the npm `nightly` dist-tag and creates a matching immutable GitHub prerelease with binaries and package-evidence assets. Do not create or move nightly tags manually, and do not edit package versions or `[Unreleased]` changelog sections for a nightly run; version staging is ephemeral inside CI.

## PR checklist

- Target branch is `dev`, not `main`.
- The PR description explains what changed and why.
- Relevant focused tests or checks are listed in the PR description.
- User-facing changes include a changelog entry when appropriate.
