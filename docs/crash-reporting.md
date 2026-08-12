# Crash fingerprinting and `gjc crash report`

GJC writes a durable, rotation-immune crash log (`~/.gjc/agent/gjc-crash.log`) for every
fatal exception. This page documents how those records get a stable identity, how the
counts are aggregated, and the privacy contract of the assisted reporting flow.

**Nothing in this feature transmits anything without an explicit, per-invocation,
digest-confirmed confirmation. Fully automatic issue creation is an explicit non-goal.**

## 1. Fingerprinting (algorithm v1)

Every new fatal record gains one machine-readable identity line:

```
gjc-crash-record.v1 fp:<32 hex> fpv:1 id:<random>
```

The fingerprint is computed at `recordFatalCrash` time from the already-captured
diagnostic text (error name, message, stack) — the throwable is never read again.

- **Canonical serialization** is length-prefixed UTF-8 (`<byteLength>:<bytes>`) over
  `"gjc-crash-fp.v1"`, `errorName`, `normalizedMessageClass`, and up to three normalized
  in-app frames. The digest is sha256 truncated to 128 bits, published as 32 lowercase
  hex characters. The algorithm version is recorded as `fpv` beside every value.
- **Message normalization is typed, not "strip all digits".** Absolute POSIX/Windows/UNC
  /BunFS paths become `<path>`, home-rooted paths become `<home>`, UUIDs become `<uuid>`,
  hex runs become `<hex>`, digit runs of four or more become `<num>`, and everything
  `redactCrashSecrets` rewrites keeps its marker. Runs of three or fewer digits and errno
  names survive verbatim, so `404` and `500` stay distinct crash classes.
- **Frame normalization** keeps the install-root-relative file path and the function name
  and drops line/column numbers, which churn on every release. Source-tree, compiled
  BunFS (`/$bunfs/root/…`, `B:\~BUN\root\…`) and Windows stacks normalize identically.
  Dependency and `node:`/`bun:` frames are skipped. A stack with no in-app frame yields
  the literal `<no-app-frame>`; distinct roots can merge there, which is an accepted and
  documented v1 property.

### The fingerprint is a public, pseudonymous correlation token

It is deterministic over low-entropy inputs, therefore dictionary-testable, and it links
the same crash class across installs and accounts. It is **not** a confidentiality
control. It never hashes secret or path-bearing raw text — only the normalized form —
and the consent preview says so before anything is sent.

### Legacy records are `unmatchable`

Records written before this feature carry no identity line. The crash log cannot be
trusted as a parseable database (the field corpus contains an interleaved record where
two headers merged onto one line under concurrent writers), so no retroactive matching is
attempted and pre-feature records are not reportable through this flow.

## 2. Event journal and compacted index

| File | Role |
| --- | --- |
| `~/.gjc/agent/gjc-crash-events.jsonl` | Append-only journal. **Source of increments.** |
| `~/.gjc/agent/gjc-crash-index.json` | Compacted, advisory signature index. |

- The **fatal path** writes exactly one bounded line (≤ 512 B) with `O_APPEND` and nothing
  else: no parse, no lock, no rename, no read. A failure is swallowed, and a latch makes a
  crash-during-crash skip journal work entirely.
- **Compaction** happens at the next startup under the cross-process file lock. The
  journal is rotated aside before it is read, occurrence ids are deduped, and a leftover
  file from a crashed compaction is picked up by the next run, so the merge is idempotent
  and concurrent compactors cannot drop counts.
- **Strict schema on read:** exact fingerprint alphabet and length, safe-integer bounds,
  timestamp bounds, unknown-key and control-character rejection, null-prototype parsing,
  no-follow opens. A malformed or hostile-valued index is quarantined to a capped number
  of `.corrupt-*` siblings and rebuilt from the journal.
- **The index is advisory.** It can never authorize, suppress or auto-target anything; a
  `reportedAt` stamp changes default highlighting, not permission.
- **Bounds:** message preview ≤ 512 B per entry, entry ≤ 1 KiB, index ≤ 256 KiB, 128
  signatures. **Unreported signatures are never evicted.** Overflow evicts only reported
  or dismissed entries; when nothing is evictable the compactor stops adding new entries
  and records an overflow marker that `gjc crash report` surfaces.
