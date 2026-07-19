# Codex bridge delegate auto-bind RED evidence

## T3 — origin round-trip and non-overwrite

Command:

```text
bun test /Users/probe/git/probepark/gajae-code/packages/coding-agent/test/coordinator-codex-handoff.test.ts
```

Verbatim RED output:

```text
bun test v1.3.14 (d1632b29)

packages/coding-agent/test/coordinator-codex-handoff.test.ts:

# Unhandled error between tests
-------------------------------
SyntaxError: Export named 'bindDelegateCodexHandoff' not found in module '/Users/probe/git/probepark/gajae-code/packages/coding-agent/src/coordinator-mcp/codex-handoff.ts'.
-------------------------------


 0 pass
 1 fail
 1 error
Ran 1 test across 1 file. [19.00ms]
```

## T1 — concurrent delegate auto-binding

Command:

```text
bun test /Users/probe/git/probepark/gajae-code/packages/coding-agent/test/coordinator-mcp-server.test.ts --test-name-pattern 'auto-binds concurrent'
```

Verbatim RED output excerpt (the received delegate responses contain no `codex_handoff` field):

```text
error: expect(received).toEqual(expected)
...
(fail) Coordinator MCP canonical SDK controls > auto-binds concurrent delegated sessions to the newest host Codex handoff [142.39ms]

 0 pass
 54 filtered out
 1 fail
 1 expect() calls
Ran 1 test across 1 file. [257.00ms]
```

## GREEN

```text
bun test /Users/probe/git/probepark/gajae-code/packages/coding-agent/test/coordinator-mcp-server.test.ts --test-name-pattern 'auto-binds concurrent|skips ambiguous'

 2 pass
 54 filtered out
 0 fail
 7 expect() calls
Ran 2 tests across 1 file. [278.00ms]

bun test /Users/probe/git/probepark/gajae-code/packages/coding-agent/test/coordinator-codex-handoff.test.ts

 7 pass
 0 fail
 24 expect() calls
Ran 7 tests across 1 file. [176.00ms]

bun test /Users/probe/git/probepark/gajae-code/packages/coding-agent/test/coordinator-mcp-server.test.ts /Users/probe/git/probepark/gajae-code/packages/coding-agent/test/coordinator-codex-handoff.test.ts /Users/probe/git/probepark/gajae-code/packages/coding-agent/test/coordinator-codex-bridge.test.ts /Users/probe/git/probepark/gajae-code/packages/coding-agent/test/coordinator-codex-wake-publisher.test.ts /Users/probe/git/probepark/gajae-code/packages/coding-agent/test/coordinator-codex-bridge-redteam.test.ts /Users/probe/git/probepark/gajae-code/packages/coding-agent/test/mcp-delegate-host-context.test.ts

 95 pass
 0 fail
 454 expect() calls
Ran 95 tests across 6 files. [7.40s]
```

## T2 — bound ask isolation for parallel delegations (harness note)

The SDK-control harness routes Q12 gate queries per server without session identity,
so two per-session pending gates cannot coexist in one harness server. Coverage is
therefore split, as permitted by the assignment:
- auto-binding of two concurrent delegate sessions within ONE namespace/root:
  `auto-binds concurrent delegated sessions to the newest host Codex handoff`
- shared-thread wake recording/serialization for those auto-bound sessions:
  `records and serializes wakes for auto-bound delegate sessions sharing one Codex thread`
- answer isolation + DISTINCT answer bindings for parallel asks (two roots):
  `keeps parallel pending questions isolated when one answer is submitted`
  (now also asserts questionA.answer_binding !== questionB.answer_binding)

All answers flow exclusively through Hermes gjc_coordinator_list_questions /
gjc_coordinator_submit_question_answer; no parallel question protocol exists.

## Mutation proof M7 (auto-bind target work unit)
Fault: bindDelegateCodexHandoff called with the HOST session id instead of the new delegate session id.
## M7 auto-bind targets host work unit instead of delegate session
 0 pass
 56 filtered out
 1 fail
 3 expect() calls
Ran 1 test across 1 file. [365.00ms]
Reverted; test passes again (1 pass).
## Hardening follow-up

- Host-context discovery now counts unreadable or malformed context evidence, records
  `codex_handoff_context_unreadable`, and never silently falls back past a corrupt
  newest candidate.
- Discovery stats every session context before applying the 64-context parse bound,
  so the newest context remains eligible in directories with more than 64 sessions.
- Fallback sources only use fresh, unbound host registrations; direct
  `work_unit === session_id` matches remain authoritative.

