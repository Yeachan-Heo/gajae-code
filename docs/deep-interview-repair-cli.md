# Deep-interview typed repair CLI (v1)

This is the native repair and inspection surface for an existing GJC deep-interview session. It does not run the interview; `/skill:deep-interview` does that. Use its CLI-owned drafts to repair a repairable active session without editing state files.

> Do **not** use `grep`, `sed`, direct `.gjc/` edits, generic envelope replacement, or `--force` to repair this state. Run `sanity-check`, inspect the reported selector, then use the matching typed command with the current revision.

## Normal-flow draft protocol

All commands require standalone `--json`. Value-taking flags use exactly `--name value`; `--json` and `--null` are standalone flags and take no value. Flags cannot repeat, and identifiers match `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`. Normal mutations use CLI-owned drafts, never caller-serialized JSON:

```text
gjc deep-interview draft create  --for initialize-context|confirm-topology|record-answer|apply-round-result --session-id ID [identity flags] --json
gjc deep-interview draft edit    --draft-id ID --expected-draft-revision N --op set|append|remove --path /pointer [--value SCALAR|--value-file PATH|--null] --json
gjc deep-interview draft show    --draft-id ID --json
gjc deep-interview draft check   --draft-id ID --json
gjc deep-interview draft rebase  --draft-id ID --expected-draft-revision N --to-state-revision N --json
gjc deep-interview draft discard --draft-id ID --expected-draft-revision N --json
```

Create returns `draft_id`, `draft_revision`, and state `base_revision`. Every edit/rebase is CAS on `draft_revision` and returns its next value. `check` validates the complete bounded payload against current state without consuming or mutating it; it reports when the draft base is stale. To rebase a state-stale active draft, pass the caller-observed current state revision as `--to-state-revision`, then check again. Drafts are private workspace/session-bound CLI storage, atomically written with restrictive permissions, automatically expired/cleaned up, and retained briefly after consumption for idempotent receipts. Do not read, copy, or reconstruct draft storage.

Use only kind-allowed JSON-pointer paths. `set` writes one scalar: use `--value` for strings/numbers/booleans, `--null` for null, and `--value-file` only for bounded text. A valueless `append` on a missing object-item array appends an `{}` scaffold; on a missing scalar-item array it initializes `[]`. An existing scalar-item array still requires `--value` or `--value-file` for `append`. `remove` takes no value. Build arrays and nested objects with scaffolds and scalar edits, never inline JSON.

After check, consume through the matching typed command: `gjc deep-interview initialize-context|confirm-topology|record-answer|apply-round-result --draft-id ID --expected-draft-revision <latest_draft_revision> --json`. Consume applies state CAS from the draft base revision, stamps a receipt, and marks the draft consumed. There is no public `draft consume` command. `record-answer` remains recorder-first: draft recovery is only for an answer shell the `ask` recorder did not persist. Full payload/envelope reconstruction is forbidden in normal flow.

`inspect` and `sanity-check` stay direct bounded reads:
```text
gjc deep-interview inspect --session-id ID --selector summary|recent-scored|pending|round|topology|facts|triggers|floor [--round-key KEY] [--limit 1..25] [--cursor CURSOR] --json
gjc deep-interview sanity-check --session-id ID --json
```

## Legacy compatibility: inline JSON request forms
The request forms below are complete for compatibility callers only. Do not use them in normal setup, topology, answer fallback, or round-result flow.
```text
gjc deep-interview initialize-context --session-id ID --schema-version 1 --expected-revision N --input-json JSON --json
gjc deep-interview confirm-topology    --session-id ID --schema-version 1 --expected-revision N --input-json JSON --json
gjc deep-interview record-answer       --session-id ID --schema-version 1 --expected-revision N --round N --question-id ID --question-json JSON_STRING --answer-json JSON [--round-id ID] [--component-id ID] [--dimension goal|constraints|criteria|context] --json
gjc deep-interview apply-round-result  --session-id ID --schema-version 1 --expected-revision N --round N --question-id ID --result-json JSON [--round-id ID] --json
```

## Closed request schemas

Objects below are exact-key objects: unlisted keys are rejected. Optional properties may be omitted; they are not nullable unless shown as `null`.

