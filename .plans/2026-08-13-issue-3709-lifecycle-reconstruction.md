# Issue #3709 lifecycle reconstruction record

- **Recorded:** 2026-08-13T08:41:31Z
- **Issue:** [#3709](https://github.com/Yeachan-Heo/gajae-code/issues/3709), `OPEN`
- **Lifecycle owner branch:** `owner/issue-3709-lifecycle`
- **Scope:** coordination only; this branch does not carry implementation changes for #3731.

## Linked implementation lane

| Field | Verified value |
| --- | --- |
| Pull request | [#3731](https://github.com/Yeachan-Heo/gajae-code/pull/3731) |
| Branch | `feat/codex-session-import-redo` |
| State | `OPEN` draft |
| Head | `5ca3abd09eb50aee2b02bafdcfc989d570c8321b` |
| Base | `dev` at `12e1df1724bec0b7b1a40988cdc2a0c7dcca29ec` |
| Review | `CHANGES_REQUESTED` |
| Merge state | `UNSTABLE` / mergeable |
| Active implementation owner | `gajae-code-pr-3731-session-import` |

## Acceptance reconciliation

#3731 is the sole active remediation lane but does not currently satisfy #3709. Its changed public implementation and tests are Codex-only. No Claude/Anthropic importer, deterministic Claude fixture coverage, or provider-neutral selection/detection proof is present, while #3709 requires both Codex and Claude export/transcript import through a provider-neutral interface.

The exact-head Dev CI run `31680638439` is also red: `Affected path validation` and `Affected path validation / evidence producer` failed; the aggregate is fail-closed on producer/live-dependency results.

## GitHub receipt

A signed lifecycle coordination comment was posted and read back:

- https://github.com/Yeachan-Heo/gajae-code/issues/3709#issuecomment-5278046986
- Comment ID: `5278046986`
- Footer validation: exact required `gaebal-gajae` footer present.
- Content validation: the exact #3731 head, base, active owner, failed validation blockers, Claude/provider-neutral gap, and terminal condition are present.

## Terminal condition

Keep #3709 open only while #3731 remains open and actively remediates the complete acceptance contract. Verify merged `dev` against the full contract before closing #3709. If #3731 is terminally closed or rejected without satisfying it, immediately create a narrowly scoped successor with a dedicated owner only where the standing acceptance still requires delivery; otherwise close #3709 as superseded or non-deliverable with evidence. No parallel implementation lane is authorized.

## Validation performed

```text
gh pr view 3731 --json state,isDraft,headRefOid,baseRefName,baseRefOid,reviewDecision,mergeStateStatus,mergedAt,closedAt
gh pr checks 3731 --json name,state,link,workflow --watch=false
gh api repos/Yeachan-Heo/gajae-code/issues/comments/5278046986
gh api receipt footer/content predicates
```
