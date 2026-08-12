---
name: gjc-sdk-author
description: Author trusted-local TypeScript and Python scripts that operate GJC sessions through the broker-bound CLI.
---

# Author broker-bound GJC session scripts

Start from the owned templates in this skill directory:

- `templates/direct-sdk.ts`
- `templates/direct-sdk.py`

## Authoring contract

- Invoke the documented `gjc sdk session` CLI as a child process. It routes live controls through `SessionRouter` and lifecycle mutations through `SessionLifecycleService` and the Broker.
- Require explicit repository and session-ID inputs. Run the CLI with the repository as its working directory; do not infer a session from local state.
- Never scan `.gjc/state/sdk`, parse endpoint records, read endpoint credentials, or open a raw per-session WebSocket.
- Use only `gjc sdk session raw query <sessionId> --query <query>` for fixed inspection queries and `gjc sdk session raw control <sessionId> --op <operation> --json-input <object> --confirm` for fixed controls.
- Pass CLI arguments as an argv array, never through a shell command string.
- Keep query and control operation names on fixed allowlists. Reject secret-shaped input fields before dispatch.
- Require an immediately preceding, single-use human approval before every mutation.
- Use the template's nonce-bearing operation/session/input-bound standard-input challenge; never replace it with a free boolean or reusable approval.
- Send no CLI request after denial or cancellation.
- Bind durable workflow controls to the expected session ID.
- Render only parsed, redacted CLI JSON. Discard raw CLI stderr and never render credentials.
- Keep broader lifecycle orchestration behind `gjc sdk session raw global` with a stable idempotency key or an SDK-core lifecycle facade; the canonical templates do not invent lifecycle routing.
- State that approval is a trusted-local procedural safeguard, not capability isolation; Broker and Router retain attachment authority.

Generated user scripts belong in the user's workspace. Only the two canonical templates are owned by this clean-generated bundle.