### `initialize-context` `--input-json`

```json
{
  "type": "greenfield | brownfield",
  "interview_id": "ID?",
  "initial_idea": "string?",
  "initial_context_summary": "string?",
  "codebase_context": "string?",
  "challenge_modes_used": ["string?"],
  "threshold": 0.0001,
  "threshold_source": "string?",
  "language": "string?",
  "trace": ["string?"],
  "trace_summary": "string?"
}
```

`threshold` is `(0,1]`, finite, and at most four decimal places. `interview_id`, text fields, and collections are bounded (24 KiB input; text is at most 4096 bytes; up to 64 challenge modes and 64 trace strings).

### `confirm-topology` `--input-json`

```json
{
  "components": [{"id":"ID","name":"string?","status":"active | deferred?","active":true}],
  "deferred_components": ["component ID"]
}
```

Both arrays contain at most 64 items; component IDs are unique and each deferred ID must name a component.

### `record-answer`

`--question-json` is a nonempty JSON string, at most 2048 bytes. `--answer-json` is exactly:

```json
{"selected_options":["nonempty string"],"custom_input":"string | null"}
```

It permits at most 64 selected options (each at most 2048 bytes); non-null `custom_input` is at most 4096 bytes.

### `apply-round-result` `--result-json`

The outer result has exactly these keys; each may be omitted except `global_scores`:

```json
{"global_scores":{},"component_updates":[],"targeting":{},"triggers":[],"fact_ops":[],"ontology":{},"bookkeeping":{}}
```

Scores are finite `[0,1]` values with at most four decimal places. The dimensions are project-aware: **greenfield** requires exactly `goal`, `constraints`, and `criteria`; **brownfield** additionally requires `context`. This applies to `global_scores`, every `component_updates[].scores`, and targeting dimensions.

```json
{
  "global_scores":{"goal":0.5,"constraints":0.5,"criteria":0.5},
  "component_updates":[{"component_id":"ID","scores":{"goal":0.5,"constraints":0.5,"criteria":0.5}}],
  "targeting":{"target_component_id":"ID","target_dimension":"goal","weakest_component_id":"ID","weakest_dimension":"goal","last_targeted_component_id":null},
  "triggers":[{"kind":"A | B | C | D","name":"string","status":"active | disputed | unresolved","component":"ID","dimension":"goal","evidence":"string?","contradictedFactId":"ID?","rationale":"string?"}],
  "fact_ops":[{"op":"add","id":"ID","statement":"string","component":"string?","dimension":"goal?","evidence":"string?"},{"op":"dispute","id":"ID"},{"op":"supersede","id":"ID","target_id":"ID"}],
  "ontology":{"entities":[{"id":"ID","name":"string","type":"string","fields":["string"]}],"relationships":[{"id":"ID","from_entity_id":"ID","to_entity_id":"ID","type":"string"}],"reasoning":[{"statement":"string","evidence":"string?"}]},
  "bookkeeping":{"resolution":"auto_research_accepted | auto_answer | direct | refined | cited_confirmation","round_ids":["ID"],"counter_deltas":{"ID":1}}
}
```

Every nested object is closed. Lists have a 64-item cap and share a 64-item result budget; IDs are unique where applicable. Relationships must refer to entities in the same request; fact operations must refer to valid existing/new facts. `disputed` and `unresolved` triggers require a rationale. Trigger score and ambiguity transition metrics are native-derived and never accepted from callers. `counter_deltas` are safe integers with absolute value at most 10,000.

## Legacy mutation lifecycle, receipts, and warnings

The normal lifecycle is: initialize missing context → confirm topology → record an answer shell (`answered`) → apply its round result (`scored`). Every mutation is compare-and-swap on `state_revision`: re-inspect or use the prior successful response's `state_revision` before the next write. A matching replay is a success with `written:false`; it does not advance the revision. Existing different setup is `DI_SETUP_CONFLICT`; a different confirmed topology is `DI_TOPOLOGY_CONFLICT`; a changed pending answer is `DI_ANSWER_CONFLICT`; a changed scored answer is `DI_SHELL_CONFLICT`; a different result for a scored round is `DI_ROUND_RESULT_CONFLICT`.