New tests:
- `finds the newest context when more than 64 session directories exist`
- `uses an unbound host handoff instead of a delegate-bound fallback source`
- `skips stale Codex auto-binding sources with a durable diagnostic`
- `keeps a direct host session handoff authoritative over other fallback threads`
- `records unreadable host context evidence before binding from an older valid context`
- `records unreadable host context evidence when no valid context remains`

RED transcript captured before the newest-first fix:

```text
bun test packages/coding-agent/test/mcp-delegate-host-context.test.ts --test-name-pattern 'finds the newest context'

error: expect(received).toHaveLength(expected)

Expected length: 64
Received length: 60

(fail) MCP delegate-flow host context > finds the newest context when more than 64 session directories exist [49.93ms]

0 pass
9 filtered out
1 fail
2 expect() calls
Ran 1 test across 1 file. [617.00ms]
```

## Review-blocker RED transcripts

### 1 — cross-host ambiguity fail-closed

```text
$ bun test packages/coding-agent/test/coordinator-mcp-server.test.ts --test-name-pattern 'fails closed when eligible host contexts'

(fail) Coordinator MCP canonical SDK controls > fails closed when eligible host contexts resolve to different Codex threads [44.85ms]

Expected codex_handoff.auto_bound: false
Received codex_handoff.auto_bound: true
Received codex_handoff.thread_id: "thread-two"

0 pass
65 filtered out
1 fail
1 expect() calls
Ran 1 test across 1 file. [395.00ms]
```

### 2 — atomic bind visibility

```text
$ bun test packages/coding-agent/test/coordinator-codex-handoff.test.ts --test-name-pattern 'never exposes a partial delegate binding'

error: state_corrupt
  at readJson (packages/coding-agent/src/coordinator-mcp/codex-handoff.ts:140:13)
  at async readCodexHandoff (packages/coding-agent/src/coordinator-mcp/codex-handoff.ts:269:29)
  at async bindDelegateCodexHandoff (packages/coding-agent/src/coordinator-mcp/codex-handoff.ts:301:27)
  at async <test> (packages/coding-agent/test/coordinator-codex-handoff.test.ts:195:34)
(fail) Codex handoff durable state > never exposes a partial delegate binding to concurrent binders [3.83ms]

0 pass
7 filtered out
1 fail
2 expect() calls
Ran 1 test across 1 file. [89.00ms]
```

### 4 — delegate-flow workflow activation

```text
$ bun test packages/coding-agent/test/coordinator-codex-bridge-redteam.test.ts --test-name-pattern 'does not activate a workflow for delegate-flow spoofing'

error: expect(received).toBeNull()
Received: { active: true, skill: "ultragoal", keyword: "$ultragoal", ... }
(fail) Codex resume bridge red-team > does not activate a workflow for delegate-flow spoofing and preserves exactly four workflow skills [27.44ms]

0 pass
5 filtered out
1 fail
3 expect() calls
Ran 1 test across 1 file. [419.00ms]
```

### 6 — invalid host-context records

```text
$ bun test packages/coding-agent/test/mcp-delegate-host-context.test.ts --test-name-pattern 'skips invalid session ids and oversized excerpts'

error: expect(received).toEqual(expected)
Received contexts included:
- { session_id: "oversized", prompt_excerpt: "x" repeated 1048576 times }
- { session_id: "../evil", prompt_excerpt: "resume" }
(fail) MCP delegate-flow host context > skips invalid session ids and oversized excerpts during enumeration [8.99ms]

0 pass
11 filtered out
1 fail
1 expect() calls
Ran 1 test across 1 file. [339.00ms]
```

## Final GREEN — six-file union

```text
$ bun test packages/coding-agent/test/coordinator-mcp-server.test.ts packages/coding-agent/test/coordinator-codex-handoff.test.ts packages/coding-agent/test/coordinator-codex-bridge.test.ts packages/coding-agent/test/coordinator-codex-wake-publisher.test.ts packages/coding-agent/test/coordinator-codex-bridge-redteam.test.ts packages/coding-agent/test/mcp-delegate-host-context.test.ts

bun test v1.3.14 (d1632b29)

 110 pass
 0 fail
 532 expect() calls
Ran 110 tests across 6 files. [7.95s]
```
## Codex app-server WebSocket transport

The installed schema has no `automation_update` capability; no heartbeat is implemented or claimed.

Read-only real-socket probe:

