# gjc doctor

`gjc doctor` diagnoses configuration, permissions, installation, plugins, and
services, and repairs a fixed catalogue of nine actions under `--fix`.

Its central promise is that it never claims more than it observed. Every repair
succeeds only against a fresh independent post-check, and anything it could not
confirm is reported as uncertain rather than as success.

## Diagnosing

```sh
gjc doctor                      # diagnose everything, human-readable
gjc doctor --json               # same, machine-readable report
gjc doctor --check service      # limit to one group
gjc doctor --check plugin --scope user
```

Diagnosis is strictly read-only. It does not write product state, fetch over
the network, execute plugin code, or start a service. `--dry-run` adds a repair
plan to that read-only report without performing it.

Check groups: `runtime`, `config`, `permissions`, `installation`, `link`,
`credentials`, `mcp`, `service`, `plugin`, plus the internal diagnostic probes
`native` and `projection`, which report state but have no repair action. A
specific check id from the report also works as a selector
(`--check config.user.skills.enabled`); an id that does not exist is a usage
error.

## Repairing

A repair names exactly one action and one target:

```sh
gjc doctor --fix \
  --repair permissions.restrict-owned-config \
  --target <targetId> \
  --allow-risk permission-change \
  --yes
```

Target ids come from the diagnose report (`checks[].targetId`). They are
content-framed identifiers; an id never confers authority by itself, and every
repair re-verifies the original object and parent identity before acting.

### The two gates are independent

|Flag|Grants|Does NOT grant|
|---|---|---|
|`--allow-risk <class>`|authorization for that risk class|confirmation|
|`--yes`|skips the interactive confirmation|any authorization|

`--yes` never substitutes for `--allow-risk`, and neither bypasses integrity,
ownership, or occupancy verification. Risk classes: `config-change`,
`permission-change`, `install-replace`, `plugin-change`,
`service-interruption`, `artifact-detach`, `network`, `external-execution`.

### Actions

|Action|Target kind|Notes|
|---|---|---|
|`config.set-validated`|`config`|requires `--set-value-json true\|false`|
|`mcp.set-startup-policy`|`mcp`|requires `--set-value-json true\|false`|
|`permissions.restrict-owned-config`|`permission`|never widens owner bits|
|`install.restore-binary`|`binary`|requires `--ref` and `--sha256`; owned standalone installs only|
|`install.repair-managed-link`|`link`|requires an explicit `--ref` candidate|
|`plugin.restore-known-artifact`|`plugin`|requires `--ref` and `--sha256`|
|`plugin.quarantine-selected`|`plugin`|disables without deleting|
|`service.restart-owned`|`service`|broker, Discord, Slack, Telegram|
|`service.detach-owned-stale-artifact`|`artifact`|detach only, never deletes a live owner's file|

### Pinned repairs

`install.restore-binary` and `plugin.restore-known-artifact` replace a known
artifact, so they require an operator-supplied pin. The report publishes the
candidate, but never selects one for you:

```sh
gjc doctor --fix --repair plugin.restore-known-artifact --target <id> \
  --ref <candidate.ref> --sha256 <candidate.sha256> \
  --allow-risk plugin-change --allow-risk install-replace --allow-risk network --yes
```

What `--sha256` names depends on the candidate's `sourceChannel`. For
`stored-source` it is the artifact-tree digest of the stored source. For
`catalog` it is the marketplace catalog fingerprint, because the artifact being
repaired cannot pin itself — an absent or corrupt artifact must still be
restorable. In both cases the bytes finally installed are bound separately: the
apply path re-reads and re-hashes the staged candidate and refuses on any
mismatch.

### Restarting a service

```sh
gjc doctor --fix --repair service.restart-owned --target <id> \
  --allow-risk service-interruption --yes --drain
```

Restart goes through each owner's own prepare/commit protocol — never a signal,
a kill, or a doctor-private spawn. `--drain` is a bare flag that grants a fixed
30-second natural-completion window; it takes no value. It waits only for work
to finish on its own — an idle attached session still counts as workload, and
nothing is force-detached or retired on the owner's behalf. It is valid only
with `service.restart-owned`.

Success requires two independent facts: the predecessor is proven gone by
positive kernel-confirmed absence of its exact process incarnation, and the
published successor carries a *different* incarnation. A matching pid is never
accepted as proof. A daemon predating the current restart protocol is reported
as `owner_unavailable:unsupported_incumbent_protocol` — present but not
drivable, requiring a one-time manual transition — and is never confused with an
owner that already exited.

## Exit codes

|Code|Meaning|
|---|---|
|0|healthy or degraded, or the repair verified|
|1|at least one check reported an error|
|2|usage error (bad flags); reported before any work starts|
|3|incomplete: a check was blocked, timed out, or a repair refused before any effect|
|4|a mutation began and its effect could not be confirmed|
|130|interrupted|

`--json` reports `summary.exitCode`, and the process exit code always equals it.

Warnings alone exit 0 with verdict `degraded`; only an error-health check exits
1. Exit 3 and exit 4 are deliberately different: exit 3 means nothing was
touched, while exit 4 means something was and the result is unverified —
inspect before retrying.

## Reading a repair result

|`state`|Effect began|Meaning|
|---|---|---|
|`planned`|no|described only; `--dry-run` or not yet run|
|`blocked`|no|refused before any effect|
|`not_needed`|no|already in the desired state|
|`verified`|yes|mutated and confirmed by a fresh independent post-check|
|`pending_activation`|yes|published, but the new state takes effect in a new session|
|`uncertain`|yes|an effect began and could not be confirmed|
|`failed`|check the flag|the repair did not complete; read `sideEffectStarted` to tell whether anything was touched|
|`rolled_back`|yes|the mutation was reverted|
|`rollback_conflict`|yes|the revert itself conflicted; inspect the retained backup|

Most lanes normalize their internal outcome into these states, so a refusal that
touched nothing becomes `blocked` and a mutation that started without confirming
becomes `uncertain`. `failed` is the exception that carries both possibilities,
so read `sideEffectStarted` alongside it: `false` means nothing was touched
(exit 3), `true` means something was (exit 4).

Anything with an effect exits 4 even if the reported `sideEffectStarted` flag
says otherwise, because an observed physical state overrides an adapter's claim.
A detected race on the target or its parent surfaces as `blocked` with reason
`target_or_parent_changed`.

`readiness` lists what is still missing (`authorization_missing`,
`confirmation_required`, `pin_missing`, `candidate_selection_missing`,
`unsupported`, …), and `reasonCode` names the exact stage a refusal stopped at.

## Safety properties

- Diagnosis and `--dry-run` perform no writes, fetches, plugin execution, or
  service starts.
- Secrets are never printed: raw config, argv, environment values, and
  credential identifiers stay out of the report, stderr, and the journal.
- No blanket reinstall or deletion, no arbitrary repair hooks, no credential
  refresh or billing probes, no blind PID killing.
- Repairs run in a supervised child process, so a bounded timeout applies to
  real synchronous filesystem and native work rather than only to a promise.
