import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	createJsonNoClobber,
	detectWorkflowEnvelopeIntegrityMismatch,
	forceOverwrite,
	removeActiveEntry,
	StateWriteConflictError,
	updateJsonAtomic,
	workflowEnvelopeContentSha256,
	writeActiveEntry,
	writeGuardedJsonAtomic,
	writeGuardedWorkflowEnvelopeAtomic,
	writeJsonAtomic,
} from "../src/gjc-runtime/state-writer";

describe("GJC state writer revision policy", () => {
	let tempDir: string | undefined;

	afterEach(async () => {
		if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	});

	async function cwd(): Promise<string> {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-state-writer-policy-"));
		return tempDir;
	}

	function receipt(root: string, sessionId = "sess") {
		return {
			cwd: root,
			skill: "deep-interview" as const,
			owner: "gjc-runtime" as const,
			command: "test",
			sessionId,
			nowIso: "2026-01-01T00:00:00.000Z",
		};
	}

	function modeEnvelope(phase: string) {
		return {
			skill: "deep-interview",
			current_phase: phase,
			active: true,
			version: 2,
			updated_at: "2026-01-01T00:00:00.000Z",
		};
	}

	async function readJson(root: string, targetPath: string): Promise<Record<string, unknown>> {
		return JSON.parse(await fs.readFile(path.join(root, targetPath), "utf-8"));
	}

	it("source write with stale expectedRevision throws and preserves the newer record", async () => {
		const root = await cwd();
		const target = ".gjc/state/source.json";

		await writeGuardedJsonAtomic(target, { value: "first" }, { cwd: root, policy: "source" });
		await writeGuardedJsonAtomic(target, { value: "second" }, { cwd: root, policy: "source", expectedRevision: 1 });

		await expect(
			writeGuardedJsonAtomic(target, { value: "stale" }, { cwd: root, policy: "source", expectedRevision: 1 }),
		).rejects.toBeInstanceOf(StateWriteConflictError);

		await expect(readJson(root, target)).resolves.toMatchObject({ value: "second", state_revision: 2 });
	});

	it("treats a persisted record without state_revision as revision 0", async () => {
		const root = await cwd();
		const target = ".gjc/state/migration.json";
		await fs.mkdir(path.dirname(path.join(root, target)), { recursive: true });
		await fs.writeFile(path.join(root, target), JSON.stringify({ value: "legacy" }, null, 2));

		await writeGuardedJsonAtomic(target, { value: "migrated" }, { cwd: root, policy: "source" });

		await expect(readJson(root, target)).resolves.toMatchObject({ value: "migrated", state_revision: 1 });
	});

	it("ignores payload-supplied state_revision when stamping source writes", async () => {
		const root = await cwd();
		const target = ".gjc/state/payload-revision.json";

		await writeGuardedJsonAtomic(target, { value: "initial", state_revision: 99 }, { cwd: root, policy: "source" });
		await expect(readJson(root, target)).resolves.toMatchObject({ value: "initial", state_revision: 1 });

		await writeGuardedJsonAtomic(target, { value: "next", state_revision: 1 }, { cwd: root, policy: "source" });
		await expect(readJson(root, target)).resolves.toMatchObject({ value: "next", state_revision: 2 });
	});

	it("stale-skips cache writes when sourceRevision is older or equal to persisted", async () => {
		const root = await cwd();
		const target = ".gjc/state/cache.json";

		await writeGuardedJsonAtomic(target, { value: "newer" }, { cwd: root, policy: "cache", sourceRevision: 5 });
		const result = await writeGuardedJsonAtomic(
			target,
			{ value: "older" },
			{ cwd: root, policy: "cache", sourceRevision: 5 },
		);

		expect(result).toEqual({ path: path.join(root, target), written: false, reason: "stale-skip", revision: 1 });
		await expect(readJson(root, target)).resolves.toMatchObject({
			value: "newer",
			source_state_revision: 5,
			state_revision: 1,
		});
	});

	it("writes cache payloads when sourceRevision is newer and bumps cache state_revision", async () => {
		const root = await cwd();
		const target = ".gjc/state/cache-overwrite.json";

		await writeGuardedJsonAtomic(target, { value: "old" }, { cwd: root, policy: "cache", sourceRevision: 2 });
		const result = await writeGuardedJsonAtomic(
			target,
			{ value: "new" },
			{ cwd: root, policy: "cache", sourceRevision: 3 },
		);

		expect(result).toMatchObject({
			path: path.join(root, target),
			written: true,
			revision: 2,
			stamped: { value: "new", source_state_revision: 3, state_revision: 2 },
		});
		await expect(readJson(root, target)).resolves.toMatchObject({
			value: "new",
			source_state_revision: 3,
			state_revision: 2,
		});
	});

	it("authoritative mode-state write conflict fails visibly and preserves newer state", async () => {
		const root = await cwd();
		const target = ".gjc/_session-sess/state/deep-interview-state.json";
		const base = modeEnvelope("interviewing");
		await writeGuardedWorkflowEnvelopeAtomic(target, base, { cwd: root, policy: "source", receipt: receipt(root) });
		await writeGuardedWorkflowEnvelopeAtomic(
			target,
			{ ...base, current_phase: "handoff" },
			{ cwd: root, policy: "source", expectedRevision: 1, receipt: receipt(root) },
		);

		await expect(
			writeGuardedWorkflowEnvelopeAtomic(
				target,
				{ ...base, current_phase: "stale" },
				{ cwd: root, policy: "source", expectedRevision: 1, receipt: receipt(root) },
			),
		).rejects.toBeInstanceOf(StateWriteConflictError);

		await expect(readJson(root, target)).resolves.toMatchObject({ current_phase: "handoff", state_revision: 2 });
	});

	it("guarded workflow envelope checksum covers final receipt and state_revision", async () => {
		const root = await cwd();
		const target = ".gjc/_session-sess/state/deep-interview-state.json";

		await writeGuardedWorkflowEnvelopeAtomic(target, modeEnvelope("interviewing"), {
			cwd: root,
			policy: "source",
			receipt: receipt(root),
		});

		await expect(detectWorkflowEnvelopeIntegrityMismatch(path.join(root, target))).resolves.toBeUndefined();
		await expect(readJson(root, target)).resolves.toMatchObject({
			state_revision: 1,
			receipt: { content_sha256: {} },
		});
	});
	it("creates the canonical active snapshot before accepting a receipt-bearing envelope", async () => {
		const root = await cwd();
		const target = ".gjc/_session-sess/state/deep-interview-state.json";
		const filePath = path.join(root, target);

		await writeGuardedWorkflowEnvelopeAtomic(target, modeEnvelope("interviewing"), {
			cwd: root,
			policy: "source",
			receipt: receipt(root),
		});

		const persisted = await readJson(root, target);
		const statePath = (persisted.receipt as Record<string, unknown>).state_path as string;
		await expect(fs.stat(statePath)).resolves.toMatchObject({ isFile: expect.any(Function) });

		await fs.rm(statePath);
		await expect(detectWorkflowEnvelopeIntegrityMismatch(filePath)).resolves.toMatchObject({
			reason: "missing_active_snapshot",
			expected: statePath,
			actual: "missing",
		});
	});
	it("fails closed and preserves corrupt or malformed active snapshots before mode-state publication", async () => {
		const root = await cwd();
		const target = ".gjc/_session-sess/state/deep-interview-state.json";
		const snapshotPath = path.join(root, ".gjc/_session-sess/state/skill-active-state.json");
		await fs.mkdir(path.dirname(snapshotPath), { recursive: true });

		for (const [snapshot, error] of [
			["{ not valid json", /canonical active snapshot is corrupt/i],
			[JSON.stringify({ active: "not a boolean" }), /canonical active snapshot is malformed/i],
		] as const) {
			await fs.writeFile(snapshotPath, snapshot);
			await expect(
				writeGuardedWorkflowEnvelopeAtomic(target, modeEnvelope("interviewing"), {
					cwd: root,
					policy: "source",
					receipt: receipt(root),
				}),
			).rejects.toThrow(error);
			expect(await fs.readFile(snapshotPath, "utf-8")).toBe(snapshot);
			await expect(fs.access(path.join(root, target))).rejects.toThrow();
		}
	});

	it("rejects generic receipt-bearing canonical mode-state writers without breaking non-canonical guarded writes", async () => {
		const root = await cwd();
		const target = ".gjc/_session-sess/state/deep-interview-state.json";
		const options = { cwd: root, receipt: receipt(root) };

		await expect(
			writeGuardedJsonAtomic(target, modeEnvelope("interviewing"), { ...options, policy: "source" }),
		).rejects.toThrow(/writeWorkflowEnvelopeAtomic or writeGuardedWorkflowEnvelopeAtomic/i);
		await expect(writeJsonAtomic(target, modeEnvelope("interviewing"), options)).rejects.toThrow(
			/writeWorkflowEnvelopeAtomic or writeGuardedWorkflowEnvelopeAtomic/i,
		);
		await expect(updateJsonAtomic(target, () => modeEnvelope("interviewing"), options)).rejects.toThrow(
			/writeWorkflowEnvelopeAtomic or writeGuardedWorkflowEnvelopeAtomic/i,
		);
		await expect(createJsonNoClobber(target, modeEnvelope("interviewing"), options)).rejects.toThrow(
			/writeWorkflowEnvelopeAtomic or writeGuardedWorkflowEnvelopeAtomic/i,
		);
		await expect(fs.access(path.join(root, target))).rejects.toThrow();
		await expect(forceOverwrite(target, { receipt: {} }, { ...options, raw: true })).rejects.toThrow(
			/writeWorkflowEnvelopeAtomic or writeGuardedWorkflowEnvelopeAtomic/i,
		);

		const probe = ".gjc/_session-sess/state/cas-probe.json";
		await writeGuardedJsonAtomic(probe, { value: "compatible" }, { ...options, policy: "source" });
		await expect(readJson(root, probe)).resolves.toMatchObject({
			value: "compatible",
			receipt: { skill: "deep-interview" },
			state_revision: 1,
		});
	});
	it("accepts a valid pre-existing active snapshot without replacing it", async () => {
		const root = await cwd();
		const target = ".gjc/_session-sess/state/deep-interview-state.json";
		const snapshotPath = path.join(root, ".gjc/_session-sess/state/skill-active-state.json");
		const snapshot = JSON.stringify({ version: 1, active: false, active_skills: [] }, null, 2);
		await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
		await fs.writeFile(snapshotPath, snapshot);

		await writeGuardedWorkflowEnvelopeAtomic(target, modeEnvelope("interviewing"), {
			cwd: root,
			policy: "source",
			receipt: receipt(root),
		});

		expect(await fs.readFile(snapshotPath, "utf-8")).toBe(snapshot);
	});

	it("detects covered_path-only checksum metadata tampering", async () => {
		const root = await cwd();
		const target = ".gjc/_session-sess/state/deep-interview-state.json";
		const filePath = path.join(root, target);

		await writeGuardedWorkflowEnvelopeAtomic(target, modeEnvelope("interviewing"), {
			cwd: root,
			policy: "source",
			receipt: receipt(root),
		});

		const persisted = await readJson(root, target);
		const checksum = (persisted.receipt as Record<string, unknown>).content_sha256 as Record<string, unknown>;
		checksum.covered_path = path.join(root, ".gjc", "_session-sess", "state", "ralplan-state.json");
		checksum.value = workflowEnvelopeContentSha256(persisted);
		await fs.writeFile(filePath, JSON.stringify(persisted, null, 2));

		await expect(detectWorkflowEnvelopeIntegrityMismatch(filePath)).resolves.toMatchObject({
			reason: "covered_path",
			expected: filePath,
			actual: path.join(root, ".gjc", "_session-sess", "state", "ralplan-state.json"),
		});
	});

	it("deep-interview recorder conflict fails visibly for direct recorder writes", async () => {
		const root = await cwd();
		const target = ".gjc/_session-sess/state/deep-interview-state.json";
		const base = {
			...modeEnvelope("interviewing"),
			state: { rounds: [{ round_key: "r1", round: 1 }] },
		};
		await writeGuardedWorkflowEnvelopeAtomic(target, base, { cwd: root, policy: "source", receipt: receipt(root) });
		await writeGuardedWorkflowEnvelopeAtomic(
			target,
			{ ...base, state: { rounds: [{ round_key: "r2", round: 2 }] } },
			{ cwd: root, policy: "source", expectedRevision: 1, receipt: receipt(root) },
		);

		await expect(
			writeGuardedWorkflowEnvelopeAtomic(
				target,
				{ ...base, state: { rounds: [{ round_key: "stale", round: 3 }] } },
				{ cwd: root, policy: "source", expectedRevision: 1, receipt: receipt(root) },
			),
		).rejects.toBeInstanceOf(StateWriteConflictError);

		await expect(readJson(root, target)).resolves.toMatchObject({
			state: { rounds: [{ round_key: "r2", round: 2 }] },
			state_revision: 2,
		});
	});

	it("ultragoal authoritative ledger conflict fails visibly and does not drop event", async () => {
		const root = await cwd();
		const target = ".gjc/_session-sess/ultragoal/goals.json";
		const base = { version: 1, goals: [{ id: "G001", status: "pending" }], updatedAt: "t0" };
		await writeGuardedJsonAtomic(target, base, { cwd: root, policy: "source" });
		await writeGuardedJsonAtomic(
			target,
			{ ...base, goals: [{ id: "G001", status: "active" }], updatedAt: "t1" },
			{ cwd: root, policy: "source", expectedRevision: 1 },
		);

		await expect(
			writeGuardedJsonAtomic(
				target,
				{ ...base, goals: [{ id: "G001", status: "complete" }], updatedAt: "stale" },
				{ cwd: root, policy: "source", expectedRevision: 1 },
			),
		).rejects.toBeInstanceOf(StateWriteConflictError);

		await expect(readJson(root, target)).resolves.toMatchObject({
			goals: [{ id: "G001", status: "active" }],
			updatedAt: "t1",
			state_revision: 2,
		});
	});

	describe("active cache removal revision policy", () => {
		it("stale removal preserves a newer active entry", async () => {
			const root = await cwd();
			await writeActiveEntry(
				root,
				{ sessionId: "sess" },
				"deep-interview",
				{ skill: "deep-interview", active: true, phase: "interviewing", source_state_revision: 5 },
				{ cwd: root },
			);

			const result = await removeActiveEntry(root, { sessionId: "sess" }, "deep-interview", {
				cwd: root,
				sourceRevision: 4,
			});

			expect(result.deleted).toBe(false);
			await expect(readJson(root, ".gjc/_session-sess/state/active/deep-interview.json")).resolves.toMatchObject({
				skill: "deep-interview",
				source_state_revision: 5,
			});
		});

		it("same or newer revision removal deletes the active entry", async () => {
			const root = await cwd();
			await writeActiveEntry(
				root,
				{ sessionId: "sess" },
				"deep-interview",
				{ skill: "deep-interview", active: true, phase: "interviewing", source_state_revision: 5 },
				{ cwd: root },
			);

			const result = await removeActiveEntry(root, { sessionId: "sess" }, "deep-interview", {
				cwd: root,
				sourceRevision: 5,
			});

			expect(result.deleted).toBe(true);
			await expect(
				fs.stat(path.join(root, ".gjc/_session-sess/state/active/deep-interview.json")),
			).rejects.toThrow();
		});
	});
});