- `lifetimeCount` (from the journal, monotonic) and `retainedCount` (recomputed from the
  identity markers still present in the capped crash log) are tracked separately, so the
  512 KiB crash-log cap reset cannot silently deflate a signature's history.
- Multi-account installs that symlink one agent dir **share this state deliberately**:
  the scope is the agent dir, exactly like the crash log itself.

## 3. `gjc crash report`

```sh
gjc crash list            # local signatures, no network, no gh
gjc crash list --json
gjc crash report          # interactive review-and-submit flow
```

The ordering **is** the consent boundary — no network, auth, repo or `gh` probe happens
before step 5:

1. List signatures (count, first/last seen, algorithm version, reported state). A
   non-interactive invocation prints a report file path and refuses to submit.
2. Select a signature; the newest post-feature record with that fingerprint is loaded.
3. The body is built by `sanitizeExternalCrashV1` — a separate, stricter contract than
   the persistence-time `redactCrashSecrets` scrub (which is best-effort credential
   hygiene and is not a privacy guarantee). Field allowlist; paths → placeholders; URLs
   parsed and stripped of userinfo/query/fragment (unparseable ones dropped);
   C0/C1/ANSI/OSC/bidi/zero-width controls removed; CRLF normalized; pid and exact
   timestamps omitted (coarse first/last-seen dates retained); labels sanitized like
   values; per-field and whole-body byte caps (body ≤ 48 KiB). **Scanner uncertainty
   refuses the submission** rather than warning and continuing.
4. Crash-derived text lives only inside fenced blocks with backticks neutralized and `@`
   de-fanged. The title is generic (`crash: <errorName> in <top-frame-path>`, from
   normalized inputs only) and the marker `gjc-crash-fp.v1:<32hex>` is emitted outside
   crash-derived blocks so a forged in-text marker cannot impersonate one.
5. **Immutable snapshot + consent.** The exact final bytes are written to a securely
   created 0600 file (exclusive create, no symlink follow), shown verbatim with their
   sha256 digest and byte length, and confirmed. What is sent is exactly that snapshot.
   The preview names the fixed target repository and, after consent, the active `gh`
   identity.
6. **Duplicate check (after consent, read-only).** The repository is searched for the
   exact versioned marker with `--repo` pinned, and the result URL is validated against
   the canonical repository. A hit is a **candidate only**: the default action prints the
   existing issue URL and stops. An optional "+1" comment needs its own separately-worded
   confirmation and records a per-issue idempotency stamp, so re-invocations and sibling
   accounts on a shared agent dir cannot repeat it. Timeout, auth failure or ambiguity
   **refuses to create** unless the user explicitly overrides the duplicate check.
7. **Submission.** `gh issue create --repo <canonical>` with a body carrying every
   `bug_report.yml` required field: crash-derived fields prefilled, non-derivable fields
   (steps to reproduce, expected behavior, provider, area) filled in interactively before
   the snapshot is frozen, or rendered as an explicit "not captured — please fill in"
   prompt. No token is ever read, stored or embedded. Without `gh`, the flow prints the
   snapshot path plus a prefilled URL built with `URL`/`URLSearchParams` against a fixed
   allowlisted origin carrying only bounded-grammar fields (generic title, fingerprint,
   semver) — never message or stack content, and never auto-opened.
8. On success, `reportedAt` is stamped through the journal so concurrent writers cannot
   lose it.

## 4. Startup nudge

One bounded status line at interactive startup when an unreported, undismissed signature
gained records since the last nudge, at most once per 24 h per agent dir. It reads local
state only — **this piece never transmits anything**.

- Suppressed for print mode, SDK/ACP hosts, workers, daemons, `--version`/`--help` and
  `startup.quiet`; it is routed through the centralized status surface, never `console.*`.
- Dismissal is explicit (the dismiss action in `gjc crash report`), never inferred from an
  ignored line.
- `crashReport.nudge: false` disables it. Honest default statement: the default-on nudge
  **does** change startup output by design (one line, bounded, rate-limited); transmission
  remains impossible without the full consent flow.