```text
$ cd /Users/probe/git/probepark/gajae-code && bun -e 'import { createDefaultCodexTransportFactory } from "./packages/coding-agent/src/coordinator-mcp/codex-wake-publisher"; const t = await createDefaultCodexTransportFactory()({kind:"unix",path:"/Users/probe/.codex/app-server-control/app-server-control.sock"}, null); try { await t.request("initialize", {clientInfo:{name:"gjc-coordinator",title:null,version:"0"},capabilities:null}); await (t.notify?.("initialized", {}) ?? Promise.resolve()); const r = await t.request("thread/resume", {threadId:"0198f7a1-0000-7000-8000-000000000000"}); console.log("OK", JSON.stringify(r).slice(0,120)); } catch (e) { console.log("ERR", e.message); } finally { await t.close(); }'
```

Verbatim RED output before the WebSocket transport fix:

```text
ERR codex_app_server_timeout
```

Verbatim GREEN output after the fix:

```text
ERR codex_app_server_request_failed
```

The random nonexistent thread reached the installed app-server over WebSocket and received its JSON-RPC error; no real thread was resumed or started.

## Final real app-server protocol smoke (2026-07-19T05:14:52Z)
Read-only against the installed Codex app-server (codex-cli 0.144.5) unix socket
/Users/probe/.codex/app-server-control/app-server-control.sock over the shipped default transport:
initialize OK: {"userAgent":"Codex Desktop/0.144.5 (Mac OS 26.5.2; arm64) unknown (gjc-coordinator; 0)","codexHome":"/Users/p
thread/resume expected-error: codex_app_server_request_failed

Pre-fix RED (newline JSON-RPC transport): ERR codex_app_server_timeout
Post-fix GREEN: initialize returns the real userAgent over WebSocket; bogus thread/resume
returns codex_app_server_request_failed (JSON-RPC error: no rollout found) — no turn started.

Origin mapping (final): gjc_session_id=delegate work unit, gjc_turn_id=delegation turn,
codex_thread_id=source thread, codex_turn_id=host context turn, codex_host_session_id=host context session.
Token: sent only as Authorization Bearer header in the WebSocket upgrade; never in RPC params.
## Explicit Codex correlation RED — T1–T4

Command:

```text
bun test packages/coding-agent/test/coordinator-mcp-server.test.ts --test-name-pattern 'binds a delegate session to an explicitly correlated Codex handoff|explicit correlation overrides ambient host context|missing explicit correlation skips binding with a durable diagnostic|rejects malformed explicit correlation ids without failing delegation'
```

Verbatim RED output:

```text
bun test v1.3.14 (d1632b29)

packages/coding-agent/test/coordinator-mcp-server.test.ts:
1629 | 			allow_mutation: true,
1630 | 			codex_host_session_id: "codex-host-1",
1631 | 		});
1632 | 		const sessionId = String(result.session_id);
1633 | 
1634 | 		expect(result).toMatchObject({
                        ^
error: expect(received).toMatchObject(expected)

  {
+   "active_turn_id": "turn-ee294e49-ef70-4555-a685-4f15b1cd18cf",
    "codex_handoff": {
-     "auto_bound": true,
-     "thread_id": "thread-explicit-one",
+     "auto_bound": false,
+   },
+   "delivered": true,
+   "delivery": {
+     "attempts": [
+       {
+         "channel": "runtime_ack",
+         "created_at": "2026-07-19T05:33:35.743Z",
+         "delivered": true,
+         "reason": null,
+       },
+     ],
+     "delivered": true,
+     "prompt_acknowledged": true,
+     "queued": false,
+     "runtime_command_id": "sdk-command-6",
+     "runtime_turn_id": "sdk-turn-6",
+     "state": "acknowledged",
+     "target": null,
    },
    "ok": true,
+   "queued": false,
+   "result": {
+     "accepted": true,
+     "command_id": "sdk-command-6",
+     "turn_id": "sdk-turn-6",
+   },
+   "session": {
+     "created_at": "2026-07-19T05:33:35.735Z",
+     "cwd": "/private/var/folders/yx/36gb7cy13hqbgxkbll48m0cr0000gn/T/gjc-coordinator-server-rF3G1z",
+     "ephemeral": true,
+     "session_id": "created-session-1",
+   },
+   "session_id": "created-session-1",
+   "session_state": {
+     "current_turn_id": "turn-ee294e49-ef70-4555-a685-4f15b1cd18cf",
+     "last_turn_id": null,
+     "ready_for_input": false,
+     "session_id": "created-session-1",
+     "state": "running",
+     "updated_at": "2026-07-19T05:33:35.747Z",
+   },
+   "status": "active",
+   "tool_name": "gjc_delegate_execute",
+   "turn": {
+     "completed_at": null,
+     "created_at": "2026-07-19T05:33:35.743Z",
+     "delivery": {
+       "attempts": [
+         {
+           "channel": "runtime_ack",
+           "created_at": "2026-07-19T05:33:35.743Z",
+           "delivered": true,
+           "reason": null,
+         },
+       ],
+       "delivered": true,
+       "prompt_acknowledged": true,
+       "queued": false,
+       "runtime_command_id": "sdk-command-6",
+       "runtime_turn_id": "sdk-turn-6",
+       "state": "acknowledged",
+       "target": null,
+     },
+     "error": null,
+     "evidence": [],
+     "final_response": {
+       "artifact_path": null,
+       "format": "markdown",
+       "source": null,
+       "text": null,
+       "truncated": false,
+     },
+     "liveness": {
+       "checked_at": null,
+       "live": null,
+       "reason": null,
+     },
+     "namespace": {
+       "identity": "ns1_8ef82ae97c638dba80f302e594a19da9",
+       "profile": "local",
+       "repo": "repo",
+     },
+     "prompt": {
+       "created_at": "2026-07-19T05:33:35.743Z",
+       "source": "mcp",
+       "text": 
+ "/skill:ultragoal
+ 
+ Delegated by coordinator MCP tool: gjc_delegate_execute
+ Workflow: execute
+ CWD: /private/var/folders/yx/36gb7cy13hqbgxkbll48m0cr0000gn/T/gjc-coordinator-server-rF3G1z
+ Mutation intent: mutation requested; coordinator startup policy remains authoritative.
+ Optional model hint: none
+ 
+ Task:
+ bind explicit Codex handoff
+ 
+ Return durable status and artifact references through GJC runtime/coordinator state. Do not expose host-facing tmux controls."
+ ,
+     },
+     "question_ids": [],
+     "schema_version": 1,
+     "session_id": "created-session-1",
+     "started_at": "2026-07-19T05:33:35.743Z",
+     "status": "active",
+     "turn_id": "turn-ee294e49-ef70-4555-a685-4f15b1cd18cf",
+     "updated_at": "2026-07-19T05:33:35.743Z",
+   },
+   "turn_id": "turn-ee294e49-ef70-4555-a685-4f15b1cd18cf",
+   "workflow": "execute",
  }

- Expected  - 2
+ Received  + 110

      at <anonymous> (/Users/probe/git/probepark/gajae-code/packages/coding-agent/test/coordinator-mcp-server.test.ts:1634:18)
(fail) Coordinator MCP canonical SDK controls > binds a delegate session to an explicitly correlated Codex handoff [38.20ms]
1668 | 				task: "prefer explicit Codex handoff",
1669 | 				idempotency_key: "explicit-over-ambient",
1670 | 				allow_mutation: true,
1671 | 				codex_host_session_id: "codex-host-2",
1672 | 			}),
1673 | 		).resolves.toMatchObject({
                    ^
error: expect(received).toMatchObject(expected)

  {
+   "active_turn_id": "turn-e6549946-ea0e-49df-aa95-def7a6c78273",
    "codex_handoff": {
      "auto_bound": true,
-     "thread_id": "thread-explicit-two",
+     "thread_id": "thread-ambient",
+   },
+   "delivered": true,
+   "delivery": {
+     "attempts": [
+       {
+         "channel": "runtime_ack",
+         "created_at": "2026-07-19T05:33:35.766Z",
+         "delivered": true,
+         "reason": null,
+       },
+     ],
+     "delivered": true,
+     "prompt_acknowledged": true,
+     "queued": false,
+     "runtime_command_id": "sdk-command-6",
+     "runtime_turn_id": "sdk-turn-6",
+     "state": "acknowledged",
+     "target": null,
    },
    "ok": true,
+   "queued": false,
+   "result": {
+     "accepted": true,
+     "command_id": "sdk-command-6",
+     "turn_id": "sdk-turn-6",
+   },
+   "session": {
+     "created_at": "2026-07-19T05:33:35.761Z",
+     "cwd": "/private/var/folders/yx/36gb7cy13hqbgxkbll48m0cr0000gn/T/gjc-coordinator-server-4mIJ9N",
+     "ephemeral": true,
+     "session_id": "created-session-1",
+   },
+   "session_id": "created-session-1",
+   "session_state": {
+     "current_turn_id": "turn-e6549946-ea0e-49df-aa95-def7a6c78273",
+     "last_turn_id": null,
+     "ready_for_input": false,
+     "session_id": "created-session-1",
+     "state": "running",
+     "updated_at": "2026-07-19T05:33:35.770Z",
+   },
+   "status": "active",
+   "tool_name": "gjc_delegate_execute",
+   "turn": {
+     "completed_at": null,
+     "created_at": "2026-07-19T05:33:35.766Z",
+     "delivery": {
+       "attempts": [
+         {
+           "channel": "runtime_ack",
+           "created_at": "2026-07-19T05:33:35.766Z",
+           "delivered": true,
+           "reason": null,
+         },
+       ],
+       "delivered": true,
+       "prompt_acknowledged": true,
+       "queued": false,
+       "runtime_command_id": "sdk-command-6",
+       "runtime_turn_id": "sdk-turn-6",
+       "state": "acknowledged",
+       "target": null,
+     },
+     "error": null,
+     "evidence": [],
+     "final_response": {
+       "artifact_path": null,
+       "format": "markdown",
+       "source": null,
+       "text": null,
+       "truncated": false,
+     },
+     "liveness": {
+       "checked_at": null,
+       "live": null,
+       "reason": null,
+     },
+     "namespace": {
+       "identity": "ns1_8ef82ae97c638dba80f302e594a19da9",
+       "profile": "local",
+       "repo": "repo",
+     },
+     "prompt": {
+       "created_at": "2026-07-19T05:33:35.766Z",
+       "source": "mcp",
+       "text": 
+ "/skill:ultragoal
+ 
+ Delegated by coordinator MCP tool: gjc_delegate_execute
+ Workflow: execute
+ CWD: /private/var/folders/yx/36gb7cy13hqbgxkbll48m0cr0000gn/T/gjc-coordinator-server-4mIJ9N
+ Mutation intent: mutation requested; coordinator startup policy remains authoritative.
+ Optional model hint: none
+ 
+ Task:
+ prefer explicit Codex handoff
+ 
+ Return durable status and artifact references through GJC runtime/coordinator state. Do not expose host-facing tmux controls."
+ ,
+     },
+     "question_ids": [],
+     "schema_version": 1,
+     "session_id": "created-session-1",
+     "started_at": "2026-07-19T05:33:35.766Z",
+     "status": "active",
+     "turn_id": "turn-e6549946-ea0e-49df-aa95-def7a6c78273",
+     "updated_at": "2026-07-19T05:33:35.766Z",
+   },
+   "turn_id": "turn-e6549946-ea0e-49df-aa95-def7a6c78273",
+   "workflow": "execute",
  }

- Expected  - 1
+ Received  + 110

      at <anonymous> (/Users/probe/git/probepark/gajae-code/packages/coding-agent/test/coordinator-mcp-server.test.ts:1673:14)
(fail) Coordinator MCP canonical SDK controls > explicit correlation overrides ambient host context [24.80ms]
1688 | 				idempotency_key: "missing-explicit-codex-handoff",
1689 | 				allow_mutation: true,
1690 | 				codex_host_session_id: "missing-codex-host",
1691 | 			}),
1692 | 		).resolves.toMatchObject({ ok: true, codex_handoff: { auto_bound: false } });
1693 | 		await expect(fs.readFile(path.join(namespace, "codex-wake-errors.log"), "utf8")).resolves.toContain(
                                                                                                   ^
error: 

Expected promise that resolves
Received promise that rejected: Promise { <rejected> }

      at <anonymous> (/Users/probe/git/probepark/gajae-code/packages/coding-agent/test/coordinator-mcp-server.test.ts:1693:93)
(fail) Coordinator MCP canonical SDK controls > missing explicit correlation skips binding with a durable diagnostic [19.99ms]
1707 | 				idempotency_key: "malformed-explicit-codex-handoff",
1708 | 				allow_mutation: true,
1709 | 				codex_host_session_id: "../evil",
1710 | 			}),
1711 | 		).resolves.toMatchObject({ ok: true, codex_handoff: { auto_bound: false } });
1712 | 		await expect(fs.readFile(path.join(namespace, "codex-wake-errors.log"), "utf8")).resolves.toContain(
                                                                                                   ^
error: 

Expected promise that resolves
Received promise that rejected: Promise { <rejected> }

      at <anonymous> (/Users/probe/git/probepark/gajae-code/packages/coding-agent/test/coordinator-mcp-server.test.ts:1712:93)
(fail) Coordinator MCP canonical SDK controls > rejects malformed explicit correlation ids without failing delegation [18.23ms]

 0 pass
 67 filtered out
 4 fail
 6 expect() calls
Ran 4 tests across 1 file. [436.00ms]
``` 

## Explicit correlation GREEN + corrupt-source coverage
Added test: 'treats a corrupt explicit handoff registration as missing without failing delegation'
(invalid JSON at codex-handoffs/corrupt-codex-host.json -> ok:true, auto_bound:false, codex_handoff_explicit_source_missing).
Final focused GREEN:
 122 pass
 0 fail
 570 expect() calls
Ran 122 tests across 7 files. [8.74s]
