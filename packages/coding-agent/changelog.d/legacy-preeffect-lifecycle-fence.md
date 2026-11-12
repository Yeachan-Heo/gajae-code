### Fixed

- A legacy lifecycle ledger row whose own content proves it was refused before any effect started no longer fences SDK `session.close`, `session.resume`, `session.delete`, and `session.reconcile_uncertain` for unrelated sessions. Such rows, for example `session.create` requests refused by a `models.yml` profile-registry outage, made every targeted lifecycle request on that agent directory fail with `legacy_lifecycle_ambiguous` while creates kept succeeding, so sessions could never be closed. A row qualifies only if all of the following hold:
  - It is an unkeyed `terminal_error` row.
  - Its response is an `ok: false` refusal with code `model_profile_registry_error` or `unknown_model_profile`.
  - It carries only the fields such a refusal wrote: no session, effect marker, effect intent, durable effects, startup failure, cleanup state, or unrecognised field.
  - Its history never reached `effect_started`, `awaiting_ready`, or `terminal_uncertain`. Ledger compaction keeps that history for unkeyed `terminal_error` rows instead of reducing them to the accepted anchor and the latest row, so a later legacy migration, row-cap compaction, or restart cannot lift the fence.

  Such a row does not fence a request that reuses its idempotency key for another session either, even when another legacy row records the session it was refused for, because the refused request had no effect to repeat. Every other refusal code stays fenced. That includes `spawn_failed`, `ready_then_exited`, `terminal_uncertain`, `flush_failed`, `endpoint_unreadable`, and `invalid_input`. Live, uncertain, and same-session legacy rows also stay fenced.
