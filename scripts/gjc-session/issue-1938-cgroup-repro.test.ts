import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ISSUE_1938_SCHEMA_CONFORMANCE_REQUIREMENTS, validateEvidence } from "./validate-issue-1938-evidence";
import { validateJsonSchemaValue } from "../../packages/ai/src/utils/schema/json-schema-validator";

import {
	captureCanonicalVerdictBaseline,
	ISSUE_1938_EXPECTED_VERDICT_DEADLINE_MS,
	ISSUE_1938_RECOVERY_VERDICT_DEADLINE_MS,
	probeCanonicalVerdict,
	waitForCanonicalVerdict,
} from "./wait-for-issue-1938-verdict";

const script = await Bun.file(path.join(import.meta.dir, "issue-1938-cgroup-repro.sh")).text();
const schema = JSON.parse(await Bun.file(path.join(import.meta.dir, "fixtures", "issue-1938-evidence.schema.json")).text()) as Record<string, unknown>;
const capabilities = { linux: true, proc: true, systemctl_user: true, systemd_run_user: true, python3: true, script: true, tmux: true, git: true, bun: true, disposable_unit: true };
const key = (id: string, n: number) => `owner-loss:${id}:123e4567-e89b-12d3-a456-42661417400${n}`;
const entry = (id: string, n: number, result = "proven") => {
	const proof = ["raw_proof_before_exec", "managed_proof_before_exec"].includes(id);
	const isolation = id === "isolated_survival";
	return { id, status: "passed", started_at: "2026-07-10T00:00:00Z", completed_at: "2026-07-10T00:00:01Z", subject: { pid: n + 1, name: id, cgroup: "private.scope" }, expected: { signal: proof ? null : "SIGTERM", result }, observed: { signal: proof || isolation ? null : "SIGTERM", result: proof || isolation ? result : id === "expected_close_verdict" ? "owner_term_then_session_cleanup" : id === "unexpected_incident_recovery" ? "unknown_terminal" : result }, ...(proof || isolation ? { scope: `gjc-owner-${n}.scope` } : {}), ...(id === "expected_close_verdict" || id === "unexpected_incident_recovery" ? { dedupe_key: key(id, n) } : {}) };
};
const receipt = (phase: "pre-code" | "post-code", cases: object[], status: "passed" | "failed" | "unsupported" = "passed") => ({ schema_version: 1, issue: "1938", phase, status, generated_at: "2026-07-10T00:00:03Z", source_revision: status === "unsupported" ? null : "a".repeat(40), run_nonce: status === "unsupported" ? null : "123e4567-e89b-12d3-a456-426614174000", capabilities: status === "unsupported" ? { ...capabilities, python3: false, disposable_unit: false } : capabilities, cases, cleanup: { status: status === "unsupported" ? "not_started" : "completed", unit: "gjc-issue1938-test.service", scope: "gjc-owner-test.scope", completed_at: status === "unsupported" ? null : "2026-07-10T00:00:02Z" } });
const preCases = [
	{ ...entry("inherited_baseline_death", 0, "restart"), observed: { signal: "SIGTERM", result: "exited" } },
	entry("manual_scope_survival_direct_term", 1, "survives_then_exits"),
];
const postCases = [
	entry("raw_proof_before_exec", 0),
	entry("managed_proof_before_exec", 1),
	entry("isolated_survival", 2, "survives"),
	{ ...entry("expected_close_verdict", 3, "expected_operator_shutdown"), verdict: "expected_operator_shutdown", observed: { signal: "SIGTERM", result: "owner_term_then_session_cleanup", latency_ms: 100 } },
	{ ...entry("unexpected_incident_recovery", 4, "unexpected_owner_loss"), verdict: "unexpected_owner_loss", observed: { signal: "SIGHUP", result: "unknown_terminal", latency_ms: 5_300 } },

];
const context = (phase: "pre-code" | "post-code", receiptPath?: string) => ({ phase, sourceRevision: "a".repeat(40), runNonce: "123e4567-e89b-12d3-a456-426614174000", receiptPath, nowMs: Date.parse("2026-07-10T00:00:03Z"), maxAgeMs: 60_000 });
const withArtifacts = async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-evidence-artifacts-"));
	const receiptPath = path.join(root, "post-code.json");
	const cases = structuredClone(postCases) as Record<string, unknown>[];
	await fs.mkdir(path.join(root, "artifacts"));
	for (const record of cases.filter(value => ["expected_close_verdict", "unexpected_incident_recovery"].includes(value.id as string))) {
		const observed = record.observed as Record<string, unknown>;
		const generation = (record.dedupe_key as string).split(":").at(-1)!;
		const payload = `${JSON.stringify({ schema_version: 1, generation, session_id: (record.subject as Record<string, unknown>).name, classification: record.verdict, dedupe_key: record.dedupe_key, signal: observed.signal, result: observed.result, observed_at: "2026-07-10T00:00:00.500Z", file_id: "1:2:3:4", published_at_ms: Date.parse("2026-07-10T00:00:00.500Z") })}\n`;
		const artifactPath = `artifacts/${record.id}.canonical.json`;
		await Bun.write(path.join(root, artifactPath), payload);
		record.artifact = { path: artifactPath, sha256: createHash("sha256").update(payload).digest("hex") };
	}
	const value = receipt("post-code", cases);
	await Bun.write(receiptPath, `${JSON.stringify(value)}\n`);
	return { root, receiptPath, cases, value };
};
const runUnsupportedSerializer = async (environment: Record<string, string>) => {
	const sessionId = `serializer-${randomUUID()}`;

	const sessionRoot = path.join(import.meta.dir, "..", "..", ".gjc", `_session-${sessionId}`);
	const evidencePath = path.join(sessionRoot, "runtime", "evidence", "issue-1938", "pre-code.json");
	const proc = Bun.spawn(["bash", path.join(import.meta.dir, "issue-1938-cgroup-repro.sh"), "--phase", "pre-code", "--session-id", sessionId], { env: { ...process.env, GJC_ISSUE1938_TEST_FORCE_UNSUPPORTED: "1", ...environment }, stdout: "pipe", stderr: "pipe" });
	try {
		expect(await proc.exited).toBe(77);
		const value = JSON.parse(await Bun.file(evidencePath).text());
		await expect(validateEvidence(value)).resolves.toBeUndefined();
		return value;
	} finally {
		await fs.rm(sessionRoot, { recursive: true, force: true });
	}
};
const runIndeterminateCleanupProbe = async (probe: "tmux" | "systemd") => {
	const sessionId = `cleanup-${randomUUID()}`;
	const startedAt = Date.now();

	const sessionRoot = path.join(import.meta.dir, "..", "..", ".gjc", `_session-${sessionId}`);
	const evidencePath = path.join(sessionRoot, "runtime", "evidence", "issue-1938", "pre-code.json");
	const proc = Bun.spawn(["bash", path.join(import.meta.dir, "issue-1938-cgroup-repro.sh"), "--phase", "pre-code", "--session-id", sessionId], { env: { ...process.env, GJC_ISSUE1938_TEST_CLEANUP_PROBE_ONLY: probe, ...(probe === "tmux" ? { GJC_ISSUE1938_TEST_TMUX_CLEANUP_PROBE: "error" } : { GJC_ISSUE1938_TEST_SYSTEMD_CLEANUP_PROBE: "error" }) }, stdout: "pipe", stderr: "pipe" });
	try {
		expect(await proc.exited).toBe(1);
		expect(Date.now() - startedAt).toBeLessThan(7_000);
		const value = JSON.parse(await Bun.file(evidencePath).text());
		expect(value.cleanup.status).toBe("failed");
		return value;
	} finally {
		await fs.rm(sessionRoot, { recursive: true, force: true });
	}
};
const runHeldMonitorCleanup = async () => {
	const sessionId = `held-monitor-${randomUUID()}`;
	const sessionRoot = path.join(import.meta.dir, "..", "..", ".gjc", `_session-${sessionId}`);
	const evidencePath = path.join(sessionRoot, "runtime", "evidence", "issue-1938", "pre-code.json");
	const startedAt = Date.now();
	const proc = Bun.spawn(["bash", path.join(import.meta.dir, "issue-1938-cgroup-repro.sh"), "--phase", "pre-code", "--session-id", sessionId], { env: { ...process.env, GJC_ISSUE1938_TEST_CLEANUP_PROBE_ONLY: "monitor" }, stdout: "pipe", stderr: "pipe" });
	try {
		expect(await proc.exited).toBe(1);
		expect(Date.now() - startedAt).toBeLessThan(7_000);
		const value = JSON.parse(await Bun.file(evidencePath).text());
		expect(value.cleanup.status).toBe("completed");
	} finally {
		await fs.rm(sessionRoot, { recursive: true, force: true });
	}
};