A successful mutation response is:
```json
{"ok":true,"command":"record-answer","state_path":"…","state_revision":2,"written":true,"content_sha256":"sha256?","transition":{"current_ambiguity":null,"effective_ambiguity":null,"floor":null,"ambiguity_milestone":null},"warnings":[],"native_projection":null}
```

`native_projection` is `null` for `initialize-context`, `confirm-topology`, and `record-answer`. For a successful `apply-round-result`, it is the following exact-key native projection (all values are native-derived from the committed round and state):

```json
{
  "score_units":{"goal":5000,"constraints":5000,"criteria":5000,"context":5000},
  "weighted_ambiguity":0.5,
  "weighted_ambiguity_units":5000,
  "floor":0.05,
  "floor_units":500,
  "floor_cause":{"floor":0.05,"disputed_fact_count":0,"unscored_active_component_count":1,"auto_answer_ratio":0},
  "effective_ambiguity":0.5,
  "effective_ambiguity_units":5000,
  "prior_effective_ambiguity":null,
  "direction":"initial | increased | decreased | unchanged",
  "ambiguity_milestone":"initial | progress | refined | ready",
  "topology":{},
  "topology_counts":{"active":1,"deferred":0,"total":1},
  "ontology":{},
  "ontology_counts":{"stable":0,"changed":0,"new":0,"basis":"no_entities | first_round | compared"},
  "targeting":{"target_component_id":"ID | null","target_dimension":"goal | constraints | criteria | context | null","last_targeted_component_id":"ID | null"},
  "transition":{"round_key":"string","lifecycle":"scored","auto_answer_streak":0}
}
```

`score_units` contains the project-required score dimensions, in integer ten-thousandths. `topology` is the committed topology snapshot and `ontology` is the committed round ontology snapshot; their contents are native state snapshots, not caller-controlled projections. `floor_cause` is the full floor breakdown shown above. `prior_effective_ambiguity` is `null` for the first scored round. `weighted_ambiguity`, `floor`, and `effective_ambiguity` each pair with their corresponding integer `*_units` value. It commits the stamped receipt/checksum atomically before best-effort post-commit effects. `warnings` can include `DI_POST_COMMIT_AUDIT_FAILED`, `DI_POST_COMMIT_ACTIVITY_FAILED`, and `DI_POST_COMMIT_HUD_FAILED`; these warnings do not roll back a committed state. `content_sha256` is omitted when no write was stamped.

## Inspect response and views

All inspect responses have this envelope:

```json
{"ok":true,"command":"inspect","schema_version":1,"state_path":"…","state_revision":0,"content_sha256":"sha256 | null","view_sha256":"sha256","limits_version":1,"data":{},"returned_count":1,"total_count":1,"bytes_returned":0,"truncated":false,"next_cursor":null}
```

A `TextView` is `{ "value": "…", "truncated": false, "original_bytes": 0 }`; nullable fields return `null`. `--selector` is exactly one of `summary`, `recent-scored`, `pending`, `round`, `topology`, `facts`, `triggers`, or `floor`; `round` requires `--round-key`. `recent-scored`, `pending`, `facts`, and `triggers` return `{items:[View]}`; all other selectors return their view directly in `data`.

