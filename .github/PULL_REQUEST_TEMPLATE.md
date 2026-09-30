## What

<!-- Brief description of the change -->

## Why

<!-- Motivation, context, or link to issue (fixes #N) -->

## Testing

<!-- How was this tested? -->

## Approval

Merges to `dev` require one approving GitHub review from a write-access maintainer on the current head. Agent reviews (`architect`/`critic`) are advisory comments.

---

- [ ] Target branch is `dev`
- [ ] `bun check` passes
- [ ] Tested locally
- [ ] Changelog fragment added under `packages/<pkg>/changelog.d/` (if user-facing)
- [ ] Human approval or the required agent/owner verdict matches the exact PR head, not an earlier commit
- [ ] Risk classification above matches the actual review path taken
