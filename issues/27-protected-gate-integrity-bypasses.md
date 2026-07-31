# 27 — the three CRITICAL protected-gate integrity bypasses

- **Owner stage:** durable goal G012 (architect review pass 5 findings)
- **Runtime:** `packages/coding-agent/src/gjc-runtime/ultragoal-runtime.ts`
- **Reproduction note:** all probes below run the BRANCH SOURCE
  (`bun packages/coding-agent/src/cli.ts ultragoal …`). The installed `gjc` binary is a
  compiled older build and does not carry these checks, so it must not be used to
  judge whether a bypass is open.

## 1. protected-status-tamper — CLOSED (verified, already implemented)

Attack: seed `G001` as `supersedable:false` + `blocked` with a valid witness, then edit
`goals.json` to set the status to `superseded` so the gate drops out of required goals.

Probe result:

```
ultragoal status → EXIT=1
Ultragoal plan tampering detected: protected gate G001 status superseded is not
justified by its durable ledger history (blocked).
```

`protectedGateStatusFromLedger` replays the durable ledger to derive the only status a
protected gate may present, and a `complete` status additionally requires the
receipt-bound checkpoint witness (`ultragoal-runtime.ts:774-795`). Covered by
`fails closed when a protected gate status is edited without a matching ledger transition`.

## 2. forged-rotation-suffix — CLOSED (verified, already implemented)

Attack: append a valid-looking `protected_gate_generation_reseeded` row with empty
`protectedGateIds`, point the plan at the new generation, and remove the protected row.

Probe result:

```
ultragoal status → EXIT=1
Ultragoal plan tampering detected: protected-gate security evidence extends beyond
the trusted ledger head.
```

Security events are bound to the exact trusted head, the rotation chain is validated
as one coherent chain including `protectedGateIds`, and duplicate witnesses are
rejected (`ultragoal-runtime.ts:820-890`). Covered by
`fails closed when a protected-gate generation is rotated outside a recorded reseed`.

## 3. coordinated-provenance-scrub — WAS OPEN, NOW FIXED

Attack: delete the protected row, the generation, the integrity head and every
`protected_gate_*` witness row. The plan then looks like a pre-protection plan, the
legacy allowance admits it, and protection disappears.

Reproduced as open before the fix:

```
ultragoal status → EXIT=0
- goals: 2 (pending=1 active=0 complete=0 failed=0 blocked=1 review_blocked=0 superseded=0)
```

Fix: legacy admission is now anchored in trusted provenance instead of inferred from
absent fields. When a protected-gate witness is established, `writePlan` also appends
an ever-protected marker (`category: "security"`,
`verb: "ultragoal-protected-gate-established"`) to the session audit journal at
`.gjc/_session-<id>/state/audit.jsonl`, a surface outside `goals.json` and
`ledger.jsonl`. `readUltragoalPlan` refuses legacy admission for any plan that marker
covers.

After the fix:

```
ultragoal status → EXIT=1
Ultragoal plan tampering detected: this session's audit journal records an
established protected gate, but goals.json and ledger.jsonl carry no protection.
Restore the protected gate, its generation and its witnesses before continuing.
```

Red → green receipt for the regression test
`fails closed when a coordinated scrub tries to disguise a protected plan as legacy`:

- RED with the runtime change stashed: `0 pass / 1 fail` (status exited 0).
- GREEN with the fix applied: `1 pass / 0 fail`.

No false positives: a genuinely legacy plan that was never protected still admits
(`ultragoal status → EXIT=0`), and the full ultragoal runtime suites are green
(177 pass / 0 fail across `ultragoal-runtime.test.ts` and
`ultragoal-command-contract.test.ts`).

## What remains open

The marker narrows the attack but does not make it impossible: an attacker with write
access to the whole session directory can also truncate `audit.jsonl`. Closing that
completely requires provenance the local filesystem cannot provide on its own — an
append-only or externally attested journal. The bypass now requires scrubbing three
separately-audited surfaces instead of two, and every surviving surface fails closed.
