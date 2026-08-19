## What

<!-- Brief description of the change -->

## Why

<!-- Motivation, context, or link to issue (fixes #N) -->

## Testing

<!-- How was this tested? -->

## Risk classification

<!-- Classify honestly; the exact-head gate enforces the matching review path (issue #4703). -->

- [ ] `low-risk` — ordinary fix/maintenance; signed maintainer self-review comment + CI suffices.
- [ ] `regression-risk` — fix with material regression risk; additionally requires an exact-head `gpt-heavy` profile validation/review with recorded evidence **or** one assigned independent domain reviewer (`extra:gpt-heavy` / `extra:independent:<login>`).
- [ ] `high-risk` — large refactor, feature, or materially high-risk change (security/auth/install/remove/public API/destructive lifecycle/architecture); requires one assigned independent domain reviewer (`extra:independent:<login>`).

## GJC verdict

<!-- Paste one exact-head verdict. reviewer-id is the reviewer's GitHub login. For owner-authored maintainer PRs the reviewer-id may equal the PR author when a signed gajae.pr-self-review.v1 comment for the exact head exists; otherwise self-approval is BLOCK. If neither an authenticated approving GitHub review for this exact head nor a valid self-review comment exists, write needs-human and stop. -->

```text
gajae.pr-review-verdict.v1 <merge-approved|merge-blocked|needs-human> sha256:<exact-base...head-diff-hash> reviewer:<architect|critic|human> reviewer-id:<identity> evidence:<ci-run-url-or-local-command>
```

---

- [ ] Target branch is `dev`
- [ ] `bun check` passes
- [ ] Tested locally
- [ ] CHANGELOG updated (if user-facing)
- [ ] Verdict above matches the exact PR head, not an earlier commit
- [ ] Risk classification above matches the actual review path taken
