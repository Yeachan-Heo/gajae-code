---
name: gjc-sdk-author
description: Author trusted local TypeScript and Python scripts that use direct GJC SDK v3 endpoints safely.
---

# Author direct GJC SDK scripts

Start from the owned templates in this skill directory:

- `templates/direct-sdk.ts`
- `templates/direct-sdk.py`

## Authoring contract

- Use the maintained TypeScript or Python SDK client; do not reimplement the WebSocket protocol.
- Accept repository and session ID as non-secret inputs.
- Resolve endpoint credentials at runtime from the selected local session.
- Fail closed when discovery is missing, stale, dead, unknown, symlinked, or ambiguous.
- Never accept a token as the default CLI interface.
- Never print, serialize, persist, cache, or embed endpoint tokens.
- Keep query and control operation names on fixed allowlists.
- Require an immediately preceding, single-use human approval before mutation.
- Use the template's nonce-bearing operation/session/input-bound standard-input challenge; never replace it with a free boolean or reusable approval.
- Send no SDK request after denial or cancellation.
- Bind durable workflow controls to the expected session ID.
- Redact secret-shaped keys from all rendered results.
- Close clients in `finally` blocks.
- State that these are trusted local procedural controls, not capability isolation.

Generated user scripts belong in the user's workspace. Only the two canonical templates are owned by this clean-generated bundle.