describe("issue #1938 evidence", () => {
	test("accepts exactly one complete phase-bound passed case set", async () => {
		await expect(validateEvidence(receipt("pre-code", preCases), context("pre-code"))).resolves.toBeUndefined();
		await expect(validateEvidence(receipt("post-code", postCases), context("post-code"))).rejects.toThrow("artifact");
		await expect(validateEvidence(receipt("pre-code", preCases.slice(1)), context("pre-code"))).rejects.toThrow("exactly");
		await expect(validateEvidence(receipt("post-code", [...postCases, postCases[0]]), context("post-code"))).rejects.toThrow("exactly");
		await expect(validateEvidence(receipt("pre-code", [{ ...preCases[0], status: "failed" }, preCases[1]]), context("pre-code"))).rejects.toThrow("must pass");
		await expect(validateEvidence(receipt("pre-code", preCases), context("post-code"))).rejects.toThrow("file name phase");
	});

	test("enforces cleanup and portable unsupported receipts", async () => {
		await expect(validateEvidence(receipt("pre-code", [], "unsupported"))).resolves.toBeUndefined();
		await expect(validateEvidence({ ...receipt("pre-code", [], "unsupported"), capabilities: { ...capabilities, disposable_unit: false, python3: true } })).rejects.toThrow("missing capability");
		await expect(validateEvidence({ ...receipt("pre-code", preCases), cleanup: { status: "failed", unit: null, scope: null, completed_at: "2026-07-10T00:00:02Z" } }, context("pre-code"))).rejects.toThrow("cleanup");
		await expect(validateEvidence({ ...receipt("pre-code", preCases), cleanup: { status: "completed", unit: "shared.service", scope: "shared.scope", completed_at: "2026-07-10T00:00:02Z" } }, context("pre-code"))).rejects.toThrow("cleanup unit/scope");
		await expect(validateEvidence({ ...receipt("pre-code", [], "unsupported"), cases: [preCases[0]] })).rejects.toThrow("no cases");
	});

	test("uses only private disposable resources for actual restart and counterfactual", () => {
		expect(script).toContain('TMUX_TMPDIR_PRIVATE="$(mktemp -d)"');
		expect(script).toContain('systemctl --user restart "$SERVICE_UNIT"');
		expect(script).toContain('--scope --unit="$SCOPE_UNIT"');
		expect(script).toContain('kill -TERM "$scope_pid"');
		expect(script).toContain('[[ -e "/proc/$pid" ]]');
		expect(script).toContain('TRACKED_UNITS+=("$SERVICE_UNIT")');
		expect(script).toContain('track_server "$WORKTREE/tmux" "$RAW_SOCKET" "${raw_session}-owner-monitor" "$raw_pid"');
		expect(script).toContain('track_server "$WORKTREE/tmux" "$TMUX_SOCKET" "$managed_session" "$pid"');
		expect(script).not.toContain('track_server "$WORKTREE/tmux" "$TMUX_SOCKET" "${managed_session}-owner-monitor"');
		expect(script).toContain('track_server "$WORKTREE/tmux" "$RECOVERY_SOCKET" "${recovery_session}-owner-monitor" "$pid"');
		expect(script).toContain('wait_owned_server_gone "$pid" "$start" "$cgroup"');
		expect(script).toContain('terminate_owned_server "$pid" "$start" "$cgroup"');
		expect(script).toContain('kill -TERM "$pid"');
		expect(script).not.toContain("tmux kill-server");
		expect(script).toContain('rm -f "$EVIDENCE_PATH"');
		expect(script).toContain('[[ "$DISPOSABLE_UNIT" == true ]] || exit 77');
		expect(script).toContain('write_unsupported_evidence');

		expect(script).not.toContain("GJC_SESSION_WORKDIR");
	});
	test("uses measured strict verdict deadlines", () => {
		expect(script).toContain(`EXPECTED_VERDICT_DEADLINE_MS=${ISSUE_1938_EXPECTED_VERDICT_DEADLINE_MS}`);
		expect(script).toContain(`RECOVERY_VERDICT_DEADLINE_MS=${ISSUE_1938_RECOVERY_VERDICT_DEADLINE_MS}`);
		expect(script).toContain('raw_trigger_started_ms="$(date +%s%3N)"');
		expect(script).toContain('recovery_trigger_started_ms="$(date +%s%3N)"');
		expect(script).toContain('--trigger-start-ms "$raw_trigger_started_ms" --deadline-at-ms "$raw_deadline_at_ms"');
		expect(script).toContain('--trigger-start-ms "$recovery_trigger_started_ms" --deadline-at-ms "$recovery_deadline_at_ms"');
		expect(script).toContain('GJC_SESSION_MONITOR_INTERVAL="$MONITOR_INTERVAL_SECONDS"');
		expect(script).not.toContain("seq 1 150");
	});

	test("measures timely publication from the trigger and fails at the exact absolute deadline", async () => {
		let now = 0;
		let probes = 0;
		const input = {
			stateDir: "/state",
			sessionId: "session",
			classification: "unexpected_owner_loss" as const,
			requireIncident: true,
			triggerStartedAtMs: 0,
			deadlineAtMs: 250,
			pollMs: 100,
		};
		const timely = await waitForCanonicalVerdict(input, {
			nowMs: () => now,
			sleep: async ms => {
				now += ms;
			},
		probe: async () => (++probes === 3 ? { dedupeKey: key("session", 9), signal: "SIGTERM", result: "owner_lost" } : null),
		});
		expect(timely).toEqual({ dedupeKey: key("session", 9), signal: "SIGTERM", result: "owner_lost", latencyMs: 200 });

		now = 0;
		const sleeps: number[] = [];
		const timeout = await waitForCanonicalVerdict(input, {
			nowMs: () => now,
			sleep: async ms => {
				sleeps.push(ms);
				now += ms;
			},
		probe: async () => null,
		});
		expect(timeout).toBeNull();
		expect(now).toBe(250);
		expect(sleeps).toEqual([100, 100, 50]);

		now = 0;
		const boundary = await waitForCanonicalVerdict(input, { nowMs: () => now, sleep: async ms => { now += ms; }, probe: async () => (now >= 250 ? { dedupeKey: key("session", 9), signal: "SIGTERM", result: "owner_lost" } : null) });
		expect(boundary).toBeNull();
		now = 200;
		const preWaitTimeout = await waitForCanonicalVerdict(input, { nowMs: () => now, sleep: async ms => { now += ms; }, probe: async () => (now >= 300 ? { dedupeKey: key("session", 9), signal: "SIGTERM", result: "owner_lost" } : null) });
		expect(preWaitTimeout).toBeNull();
		expect(now).toBe(250);

		now = 200;
		const freshWaiterWouldPass = await waitForCanonicalVerdict({ ...input, triggerStartedAtMs: now, deadlineAtMs: now + 250 }, { nowMs: () => now, sleep: async ms => { now += ms; }, probe: async () => (now >= 300 ? { dedupeKey: key("session", 9), signal: "SIGTERM", result: "owner_lost" } : null) });
		expect(freshWaiterWouldPass).toEqual({ dedupeKey: key("session", 9), signal: "SIGTERM", result: "owner_lost", latencyMs: 100 });
	});
	test("rejects a pre-trigger incident bundle even when its timestamps look fresh", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-evidence-baseline-"));
		try {
			const sessionId = "baseline-session", generation = "123e4567-e89b-12d3-a456-426614174009", root = path.join(stateDir, sessionId, "owner-lifecycle"), dedupe = `owner-loss:${sessionId}:${generation}`;
			await fs.mkdir(root, { recursive: true });
			const verdict = { schema_version: 1, generation, session_id: sessionId, classification: "unexpected_owner_loss", dedupe_key: dedupe, signal: "SIGHUP", result: "unknown_terminal", observed_at: new Date().toISOString() };
			const incident = { schema_version: 1, generation, session_id: sessionId, classification: "unexpected_owner_loss", dedupe_key: dedupe };
			const vanished = { schema_version: 1, generation, session_id: sessionId, dedupe_key: dedupe };
			await Bun.write(path.join(root, "generation.json"), JSON.stringify({ schema_version: 1, session_id: sessionId, generation }));
			await Bun.write(path.join(root, `verdict-${generation}.json`), JSON.stringify(verdict));
			await Bun.write(path.join(stateDir, "verdict.json"), JSON.stringify({ ...verdict, owner_generation: generation }));
			await Bun.write(path.join(root, `incident-${generation}.json`), JSON.stringify(incident));
			await Bun.write(path.join(stateDir, "incident.json"), JSON.stringify({ ...incident, owner_generation: generation }));
			await Bun.write(path.join(root, `vanished-${generation}.json`), JSON.stringify(vanished));
			await Bun.write(path.join(stateDir, "vanished.json"), JSON.stringify({ ...vanished, owner_generation: generation }));
			const baseline = await captureCanonicalVerdictBaseline(stateDir, sessionId);
			const triggerStartedAtMs = Date.now() + 100;
			const input = { stateDir, sessionId, classification: "unexpected_owner_loss" as const, requireIncident: true, triggerStartedAtMs, deadlineAtMs: triggerStartedAtMs + 1000, pollMs: 100 };
			await expect(probeCanonicalVerdict({ ...input, baseline })).resolves.toBeNull();
		} finally {
			await fs.rm(stateDir, { recursive: true, force: true });
		}
	});

	test("accepts same-millisecond publication only when the captured identity changed and rejects malformed state", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-evidence-race-"));
		try {
			const sessionId = "race-session", generation = "123e4567-e89b-12d3-a456-426614174009", root = path.join(stateDir, sessionId, "owner-lifecycle"), verdictPath = path.join(root, `verdict-${generation}.json`), trigger = Date.parse("2026-07-10T00:00:00.000Z"), dedupe = `owner-loss:${sessionId}:${generation}`;
			await fs.mkdir(root, { recursive: true });
			await Bun.write(path.join(root, "generation.json"), JSON.stringify({ schema_version: 1, session_id: sessionId, generation }));
			const verdict = { schema_version: 1, generation, session_id: sessionId, classification: "expected_operator_shutdown", dedupe_key: dedupe, signal: "SIGTERM", result: "owner_term_then_session_cleanup", observed_at: "2026-07-10T00:00:00.000Z" };
			await Bun.write(verdictPath, JSON.stringify(verdict)); await Bun.write(path.join(stateDir, "verdict.json"), JSON.stringify({ ...verdict, owner_generation: generation })); await fs.utimes(verdictPath, trigger / 1000, trigger / 1000);
			const baseline = await captureCanonicalVerdictBaseline(stateDir, sessionId);
			await fs.rm(verdictPath);
			await Bun.write(verdictPath, JSON.stringify({ ...verdict, observed_at: "2026-07-10T00:00:00Z" })); await Bun.write(path.join(stateDir, "verdict.json"), JSON.stringify({ ...verdict, observed_at: "2026-07-10T00:00:00Z", owner_generation: generation })); await fs.utimes(verdictPath, trigger / 1000, trigger / 1000);
			const input = { stateDir, sessionId, classification: "expected_operator_shutdown" as const, requireIncident: false, triggerStartedAtMs: trigger, deadlineAtMs: trigger + 1000, pollMs: 10, baseline };
			await expect(probeCanonicalVerdict(input)).resolves.toMatchObject({ dedupeKey: dedupe });
			for (const invalid of [
				{ signal: "SIGKILL", result: "owner_term_then_session_cleanup" },
				{ signal: "SIGTERM", result: "unknown_terminal" },
			]) {
				const invalidVerdict = { ...verdict, ...invalid, observed_at: "2026-07-10T00:00:00.002Z" };
				await Bun.write(verdictPath, JSON.stringify(invalidVerdict));
				await Bun.write(path.join(stateDir, "verdict.json"), JSON.stringify({ ...invalidVerdict, owner_generation: generation }));
				await expect(probeCanonicalVerdict(input)).rejects.toThrow("canonical state invalid");
			}
			await Bun.write(path.join(root, "generation.json"), "{");
			await expect(probeCanonicalVerdict(input)).rejects.toThrow("canonical state invalid");
		} finally { await fs.rm(stateDir, { recursive: true, force: true }); }
	});

	test("rejects strict identifier and timestamp violations", async () => {
		await expect(validateEvidence({ ...receipt("pre-code", preCases), generated_at: "2026-07-10T00:00:03+00:00" }, context("pre-code"))).rejects.toThrow("strict RFC3339");
		await expect(validateEvidence({ ...receipt("pre-code", preCases), source_revision: "A".repeat(40) }, context("pre-code"))).rejects.toThrow("source revision");
		await expect(validateEvidence({ ...receipt("pre-code", preCases), run_nonce: "123e4567-e89b-62d3-a456-426614174000" }, context("pre-code"))).rejects.toThrow("source revision");
		await expect(validateEvidence(receipt("post-code", postCases.map(value => (value as { id?: string }).id === "expected_close_verdict" ? { ...value, dedupe_key: "owner-loss:x:123e4567-e89b-62d3-a456-426614174000" } : value)), context("post-code"))).rejects.toThrow("dedupe_key");
	});

	test("enforces every published public receipt bound", async () => {
		const boundedCase = {
			...preCases[0],
			subject: { pid: 1, name: "n".repeat(256), cgroup: "c".repeat(1024) },
			expected: { signal: "s".repeat(64), result: "r".repeat(128) },
			observed: { signal: "s".repeat(64), result: "r".repeat(128), latency_ms: 6_999 },
			scope: "s".repeat(256),
			verdict: "v".repeat(128),
		};
		const bounded = receipt("pre-code", [boundedCase], "failed");
		await expect(validateEvidence(bounded)).resolves.toBeUndefined();
		for (const mutate of [
			(value: Record<string, unknown>) => (((value.cases as Record<string, unknown>[])[0]!.subject as Record<string, unknown>).name = "n".repeat(257)),
			(value: Record<string, unknown>) => (((value.cases as Record<string, unknown>[])[0]!.subject as Record<string, unknown>).cgroup = "c".repeat(1025)),
			(value: Record<string, unknown>) => (((value.cases as Record<string, unknown>[])[0]!.expected as Record<string, unknown>).signal = "s".repeat(65)),
			(value: Record<string, unknown>) => (((value.cases as Record<string, unknown>[])[0]!.expected as Record<string, unknown>).result = "r".repeat(129)),
			(value: Record<string, unknown>) => ((value.cases as Record<string, unknown>[])[0]!.scope = "s".repeat(257)),
			(value: Record<string, unknown>) => ((value.cases as Record<string, unknown>[])[0]!.verdict = "v".repeat(129)),
			(value: Record<string, unknown>) => (((value.cases as Record<string, unknown>[])[0]!.observed as Record<string, unknown>).latency_ms = 7_000),
		]) {
			const over = structuredClone(bounded) as Record<string, unknown>;
			mutate(over);
			await expect(validateEvidence(over)).rejects.toThrow();
		}
	});

	test("rejects unknown waiter flags", async () => {
		const proc = Bun.spawn([process.execPath, path.join(import.meta.dir, "wait-for-issue-1938-verdict.ts"), "--unknown", "x"], { stdout: "pipe", stderr: "pipe" });
		expect(await proc.exited).toBe(2);
	});

	test("rejects synthetic dedupe keys and unbound passed receipts", async () => {
		await expect(validateEvidence({ ...receipt("pre-code", preCases), run_nonce: null }, context("pre-code"))).rejects.toThrow("expected source revision");
		await expect(validateEvidence(receipt("pre-code", [{ ...preCases[0], dedupe_key: key("synthetic", 1) }, preCases[1]]), context("pre-code"))).rejects.toThrow("dedupe_key");
		await expect(validateEvidence(receipt("post-code", postCases.map(value => (value as { id?: string }).id === "expected_close_verdict" ? { ...value, observed: { signal: "SIGTERM", result: "expected_operator_shutdown", latency_ms: 100 } } : value)), context("post-code"))).rejects.toThrow("contradictory signal/result");
	});

	test("binds passed evidence to artifacts, run context, capabilities, and ordered observations", async () => {
		const fixture = await withArtifacts();
		try {
			await expect(validateEvidence(fixture.value, context("post-code", fixture.receiptPath))).resolves.toBeUndefined();
			await expect(validateEvidence(fixture.value, { ...context("post-code", fixture.receiptPath), sourceRevision: "b".repeat(40) })).rejects.toThrow("expected source revision");
			await expect(validateEvidence(fixture.value, { ...context("post-code", fixture.receiptPath), runNonce: "223e4567-e89b-12d3-a456-426614174000" })).rejects.toThrow("expected source revision");
			await expect(validateEvidence({ ...fixture.value, capabilities: { ...capabilities, tmux: false } }, context("post-code", fixture.receiptPath))).rejects.toThrow("every prerequisite capability");
			const opposite = structuredClone(receipt("pre-code", preCases));
			(opposite.cases[0] as Record<string, unknown>).observed = { signal: null, result: "survives" };
			await expect(validateEvidence(opposite, context("pre-code"))).rejects.toThrow("contradictory signal/result");
			await expect(validateEvidence(fixture.value, { ...context("post-code", fixture.receiptPath), nowMs: Date.parse("2026-07-10T01:00:00Z"), maxAgeMs: 1000 })).rejects.toThrow("not fresh");
			const unordered = structuredClone(fixture.value);
			unordered.cleanup.completed_at = "2026-07-09T23:59:59Z";
			await expect(validateEvidence(unordered, context("post-code", fixture.receiptPath))).rejects.toThrow("unordered");
			const expectedArtifact = path.join(fixture.root, "artifacts", "expected_close_verdict.canonical.json");
			const original = await Bun.file(expectedArtifact).text();
			await Bun.write(expectedArtifact, `${original.trim()} `);
			await expect(validateEvidence(fixture.value, context("post-code", fixture.receiptPath))).rejects.toThrow("digest mismatch");
			await Bun.write(expectedArtifact, original);
			const invalidUtf8 = Buffer.concat([Buffer.from(original.slice(0, -1)), Buffer.from([0xff])]);
			await Bun.write(expectedArtifact, invalidUtf8);
			const invalidUtf8Value = structuredClone(fixture.value);
			const invalidUtf8Record = (invalidUtf8Value.cases as Record<string, unknown>[]).find(record => record.id === "expected_close_verdict")!;
			(invalidUtf8Record.artifact as Record<string, unknown>).sha256 = createHash("sha256").update(invalidUtf8).digest("hex");
			await expect(validateEvidence(invalidUtf8Value, context("post-code", fixture.receiptPath))).rejects.toThrow("not valid UTF-8");
			await Bun.write(expectedArtifact, original);
			const privateArtifact = structuredClone(fixture.value);
			const privateRecord = (privateArtifact.cases as Record<string, unknown>[]).find(record => record.id === "expected_close_verdict")!;
			const privatePayload = JSON.parse(original) as Record<string, unknown>;
			privatePayload.command = "private";
			const privateBytes = `${JSON.stringify(privatePayload)}\n`;
			await Bun.write(expectedArtifact, privateBytes);
			(privateRecord.artifact as Record<string, unknown>).sha256 = createHash("sha256").update(privateBytes).digest("hex");
			await expect(validateEvidence(privateArtifact, context("post-code", fixture.receiptPath))).rejects.toThrow("not allowlisted");
			const oversizedArtifact = structuredClone(fixture.value);
			const oversizedRecord = (oversizedArtifact.cases as Record<string, unknown>[]).find(record => record.id === "expected_close_verdict")!;
			const oversizedPayload = JSON.parse(original) as Record<string, unknown>;
			oversizedPayload.file_id = "1".repeat(257);
			const oversizedBytes = `${JSON.stringify(oversizedPayload)}\n`;
			await Bun.write(expectedArtifact, oversizedBytes);
			(oversizedRecord.artifact as Record<string, unknown>).sha256 = createHash("sha256").update(oversizedBytes).digest("hex");
			await expect(validateEvidence(oversizedArtifact, context("post-code", fixture.receiptPath))).rejects.toThrow("public value limit");
			await Bun.write(expectedArtifact, original);
			await fs.rm(expectedArtifact);
			await expect(validateEvidence(fixture.value, context("post-code", fixture.receiptPath))).rejects.toThrow("artifact is missing");
		} finally {
			await fs.rm(fixture.root, { recursive: true, force: true });
		}
	});

	test("classifies artifact absence separately from filesystem read failures", async () => {
		const fixture = await withArtifacts();
		try {
			const missing = path.join(fixture.root, "artifacts", "expected_close_verdict.canonical.json");
			await fs.rm(missing);
			await expect(validateEvidence(fixture.value, context("post-code", fixture.receiptPath))).rejects.toThrow("artifact is missing");
			await fs.mkdir(missing);
			await expect(validateEvidence(fixture.value, context("post-code", fixture.receiptPath))).rejects.toThrow("artifact read failed (EISDIR)");
		} finally {
			await fs.rm(fixture.root, { recursive: true, force: true });
		}
	});

	test("validates complete receipt instances with the draft-2020-12 harness", () => {
		const validate = (value: unknown) => validateJsonSchemaValue(schema, value).success;
		const schemaPostCases = structuredClone(postCases) as Record<string, unknown>[];
		for (const record of schemaPostCases.filter(value =>
			["expected_close_verdict", "unexpected_incident_recovery"].includes(value.id as string),
		)) {
			record.artifact = {
				path: `artifacts/${record.id}.canonical.json`,
				sha256: "a".repeat(64),
			};
		}
		expect(validate(receipt("pre-code", preCases))).toBe(true);
		expect(validate(receipt("post-code", schemaPostCases))).toBe(true);
		expect(validate(receipt("pre-code", [], "unsupported"))).toBe(true);
		expect(validate({ ...receipt("pre-code", preCases), unexpected: true })).toBe(false);
		const missing = receipt("pre-code", preCases) as Record<string, unknown>;
		delete missing.cleanup;
		expect(validate(missing)).toBe(false);
		expect(validate({ ...receipt("pre-code", preCases), generated_at: 1 })).toBe(false);
		expect(validate({ ...receipt("pre-code", preCases), source_revision: "A".repeat(40) })).toBe(false);
		expect(validate({ ...receipt("pre-code", [], "unsupported"), cases: [preCases[0]] })).toBe(false);
		expect(validate({ ...receipt("pre-code", preCases), run_nonce: "not-a-uuid" })).toBe(false);
	});
	test("renders semantically valid unsupported receipts through every available serializer", async () => {
		const environments: Array<Record<string, string>> = [
			{},
			{ GJC_ISSUE1938_TEST_DISABLE_PYTHON: "1" },
			{ GJC_ISSUE1938_TEST_DISABLE_PYTHON: "1", GJC_ISSUE1938_TEST_DISABLE_BUN: "1" },
		];
		for (const environment of environments) {
			const value = await runUnsupportedSerializer(environment);
			expect(value.status).toBe("unsupported");
			expect(value.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/);
			if (environment.GJC_ISSUE1938_TEST_DISABLE_BUN === "1") {
				expect(value.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
			} else {
				expect(value.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
			}
			expect(value.cases).toEqual([]);
			expect(value.cleanup).toEqual({ status: "not_started", unit: null, scope: null, completed_at: null });
		}
	});
	test("preserves subsecond ordering for passed artifact receipts", () => {
		expect(script).toContain('isoformat(timespec="milliseconds")');
		expect(script).toContain("new Date().toISOString()");
	});
	test("leaves no partial receipt when same-directory atomic publication is interrupted", async () => {
		for (const environment of [{}, { GJC_ISSUE1938_TEST_DISABLE_PYTHON: "1" }, { GJC_ISSUE1938_TEST_DISABLE_PYTHON: "1", GJC_ISSUE1938_TEST_DISABLE_BUN: "1" }]) {
			const sessionId = `serializer-interrupted-${randomUUID()}`;
			const sessionRoot = path.join(import.meta.dir, "..", "..", ".gjc", `_session-${sessionId}`);
			const evidencePath = path.join(sessionRoot, "runtime", "evidence", "issue-1938", "pre-code.json");
			const proc = Bun.spawn(["bash", path.join(import.meta.dir, "issue-1938-cgroup-repro.sh"), "--phase", "pre-code", "--session-id", sessionId], { env: { ...process.env, GJC_ISSUE1938_TEST_FORCE_UNSUPPORTED: "1", GJC_ISSUE1938_TEST_FAIL_EVIDENCE_RENAME: "1", ...environment }, stdout: "pipe", stderr: "pipe" });
			try {
				expect(await proc.exited).toBe(1);
				expect(await Bun.file(evidencePath).exists()).toBe(false);
				expect((await fs.readdir(path.dirname(evidencePath))).filter(name => name.includes(".pre-code.json."))).toEqual([]);
			} finally {
				await fs.rm(sessionRoot, { recursive: true, force: true });
			}
		}
	});
test("leaves no partial receipt when the Python serializer fails", async () => {
	const sessionId = `serializer-failed-${randomUUID()}`;
	const sessionRoot = path.join(import.meta.dir, "..", "..", ".gjc", `_session-${sessionId}`);
	const evidencePath = path.join(sessionRoot, "runtime", "evidence", "issue-1938", "pre-code.json");
	const proc = Bun.spawn(["bash", path.join(import.meta.dir, "issue-1938-cgroup-repro.sh"), "--phase", "pre-code", "--session-id", sessionId], { env: { ...process.env, GJC_ISSUE1938_TEST_FORCE_UNSUPPORTED: "1", GJC_ISSUE1938_TEST_FAIL_PYTHON_SERIALIZER: "1" }, stdout: "pipe", stderr: "pipe" });
	try {
		expect(await proc.exited).toBe(1);
		expect(await Bun.file(evidencePath).exists()).toBe(false);
		expect((await fs.readdir(path.dirname(evidencePath))).filter(name => name.includes(".pre-code.json."))).toEqual([]);
	} finally {
		await fs.rm(sessionRoot, { recursive: true, force: true });
	}
});

	test("waits for held monitor sessions and fails closed on indeterminate cleanup probes", async () => {
		await runHeldMonitorCleanup();
		await runIndeterminateCleanupProbe("tmux");
		await runIndeterminateCleanupProbe("systemd");
		expect(script).toContain('monitor_session="issue1938-held-owner-monitor"');
		expect(script).toContain('[[ $state -eq 2 ]] && return 1');
		expect(script).toContain('[[ $rc -eq 0 ]] || return 2');
		expect(script).toContain('"$output" == *"can\'t find session"*');
	});

	test("keeps published schema passed semantics aligned with executable validation", async () => {
		expect(schema.additionalProperties).toBe(false);
		expect(JSON.stringify(schema)).toContain('"artifact"');
		expect(JSON.stringify(schema)).not.toContain('"pty"');
		expect(ISSUE_1938_SCHEMA_CONFORMANCE_REQUIREMENTS).toEqual([
			"passed requires non-null source_revision and run_nonce, every capability true, and cleanup.status completed with completed_at",
			"passed pre-code and post-code receipts require exactly their phase-specific passed case IDs with the executable signal/result, scope, dedupe_key, artifact, and strict latency semantics",
			"post-code verdict artifacts require exact public keys schema_version,generation,session_id,classification,dedupe_key,signal,result,observed_at,file_id,published_at_ms; no additional properties; bounded values",
		]);
		expect(validateJsonSchemaValue(schema, { ...receipt("pre-code", preCases), source_revision: null }).success).toBe(false);
		expect(
			validateJsonSchemaValue(schema, {
				...receipt("post-code", postCases),
				capabilities: { ...capabilities, tmux: false },
			}).success,
		).toBe(false);
		expect(validateJsonSchemaValue(schema, receipt("post-code", postCases.slice(0, 4))).success).toBe(false);
		const invalidCleanup = receipt("post-code", postCases);
		invalidCleanup.cleanup = { ...invalidCleanup.cleanup, unit: "shared.service", scope: "shared.scope" };
		expect(validateJsonSchemaValue(schema, invalidCleanup).success).toBe(false);
		const unknownRecovery = receipt(
			"post-code",
			postCases.map(record => {
				if (record.id !== "expected_close_verdict" && record.id !== "unexpected_incident_recovery") return record;
				return {
					...record,
					...(record.id === "unexpected_incident_recovery"
						? { observed: { ...record.observed, signal: "UNKNOWN" } }
						: {}),
					artifact: { path: `artifacts/${record.id}.canonical.json`, sha256: "a".repeat(64) },
				};
			}),
		);
		expect(validateJsonSchemaValue(schema, unknownRecovery).success).toBe(true);
		await expect(validateEvidence(unknownRecovery, context("post-code"))).rejects.not.toThrow(
			"contradictory signal/result semantics",
		);
		const schemaCases = unknownRecovery.cases as object[];
		const reordered = receipt("post-code", [schemaCases[1]!, schemaCases[0]!, ...schemaCases.slice(2)]);
		expect(validateJsonSchemaValue(schema, reordered).success).toBe(true);
		const artifactFixture = await withArtifacts();
		try {
			const cases = artifactFixture.value.cases as object[];
			artifactFixture.value.cases = [cases[1]!, cases[0]!, ...cases.slice(2)];
			await expect(
				validateEvidence(artifactFixture.value, context("post-code", artifactFixture.receiptPath)),
			).resolves.toBeUndefined();
		} finally {
			await fs.rm(artifactFixture.root, { recursive: true, force: true });
		}
		await expect(validateEvidence({ ...receipt("pre-code", preCases), pane: "private" }, context("pre-code"))).rejects.toThrow("not allowlisted");
	});
});
