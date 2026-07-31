# 26 — Stage 12 residual defect inventory (46 failures, 23 suites)

- **Owner stage:** Stage 12 residual defect triage (durable goal G010)
- **Full-suite evidence:** `bun test packages/coding-agent/test` → 14559 pass, 397 skip,
  46 fail, 10 errors, 831695 expect() calls across 1209 files (1843s), exit 1.
- **Scope note:** the projection-read C54 defects are NOT in this inventory; they are
  owned by the Stage 4 goal. The app-server work of Stage 10/11 is green
  (`bun test packages/coding-agent/src/app-server/__tests__` → 524 pass / 0 fail) and
  the Stage-0b obligations verifier exits 0 with all five gates VERIFIED, so none of
  the failures below are app-server regressions.

## Dispositions established by isolation runs

Each group below was re-run on its own file to separate real defects from
full-parallel-run interference. Verified so far:

| Suite | Isolated result | Disposition |
| --- | --- | --- |
| `gjc-runtime/ultragoal-runtime.test.ts` | 175 pass / 0 fail | ORDER-DEPENDENT — passes alone; the 4 full-run failures are cross-test interference, not a product defect. Owner: test isolation. |
| `session-storage.test.ts` | 47 pass / 4 fail | FIX — reproducible path-security failures. Owner: session storage. |
| `sdk-workflow-gate-emitter.test.ts` | 19 pass / 3 fail | FIX — reproducible emitter/authority failures. Owner: SDK workflow gates. |
| `gjc-runtime/managed-owner-supervisor.test.ts` | 0 pass / 4 fail, `timed_out_waiting_for_child-ready` | ENVIRONMENT BLOCK — the sandbox denies the child spawn this supervisor needs (same limitation recorded in issue 23). Not silently skipped. |
| `session-manager-resume-readonly.test.ts` | 37 pass / 2 fail | FIX, owned by managed-session storage — detailed in issue 25. |
| `cli-command-surface.test.ts` | fixed here | FIXED — red→green receipt in issue 24. |
| `sdk-broker.test.ts` (named verified-delete defect) | 53 pass / 0 fail | Guarantee enforced; coverage proven load-bearing by mutation — issue 22. |

The remaining groups are recorded below with their exact commands and failing test
names. They have NOT yet been isolated one-by-one, so no disposition is claimed for
them: recording the exact repro is the deliverable, and inventing a classification
without an isolation run would be exactly the kind of unearned claim this stage
exists to prevent.

## Full inventory

### active managed picker root — 2 failing

- **Command:** `bun test packages/coding-agent/test/session-manager-resume-readonly.test.ts`
  - `rejects source identity drift at the final prepared migration receipt publication guard`
  - `fails closed at the final migration seam when captured managed authority is replaced`

### SDK ToolSession forwards getWorkflowGateEmitter — 4 failing

- **Command:** `bun test packages/coding-agent/test/sdk-workflow-gate-emitter.test.ts`
  - `makes the real ask tool emit a workflow_gate when an emitter is attached to the session`
  - `late-registers ask when a headless session receives a workflow gate emitter`
  - `provides a durable SDK-native emitter without extension injection`
  - `fences old workflow gates and remints authority after a session switch`

### HarnessCommand tmux-resident owner startup — 2 failing

- **Command:** `bun test packages/coding-agent/test/harness-tmux-owner.test.ts`
  - `proves a private tmux owner through the HarnessCommand path`
  - `preserves the direct detached-owner fallback when tmux is unavailable`

### non-TTY CLI startup — 1 failing

- **Command:** `bun test packages/coding-agent/test/launch-disposition.test.ts`
  - `routes a positional prompt without waiting for ignored stdin`

### ModelRegistry — 1 failing

- **Command:** `bun test packages/coding-agent/test/agent-session-auto-compaction-queue.test.ts`
  - `provider base URL environment variables > uses OPENAI_BASE_URL for bundled OpenAI models when models config has no baseUrl override`

### FileSessionStorageWriter path security — 4 failing

- **Command:** `bun test packages/coding-agent/test/session-storage.test.ts`
  - `does not truncate through an fd after same-fd security rejects a replacement`
  - `fails fsync when the live transcript name is replaced after writing`
  - `uses caller-fd security rather than pathname security for open writers`
  - `rejects terminal pathname or descriptor verification before dispatching close`

### Coding Agent Tools — 1 failing

- **Command:** `bun test packages/coding-agent/test/tools.test.ts`
  - `bash tool > keeps the structured timeout cause when command output says aborted`

### canonical SDK coordinator compatibility handler — 1 failing

- **Command:** `bun test packages/coding-agent/test/coordinator-mcp.test.ts`
  - `preserves mutation authorization and read-only artifact boundaries`