Closed view schemas:
```json
{"SummaryView":{"interview_id":"string | null","type":"greenfield | brownfield | null","initial_idea":"TextView | null","resolution":"string | null","threshold":0.5,"current_ambiguity":0.5,"ambiguity_milestone":"string | null","topology_status":"pending | confirmed","state_revision":0}}
{"RoundView":{"round_key":"string","round":1,"round_id":"ID | null","question_id":"ID | null","component_id":"ID | null","dimension":"goal | constraints | criteria | context | null","question":"TextView | null","answer":{"selected_options":["TextView"],"custom_input":"TextView | null"},"lifecycle":"answered | pending_scoring | scored","scored_at":"string | null","weighted_ambiguity":0.5,"effective_ambiguity":0.5,"floor":0.5,"round_result_digest":{"v":1,"algorithm":"sha256","value":"string"}}}
{"PendingRoundView":{"round_key":"string","round":1,"round_id":"ID","question_id":"ID","component_id":"ID | null","dimension":"goal | constraints | criteria | context | null","question":"TextView","answer":{"selected_options":["TextView"],"custom_input":"TextView | null"},"lifecycle":"answered | pending_scoring"}}
{"FactView":{"id":"string","status":"established | disputed | resolved","source_round":1,"component_id":"ID | null","dimension":"goal | constraints | criteria | context | null","statement":"TextView","evidence":"TextView | null","resolution_reason":"TextView | null","superseded_by":"ID | null","insertion_index":0}}
{"TriggerView":{"kind":"A | B | C | D","name":"TextView","status":"active | disputed | unresolved","source_round":1,"source_round_key":"string","component_id":"ID","dimension":"goal | constraints | criteria | context","prior_dimension_score":0.5,"new_dimension_score":0.5,"prior_effective_ambiguity":0.5,"new_effective_ambiguity":0.5,"evidence":"TextView | null","rationale":"TextView | null","contradicted_fact_id":"ID | null","insertion_index":0}}
{"TopologyView":{"status":"pending | confirmed","confirmed_at":"string | null","components":["ComponentView"],"deferrals":["DeferralView"],"last_targeted_component_id":"ID | null"},"ComponentView":{"id":"string","name":"TextView","description":"TextView | null","active":true,"deferred":false,"scores":{"goal":0.5,"constraints":0.5,"criteria":0.5,"context":0.5},"weakest_dimension":"goal | constraints | criteria | context | null"},"DeferralView":{"component_id":"string","reason":"TextView","created_at":"string","until_round":null}}
{"FloorView":{"floor":0.5,"disputed_fact_count":0,"unscored_active_component_count":0,"auto_answer_ratio":0.5,"weighted_ambiguity":0.5,"effective_ambiguity":0.5}}
```
`prior_dimension_score`, `new_dimension_score`, `prior_effective_ambiguity`, and `new_effective_ambiguity` are native-derived from persisted scored round records. All four are `null` for `disputed` and `unresolved` triggers; active-trigger metrics are nullable only when the historical metric is unavailable. `recent-scored` uses `RoundView`; `pending` uses `PendingRoundView`. Canonical stored deferral IDs are adapted only at this projection boundary: `reason` is an empty `TextView`, `created_at` is the topology confirmation timestamp, and `until_round` is `null`.

Paged collections sort deterministically: recent scored by descending `(round, round_key)`; pending by ascending `(round, round_key)`; facts by `(id, insertion index)`; triggers by `(source round, source round key, insertion index)`. Default limit is 10, maximum is 25. Data is capped at 16 KiB and the complete response at 48 KiB. `next_cursor` is an opaque base64url v1 token bound to selector, revision, view hash, and the last sort key. Reuse it only with the same unchanged view: malformed/mismatched cursors yield `DI_CURSOR_INVALID`; changed revision/view yields `DI_CURSOR_STALE`. A topology projection that cannot fit the 16 KiB admission limit yields `DI_OUTPUT_LIMIT_EXCEEDED` and exit 2. For `inspect`, a single item or non-paged view that cannot fit its applicable data or response limit yields `DI_OUTPUT_LIMIT_EXCEEDED` and exit 3.

## Sanity checks, issues, and exits

`sanity-check` always exits 0 and returns `{ok:true,command:"sanity-check",healthy:boolean,issues:[{code,message}],limits_version:1}`. It diagnoses absence/corruption, receipt validity, v1 schema, and lifecycle repairability before mutation.

