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

## Exact-head PR verdict gate

Every pull request to `dev` must keep exactly one `gajae.pr-review-verdict.v1` line from the pull request template. The `PR contract / Validate exact-head PR contract` status is produced by a narrowly scoped `pull_request_target` workflow loaded from the trusted default branch. It has read-only permissions, receives no secrets, consumes no caches or artifacts, and executes only the base-owned validator while inspecting the event's immutable base and exact head. The validator recomputes the binary diff digest, requires the head to contain the base, runs the fast GJC state-writer scan against the PR-head bytes, and rejects self-approved `merge-approved` verdicts unless a valid signed maintainer self-review comment backs them (below). `needs-human` and `merge-blocked` are valid review states but intentionally keep the status red until an independent reviewer records `merge-approved` for the current head or a valid self-review comment is posted.

### Risk-classified review policy (issue #4703, final owner decision)

The review requirement is classified by the change's real risk; not every fix is low risk, and routine fixes are not burdened with mandatory independent review.

- **Low-risk fix / ordinary maintenance** — a signed `gajae.pr-self-review.v1` exact-head maintainer self-review comment plus green CI is sufficient to merge. The comment must be posted by the delegated maintainer identity (gaebal-gajae operating the owner account) and bound to the exact base, head, and diff digest.
- **Fix with material regression risk** — the signed self-review comment must additionally record **either** (a) an exact-head `gpt-heavy` profile validation/review with recorded evidence, **or** (b) one assigned independent domain reviewer selected from recent merged PR/commit ownership and demonstrated expertise in the touched files/contracts, whose authenticated exact-head `APPROVED` GitHub review the validator verifies (the `extra:independent:<login>` token alone is never sufficient). This OR gate is mandatory; a risk-classified fix cannot pass with `extra:none`.
- **Large refactors, features, and materially high-risk changes** (security, auth, install, remove, public API, destructive lifecycle, architecture) — exactly one assigned independent domain reviewer is required, selected the same way (recent merged ownership plus demonstrated expertise in the touched surface) and verified the same way (authenticated exact-head `APPROVED` review with write+ permission), not two-person review and not a static hardcoded reviewer.

External contributor PRs continue to require an ordinary authenticated GitHub `APPROVED` review from a repository maintainer; the self-review comment path exists only for owner-authored maintainer PRs.

### Maintainer self-review comment format

For an owner-authored maintainer PR, post the exact-head self-review as a **PR comment** (never in the PR body — body text cannot authorize anything):

```text
gajae.pr-self-review.v1 verdict:merge-approved base:<40-hex event base> head:<40-hex exact head> sha256:<64-hex base...head diff digest> reviewer-id:<PR author login> risk:<low-risk|regression-risk|high-risk> extra:<none|gpt-heavy|independent:<login>> evidence:<review evidence>
self-review-signature: sha256:<signature over the record above>
Signed-off-by: gaebal-gajae (clawdbot) 🦞
```

The signature is `sha256("gajae.pr-self-review.v1.signature-domain" + canonical record lines)`; generate it with `bun scripts/verify-pr-verdict.ts --self-review-sign <base> <head> <digest> <reviewer-id> <risk> <extra> <evidence>`. The validator accepts the comment only when all of the following hold; otherwise it fails closed:

- the comment is fetched through the trusted workflow token from the GitHub issue-comments API (comment bytes are data; head-controlled code is never executed);
- the comment is fetched through the trusted workflow token from the GitHub issue-comments API (comment bytes are data; head-controlled code is never executed); only comments from the PR author are eligible, every page is scanned and the **newest** record wins, and any API failure fails closed;
- the comment author is exactly the **repository owner account** (`author_association: OWNER`, the delegated maintainer identity gaebal-gajae operates) and matches `reviewer-id`, which must equal the PR author; members and collaborators cannot use the self-review path;
- the PR-body verdict's `reviewer-id` equals the validated self-review identity, so the comment cannot authorize a different reviewer than the body names;
- base, head, and digest match the immutable event base, the exact PR head, and the recomputed `base...head` diff digest (stale values never authorize a newer head);
- the signature verifies over the exact canonical record, so any post-hoc edit of verdict, head, digest, risk, extra, or evidence invalidates the comment;
- the risk classification matches the PR body's checked risk classification, and satisfies the policy gate above (`low-risk` + `extra:none`; `regression-risk` + `extra:gpt-heavy` or `extra:independent:<login>`; `high-risk` + `extra:independent:<login>`);
- `extra:independent:<login>` is only honored when that login is a distinct maintainer (not the PR author) with admin/maintain/write permission **and** an authenticated exact-head `APPROVED` GitHub review — the token shape alone never satisfies the gate.

Comment events (`issue_comment: [created, edited, deleted]`) re-run the trusted-base validator, so posting, editing, or deleting the self-review comment re-evaluates the contract server-side; deleting the sole authorizing comment revokes the authorization on the exact head. Editing a comment invalidates its signature only when a bound field changed; editing is still safe because every field is re-verified against the immutable event data.

Comment-triggered validation is head-bound: `issue_comment` runs associate with the default-branch SHA, so the workflow additionally publishes a commit status named `PR contract (self-review)` on the resolved exact PR head. Authorization and revocation (comment created/edited/deleted) are therefore durable and visible on the head commit itself; a trusted base that predates the self-review-aware validator never publishes success. Because `issue_comment` workflows only trigger from the repository default branch (`main`), the comment path activates when this workflow definition reaches `main` — until then the Dev CI `PR contract bootstrap` job (a `pull_request` event, natively head-bound) remains the authoritative gate, which is how the introducing PR itself is validated.

The first PR that introduces this workflow uses a trusted two-phase bootstrap. Phase 1 landed `Dev CI / PR contract bootstrap` directly on `dev`, so its inline validation exists in the immutable event base before the implementation PR is evaluated. Phase 2 enables the isolated `PR contract` consumer in this implementation PR. Review events run only that cheap, read-only contract workflow; they never launch or cancel the affected Dev CI pipeline. The validator still executes exclusively from the immutable event-base checkout and treats PR-head bytes as data. The same bootstrap ordering applies to the self-review comment path: a PR whose immutable base predates the comment-aware validator cannot be authorized by a self-review comment on that base; the introducing PR relies on the Dev CI bootstrap job and merges before the comment path becomes active for later PRs.

After the final commit and rebase, compute the digest with:

```sh
git fetch origin dev
git merge-base --is-ancestor origin/dev HEAD
git diff --binary --full-index --no-ext-diff origin/dev...HEAD | sha256sum
bun scripts/verify-gjc-state-writers.ts --fail
```

The verdict line must use the resulting lowercase digest and name the GitHub reviewer whose effective `APPROVED` review targets the exact PR head, or the PR author when a valid signed self-review comment exists:

```text
gajae.pr-review-verdict.v1 merge-approved sha256:<64-hex-digest> reviewer:<architect|critic|human> reviewer-id:<identity> evidence:<review-or-CI-reference>
```

GJC users can opt into fast feedback before `gh pr create` by copying `docs/examples/gjc-hooks/pre/bash.ts` to this checkout's `.gjc/hooks/pre/bash.ts`. Keep the hook project-local: installing it under `~/.gjc/agent` would incorrectly impose this repository's policy on unrelated repositories. The local hook is advisory and bypassable; the server-side status check is authoritative and covers humans and other runtimes.