### perf corpus schema + runner — 2 failing

- **Command:** `bun test packages/coding-agent/test/perf-corpus.test.ts`
  - `prefers checked-out HEAD over workflow SHA provenance`
  - `resolves provenance from the benchmark checkout instead of the caller cwd`

### bare resume startup gating — 1 failing

- **Command:** `bun test packages/coding-agent/test/resume-confirm-continue.test.ts`
  - `keeps cancellation from loading settings or touching managed settings/config/agent storage`

### broker preserves host registration endpoint metadata across heartbeats — 1 failing

- **Command:** `bun test packages/coding-agent/test/sdk-broker-host-integration.test.ts`
  - `broker preserves host registration endpoint metadata across heartbeats`

### native GJC ultragoal runtime — 4 failing

- **Command:** `bun test packages/coding-agent/test/gjc-runtime/ultragoal-runtime.test.ts`
  - `hydrates a reviewed validation-batch final recovery and rejects stale, wrong, and multiple replacements`
  - `rejects protected replay records unrelated to asserted verification commands`
  - `requires a runtime-produced obligations verdict for protected completion and rejects missing, claimed, and stale results`
  - `evaluates GJC-package obligations from an unrelated protected goal cwd`

### managed owner supervisor — 4 failing

- **Command:** `bun test packages/coding-agent/test/gjc-runtime/managed-owner-supervisor.test.ts`
  - `records one exact durable SIGABRT receipt and exits with the abort status`
  - `does not mint a SIGABRT receipt for a normally exiting child`
  - `relays one SIGTERM to its exact child and waits for child cleanup`
  - `routes a replacement supervisor child through predecessor recovery before normal CLI`

### Ultragoal owner-loss recovery — 3 failing

- **Command:** `bun test packages/coding-agent/test/gjc-runtime/ultragoal-owner-loss-recovery.test.ts`
  - `resumes only from exact durable terminal JSONL, preserving dirty product files despite live sidecars`
  - `fails closed for stale identity, unrelated sessions, missing terminal output, corrupt rows, and conflicting yields`
  - `never resumes aborted, errored, unknown, or malformed terminal results`

### team worker memory guard wiring — 2 failing

- **Command:** `bun test packages/coding-agent/test/gjc-runtime/team-runtime.test.ts`
  - `selects the hottest Linux worker, checkpoints it, and syncs config and manifest on replacement`
  - `caps Linux replacement retries and blocks the claimed task on the terminal failure`

### stalled worker continuation protocol — 3 failing

- **Command:** `bun test packages/coding-agent/test/gjc-runtime/team-runtime.test.ts`
  - `fails closed when continuation inventory contains a non-canonical task or claim authority record`
  - `requires exactly one current claim and rejects shutdown, draining, lease, and pane authority gaps`
  - `holds every public authority-changing operation behind the monitor dispatch fence`

### tmux owner isolation launch gate — 1 failing

- **Command:** `bun test packages/coding-agent/test/gjc-runtime/launch-tmux.test.ts`
  - `propagates only an exact durable SIGABRT predecessor token into a replacement launch`

### managed owner admission — 2 failing

- **Command:** `bun test packages/coding-agent/test/gjc-runtime/managed-owner-admission.test.ts`
  - `admits only the exact token binding for the current session and generation`
  - `turns a recovery admission into a durable terminal handoff without changing B0 or dirty files`

### offline stealth benchmark (integration) — 1 failing

- **Command:** `bun test packages/coding-agent/test/tools/browser-benchmark-suite.integration.test.ts`
  - `runs the stealth browser against the offline detector and records a baseline + report`

### imageGenTool — 2 failing

- **Command:** `bun test packages/coding-agent/test/tools/image-gen.test.ts`
  - `e2e writes OpenAI Responses image_generation WebP output to a temp file`
  - `uses OPENAI_BASE_URL for OpenAI image generation when active model still has the default OpenAI URL`

### SessionManager session ids — 2 failing

- **Command:** `bun test packages/coding-agent/test/session-manager/session-id.test.ts`
  - `rolls back fork identity before publishing a transcript when artifact import fails`
  - `removes published fork artifacts when transcript publication fails`

### MCP transport lifecycle red-team regressions — 1 failing

- **Command:** `bun test packages/coding-agent/test/runtime-mcp/transport-lifecycle.redteam.test.ts`
  - `disconnectServer during reconnect backoff prevents late reconnect and new child spawn`

### EventController completion viewport — 1 failing

- **Command:** `bun test packages/coding-agent/test/modes/controllers/event-controller-completion-viewport.test.ts`
  - `preserves manual transcript rows through real completion lifecycle on supported terminal hosts`