| Exit | Meaning | Codes |
| --- | --- | --- |
| 0 | Successful command (including sanity reporting unhealthy and idempotent no-op) | — |
| 2 | Request/argument error | `DI_UNKNOWN_COMMAND`, `DI_INVALID_ARGUMENT`, `DI_JSON_REQUIRED`, `DI_INVALID_SESSION_ID`, `DI_INVALID_SCHEMA_VERSION`, `DI_INVALID_EXPECTED_REVISION`, `DI_INVALID_ROUND`, `DI_INVALID_LIMIT`, `DI_INVALID_SELECTOR`, `DI_SELECTOR_ARGUMENT_INVALID`, `DI_INVALID_*_JSON`, `DI_INVALID_QUESTION_ID`, `DI_INVALID_ROUND_ID`, `DI_INVALID_COMPONENT_ID`, `DI_INVALID_DIMENSION`, `DI_CURSOR_INVALID`, `DI_OUTPUT_LIMIT_EXCEEDED` (topology admission) |
| 3 | State, precondition, stale cursor, inspect output limit, or internal error | `DI_STATE_ABSENT`, `DI_STATE_CORRUPT`, `DI_STATE_SCHEMA_INVALID`, `DI_RECEIPT_MISSING`, `DI_RECEIPT_MALFORMED`, `DI_RECEIPT_CHECKSUM_MISMATCH`, `DI_PHASE_NOT_REPAIRABLE`, `DI_REVISION_CONFLICT`, `DI_ROUND_NOT_FOUND`, `DI_CURSOR_STALE`, `DI_OUTPUT_LIMIT_EXCEEDED` (inspect output limits), `DI_INTERNAL_ERROR` |
| 4 | Concurrent/content conflict | `DI_SETUP_CONFLICT`, `DI_TOPOLOGY_CONFLICT`, `DI_ANSWER_CONFLICT`, `DI_SHELL_CONFLICT`, `DI_ROUND_RESULT_CONFLICT` |

Errors are JSON on stderr: `{ "ok": false, "issue": { "code": "…", "message": "…" } }`.

## Normal-flow lifecycle example

```sh
# Create, edit, check, then consume setup. Capture each response's revisions.
gjc deep-interview draft create --for initialize-context --session-id strict-flow --json
gjc deep-interview draft edit --draft-id <setup> --expected-draft-revision 1 --op set --path /type --value greenfield --json
gjc deep-interview draft edit --draft-id <setup> --expected-draft-revision 2 --op set --path /threshold --value 0.0001 --json
gjc deep-interview draft check --draft-id <setup> --json
gjc deep-interview initialize-context --draft-id <setup> --expected-draft-revision <latest_draft_revision> --json

# Build topology with an object-item append scaffold and initialize zero deferrals, then consume it.
gjc deep-interview draft create --for confirm-topology --session-id strict-flow --json
gjc deep-interview draft edit --draft-id <topology> --expected-draft-revision 1 --op append --path /components --json
gjc deep-interview draft edit --draft-id <topology> --expected-draft-revision 2 --op set --path /components/0/id --value core --json
gjc deep-interview draft edit --draft-id <topology> --expected-draft-revision 3 --op set --path /components/0/name --value Core --json
gjc deep-interview draft edit --draft-id <topology> --expected-draft-revision 4 --op append --path /deferred_components --json
gjc deep-interview draft check --draft-id <topology> --json
gjc deep-interview confirm-topology --draft-id <topology> --expected-draft-revision <latest_draft_revision> --json

# `ask` normally records this answer. Only recorder recovery creates this draft.
gjc deep-interview draft create --for record-answer --session-id strict-flow --round 1 --question-id q1 --round-id r1 --component-id core --dimension goal --json
gjc deep-interview draft edit --draft-id <answer> --expected-draft-revision 1 --op set --path /question --value Question --json
gjc deep-interview draft edit --draft-id <answer> --expected-draft-revision 2 --op append --path /answer/selected_options --json
gjc deep-interview draft edit --draft-id <answer> --expected-draft-revision 3 --op set --path /answer/selected_options/0 --value Yes --json
gjc deep-interview draft edit --draft-id <answer> --expected-draft-revision 4 --op set --path /answer/custom_input --null --json
gjc deep-interview draft check --draft-id <answer> --json
gjc deep-interview record-answer --draft-id <answer> --expected-draft-revision <latest_draft_revision> --json

# Create/check/consume an apply-round-result draft after inspecting the pending shell.
gjc deep-interview draft create --for apply-round-result --session-id strict-flow --round-key <round_key> --json
gjc deep-interview draft edit --draft-id <result> --expected-draft-revision 1 --op set --path /global_scores/goal --value 0.5000 --json
gjc deep-interview draft check --draft-id <result> --json
gjc deep-interview apply-round-result --draft-id <result> --expected-draft-revision <latest_draft_revision> --json
```
