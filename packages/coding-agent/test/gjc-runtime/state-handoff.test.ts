import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	crystalMarkdown,
	crystalSnapshotDigest,
	type DeepInterviewCrystal,
} from "@gajae-code/coding-agent/gjc-runtime/deep-interview-crystallize";
import { runNativeDeepInterviewCommand } from "@gajae-code/coding-agent/gjc-runtime/deep-interview-runtime";
import {
	createDeepInterviewIntentManifest,
	reviewDeepInterviewIntent,
} from "@gajae-code/coding-agent/gjc-runtime/deep-interview-state";
import {
	activeSnapshotPath,
	modeStatePath,
	sessionSpecsDir,
	sessionStateDir,
} from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import {
	reconcileWorkflowSkillState,
	runNativeStateCommand,
	type StateCommandResult,
} from "../../src/gjc-runtime/state-runtime";
import { stampWorkflowEnvelopeChecksum, withWorkflowStateLock } from "../../src/gjc-runtime/state-writer";
import { WORKFLOW_STATE_VERSION } from "../../src/skill-state/workflow-state-contract";

const TEST_SESSION_ID = "test-session";

function readyCrystal(): DeepInterviewCrystal {
	const messages = [{ index: 0, role: "user" as const, content: "Build the approved feature." }];
	return {
		schema_version: 1,
		spec_version: 1,
		lifecycle: "ready",
		source: {
			revision: 1,
			start: 0,
			end: 0,
			messages,
			digest: crystalSnapshotDigest({ revision: 1, start: 0, end: 0, messages }),
		},
		items: [
			{
				id: "goal:approved-feature",
				kind: "goal",
				classification: "confirmed",
				statement: "Build the approved feature",
				anchor: { message_index: 0, quote: "Build the approved feature." },
			},
		],
		open_gaps: [],
		conflicts: [],
		delta: {
			kind: "none",
			changed_ids: [],
			added_ids: ["goal:approved-feature"],
			preserved_ids: [],
			approval_invalidated: false,
		},
		execution_approval: "not-approved",
	};
}

async function writePublishedReadyCrystal(cwd: string): Promise<{ callerPath: string; specPath: string }> {
	const crystal = readyCrystal();
	const content = crystalMarkdown(crystal);
	const specsDir = sessionSpecsDir(cwd, TEST_SESSION_ID);
	const specPath = path.join(specsDir, "deep-interview-approved-v1.md");
	const callerPath = modeStatePath(cwd, TEST_SESSION_ID, "deep-interview");
	await fs.mkdir(specsDir, { recursive: true });
	await fs.writeFile(specPath, content);
	const published = stampWorkflowEnvelopeChecksum(
		{
			skill: "deep-interview",
			version: 2,
			session_id: TEST_SESSION_ID,
			active: true,
			current_phase: "handoff",
			spec_path: specPath,
			spec_sha256: createHash("sha256").update(content).digest("hex"),
			state: {
				crystal,
				execution_approval: "not-approved",
				rounds: [],
				established_facts: [],
			},
			receipt: { owner: "gjc-runtime", command: "gjc deep-interview crystallize" },
		},
		callerPath,
	);
	await writeJson(callerPath, published);
	return { callerPath, specPath };
}

async function writeLegacyApprovedCrystal(cwd: string): Promise<string> {
	const crystal = readyCrystal();
	const content = crystalMarkdown(crystal);
	const specsDir = sessionSpecsDir(cwd, TEST_SESSION_ID);
	const specPath = path.join(specsDir, "deep-interview-legacy-v1.md");
	const callerPath = modeStatePath(cwd, TEST_SESSION_ID, "deep-interview");
	const specSha256 = createHash("sha256").update(content).digest("hex");
	await fs.mkdir(specsDir, { recursive: true });
	await fs.writeFile(specPath, content);
	await writeJson(
		callerPath,
		stampWorkflowEnvelopeChecksum(
			{
				skill: "deep-interview",
				version: 1,
				session_id: TEST_SESSION_ID,
				active: true,
				current_phase: "handoff",
				spec_path: specPath,
				spec_sha256: specSha256,
				state: {
					crystal,
					execution_approval: "approved",
					execution_approval_receipt: {
						method: "explicit-state-action",
						approved_at: "2026-09-03T00:00:00.000Z",
						mutation_id: "legacy-forged-approval",
						spec_sha256: specSha256,
						crystal_spec_version: crystal.spec_version,
						crystal_source_digest: crystal.source.digest,
					},
				},
				receipt: { owner: "gjc-runtime", command: "gjc deep-interview crystallize" },
			},
			callerPath,
		),
	);
	return callerPath;
}

function restoreSessionId(sessionId: string | undefined): void {
	if (sessionId === undefined) delete process.env.GJC_SESSION_ID;
	else process.env.GJC_SESSION_ID = sessionId;
}

function restoreEnvironmentValue(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function parseRequiredJson(text: string | undefined, source: string): Record<string, unknown> {
	if (typeof text !== "string" || text.trim().length === 0) {
		throw new Error(`${source} must contain non-empty JSON output`);
	}
	const parsed: unknown = JSON.parse(text);
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${source} must contain a JSON object`);
	}
	return parsed as Record<string, unknown>;
}

async function withTempCwd(fn: (cwd: string) => Promise<void>): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-state-handoff-"));
	// Most tests use an isolated session id so the runtime's env-default lookup
	// cannot select a host-shell session. Tests targeting that lookup set and
	// restore their own session id exactly.
	const priorSessionId = process.env.GJC_SESSION_ID;
	process.env.GJC_SESSION_ID = TEST_SESSION_ID;
	try {
		await fn(dir);
	} finally {
		restoreSessionId(priorSessionId);
		await fs.rm(dir, { recursive: true, force: true });
	}
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, JSON.stringify(value, null, 2));
}

async function readJson(filePath: string): Promise<Record<string, unknown> | null> {
	try {
		const raw = await fs.readFile(filePath, "utf-8");
		return parseRequiredJson(raw, `JSON file ${filePath}`);
	} catch (err) {
		const e = err as NodeJS.ErrnoException;
		if (e.code === "ENOENT") return null;
		throw err;
	}
}

describe("gjc state handoff", () => {
	it("transitions caller -> callee atomically across mode-state and active-state", async () => {
		await withTempCwd(async cwd => {
			const callerPath = modeStatePath(cwd, TEST_SESSION_ID, "deep-interview");
			await writeJson(callerPath, {
				skill: "deep-interview",
				version: 1,
				active: true,
				current_phase: "interviewing",
				updated_at: "2026-01-01T00:00:00.000Z",
			});

			const result = await runNativeStateCommand(
				["handoff", "--mode", "deep-interview", "--to", "ralplan", "--json"],
				cwd,
			);
			expect(result.status).toBe(0);
			const payload = parseRequiredJson(result.stdout, "handoff stdout");
			expect(payload.from).toBe("deep-interview");
			expect(payload.to).toBe("ralplan");
			expect(typeof payload.handoff_at).toBe("string");
			expect(payload.ok).toBe(true);
			expect(payload.state).toBeUndefined();
			const handoffAt = payload.handoff_at as string;

			const caller = await readJson(callerPath);
			expect(caller?.active).toBe(false);
			expect(caller?.current_phase).toBe("handoff");
			expect(caller?.handoff_to).toBe("ralplan");
			expect(caller?.handoff_at).toBe(handoffAt);
			expect(caller?.version).toBe(WORKFLOW_STATE_VERSION);

			const callee = await readJson(modeStatePath(cwd, TEST_SESSION_ID, "ralplan"));
			expect(callee?.active).toBe(true);
			expect(callee?.handoff_from).toBe("deep-interview");
			expect(callee?.handoff_at).toBe(handoffAt);
			expect(callee?.version).toBe(WORKFLOW_STATE_VERSION);

			const activeState = await readJson(activeSnapshotPath(cwd, TEST_SESSION_ID));
			const activeSkills = (activeState?.active_skills as Array<Record<string, unknown>>) ?? [];
			// Handoff demotes the caller to active:false with handoff_to lineage so
			// downstream readers can audit the transition; HUD readers filter on
			// active!==false so the demoted entry stays out of the visible bar.
			const ralplan = activeSkills.find(e => e.skill === "ralplan");
			const di = activeSkills.find(e => e.skill === "deep-interview");
			expect(ralplan?.active).toBe(true);
			expect(ralplan?.handoff_from).toBe("deep-interview");
			expect(typeof ralplan?.handoff_at).toBe("string");
			expect(di?.active).toBe(false);
			expect(di?.handoff_to).toBe("ralplan");
			expect(di?.handoff_at).toBe(handoffAt);
		});
	});
	it("records ready-Crystal execution approval only through a separate explicit action", async () => {
		await withTempCwd(async cwd => {
			const { callerPath } = await writePublishedReadyCrystal(cwd);
			const approval = await runNativeDeepInterviewCommand(["approve-execution", "--json"], cwd);
			expect(approval.status).toBe(0);
			const after = (await readJson(callerPath)) as Record<string, unknown>;
			expect((after.state as Record<string, unknown>).execution_approval).toBe("approved");
			expect((after.state as Record<string, unknown>).execution_approval_receipt).toMatchObject({
				method: "explicit-state-action",
			});
			const handoff = await runNativeStateCommand(
				["handoff", "--mode", "deep-interview", "--to", "ultragoal", "--json"],
				cwd,
			);
			expect(handoff.status).toBe(0);
		});
	});
	it("rejects execution approval when no canonical ready Crystal exists", async () => {
		await withTempCwd(async cwd => {
			const specPath = path.join(cwd, "legacy.md");
			await fs.writeFile(specPath, "# Legacy\n");
			const callerPath = modeStatePath(cwd, TEST_SESSION_ID, "deep-interview");
			await writeJson(callerPath, {
				skill: "deep-interview",
				version: 2,
				active: true,
				current_phase: "handoff",
				spec_path: specPath,
				spec_sha256: createHash("sha256").update("# Legacy\n").digest("hex"),
				state: { rounds: [], established_facts: [] },
			});
			const before = await fs.readFile(callerPath, "utf-8");
			const result = await runNativeDeepInterviewCommand(["approve-execution", "--json"], cwd);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain("requires a ready canonical Crystal");
			expect(await fs.readFile(callerPath, "utf-8")).toBe(before);
		});
	});
	it("rejects execution approval for tampered canonical Crystal state", async () => {
		await withTempCwd(async cwd => {
			const { callerPath } = await writePublishedReadyCrystal(cwd);
			const tampered = (await readJson(callerPath)) as Record<string, unknown>;
			(tampered.state as Record<string, unknown>).rounds = [{ round: 99 }];
			await writeJson(callerPath, tampered);
			const before = await fs.readFile(callerPath, "utf-8");
			const result = await runNativeDeepInterviewCommand(["approve-execution", "--json"], cwd);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain("approval refuses tampered mode-state");
			expect(await fs.readFile(callerPath, "utf-8")).toBe(before);
		});
	});
	it("rejects execution approval through generic and reconcile state writers", async () => {
		await withTempCwd(async cwd => {
			const statePath = modeStatePath(cwd, TEST_SESSION_ID, "deep-interview");
			await writeJson(statePath, {
				skill: "deep-interview",
				version: 2,
				active: true,
				current_phase: "interviewing",
				state: { rounds: [] },
			});
			const generic = await runNativeStateCommand(
				[
					"write",
					"--mode",
					"deep-interview",
					"--input",
					JSON.stringify({
						state: {
							execution_approval: "approved",
							execution_approval_receipt: { method: "explicit-state-action" },
						},
					}),
					"--json",
				],
				cwd,
			);
			expect(generic.status).toBe(2);
			expect(generic.stderr).toContain("immutable through generic state write");
			await expect(
				reconcileWorkflowSkillState({
					cwd,
					mode: "deep-interview",
					sessionId: TEST_SESSION_ID,
					active: true,
					phase: "interviewing",
					payload: {
						state: {
							rounds: [],
							execution_approval: "approved",
							execution_approval_receipt: { method: "explicit-state-action" },
						},
					},
				}),
			).rejects.toThrow("immutable through runtime reconciliation");
			const after = await readJson(statePath);
			expect((after?.state as Record<string, unknown>).execution_approval).toBeUndefined();
			await expect(
				reconcileWorkflowSkillState({
					cwd,
					mode: "deep-interview",
					sessionId: TEST_SESSION_ID,
					active: true,
					phase: "handoff",
					payload: { state: { rounds: [], crystal: readyCrystal() } },
				}),
			).rejects.toThrow("canonical Crystal is immutable through runtime reconciliation");
		});
	});
	it("revokes pre-v2 Crystal authority through generic and reconcile writers", async () => {
		await withTempCwd(async cwd => {
			const callerPath = await writeLegacyApprovedCrystal(cwd);
			const generic = await runNativeStateCommand(
				[
					"write",
					"--mode",
					"deep-interview",
					"--input",
					JSON.stringify({ state: { note: "generic legacy repair" } }),
					"--json",
				],
				cwd,
			);
			expect(generic.status).toBe(0);
			const repaired = await readJson(callerPath);
			expect(repaired?.current_phase).toBe("interviewing");
			expect(repaired?.spec_path).toBeUndefined();
			const repairedInner = repaired?.state as Record<string, unknown>;
			expect(repairedInner.crystal).toBeUndefined();
			expect(repairedInner.execution_approval).toBe("not-approved");
			expect(repairedInner.execution_approval_receipt).toBeUndefined();
			const handoff = await runNativeStateCommand(
				["handoff", "--mode", "deep-interview", "--to", "ultragoal", "--json"],
				cwd,
			);
			expect(handoff.status).toBe(2);
		});

		await withTempCwd(async cwd => {
			const callerPath = await writeLegacyApprovedCrystal(cwd);
			await reconcileWorkflowSkillState({
				cwd,
				mode: "deep-interview",
				sessionId: TEST_SESSION_ID,
				active: true,
				phase: "handoff",
				payload: { state: { note: "reconcile legacy repair" } },
			});
			const repaired = await readJson(callerPath);
			expect(repaired?.current_phase).toBe("handoff");
			expect(repaired?.spec_path).toBeUndefined();
			const repairedInner = repaired?.state as Record<string, unknown>;
			expect(repairedInner.crystal).toBeUndefined();
			expect(repairedInner.execution_approval).toBe("not-approved");
			expect(repairedInner.execution_approval_receipt).toBeUndefined();
			const handoff = await runNativeStateCommand(
				["handoff", "--mode", "deep-interview", "--to", "ultragoal", "--json"],
				cwd,
			);
			expect(handoff.status).toBe(2);
		});
	});
	it("does not let a handoff request grant ready-Crystal execution approval", async () => {
		await withTempCwd(async cwd => {
			const specPath = path.join(cwd, "crystal.md");
			await fs.writeFile(specPath, "# Crystal\n");
			const callerPath = modeStatePath(cwd, TEST_SESSION_ID, "deep-interview");
			await writeJson(callerPath, {
				skill: "deep-interview",
				version: 2,
				active: true,
				current_phase: "handoff",
				spec_path: specPath,
				spec_sha256: createHash("sha256").update("# Crystal\n").digest("hex"),
				state: { crystal: readyCrystal(), execution_approval: "not-approved" },
			});
			const before = await fs.readFile(callerPath, "utf-8");
			const result = await runNativeStateCommand(
				["handoff", "--mode", "deep-interview", "--to", "ultragoal", "--approve-execution", "--json"],
				cwd,
			);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain("unknown gjc state flag: --approve-execution");
			expect(await fs.readFile(callerPath, "utf-8")).toBe(before);
			await expect(fs.access(modeStatePath(cwd, TEST_SESSION_ID, "ultragoal"))).rejects.toThrow();
		});
	});
	it("rejects ready-Crystal execution handoff without explicit approval", async () => {
		await withTempCwd(async cwd => {
			await writePublishedReadyCrystal(cwd);
			const result = await runNativeStateCommand(
				["handoff", "--mode", "deep-interview", "--to", "ultragoal", "--json"],
				cwd,
			);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain("crystallization never grants execution approval");
		});
	});
	it("enforces a locked Round-0 contract for crystallized planning handoff", async () => {
		await withTempCwd(async cwd => {
			const { callerPath } = await writePublishedReadyCrystal(cwd);
			const state = (await readJson(callerPath)) as Record<string, unknown>;
			(state.state as Record<string, unknown>).intent_contract_required = true;
			await writeJson(callerPath, stampWorkflowEnvelopeChecksum(state, callerPath));
			const result = await runNativeStateCommand(
				["handoff", "--mode", "deep-interview", "--to", "ralplan", "--json"],
				cwd,
			);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain("requires a locked Round 0 intent contract");
		});
	});
	it("rejects pre-hardening approval receipts even on checksummed v2 state", async () => {
		await withTempCwd(async cwd => {
			const { callerPath } = await writePublishedReadyCrystal(cwd);
			const forged = (await readJson(callerPath)) as Record<string, unknown>;
			const inner = forged.state as Record<string, unknown>;
			const crystal = inner.crystal as DeepInterviewCrystal;
			inner.execution_approval = "approved";
			inner.execution_approval_receipt = {
				method: "explicit-state-action",
				approved_at: "2026-09-03T00:00:00.000Z",
				mutation_id: "pre-hardening",
				spec_sha256: forged.spec_sha256,
				crystal_spec_version: crystal.spec_version,
				crystal_source_digest: crystal.source.digest,
			};
			await writeJson(callerPath, stampWorkflowEnvelopeChecksum(forged, callerPath));
			const before = await fs.readFile(callerPath, "utf-8");
			const approval = await runNativeDeepInterviewCommand(["approve-execution", "--json"], cwd);
			expect(approval.status).toBe(2);
			expect(approval.stderr).toContain("lacks explicit provenance");
			const handoff = await runNativeStateCommand(
				["handoff", "--mode", "deep-interview", "--to", "ultragoal", "--json"],
				cwd,
			);
			expect(handoff.status).toBe(2);
			expect(handoff.stderr).toContain("lacks explicit provenance");
			expect(await fs.readFile(callerPath, "utf-8")).toBe(before);
		});
	});
	it("rejects approval grants from pre-v2 canonical-looking state", async () => {
		await withTempCwd(async cwd => {
			const callerPath = await writeLegacyApprovedCrystal(cwd);
			const legacy = (await readJson(callerPath)) as Record<string, unknown>;
			const inner = legacy.state as Record<string, unknown>;
			inner.execution_approval = "not-approved";
			delete inner.execution_approval_receipt;
			await writeJson(callerPath, stampWorkflowEnvelopeChecksum(legacy, callerPath));
			const before = await fs.readFile(callerPath, "utf-8");
			const approval = await runNativeDeepInterviewCommand(["approve-execution", "--json"], cwd);
			expect(approval.status).toBe(2);
			expect(approval.stderr).toContain("requires current deep-interview state version");
			expect(await fs.readFile(callerPath, "utf-8")).toBe(before);
		});
	});
	it("rejects execution handoff after approved Crystal state is tampered", async () => {
		await withTempCwd(async cwd => {
			const { callerPath } = await writePublishedReadyCrystal(cwd);
			const approval = await runNativeDeepInterviewCommand(["approve-execution", "--json"], cwd);
			expect(approval.status).toBe(0);
			const tampered = (await readJson(callerPath)) as Record<string, unknown>;
			(tampered.state as Record<string, unknown>).rounds = [{ round: 99 }];
			await writeJson(callerPath, tampered);
			const before = await fs.readFile(callerPath, "utf-8");
			const handoff = await runNativeStateCommand(
				["handoff", "--mode", "deep-interview", "--to", "ultragoal", "--json"],
				cwd,
			);
			expect(handoff.status).toBe(2);
			expect(handoff.stderr).toContain("execution handoff refuses tampered mode-state");
			expect(await fs.readFile(callerPath, "utf-8")).toBe(before);
			await expect(fs.access(modeStatePath(cwd, TEST_SESSION_ID, "ultragoal"))).rejects.toThrow();
		});
	});
	it("rejects attempts to rewrite approved Crystal lifecycle before execution handoff", async () => {
		await withTempCwd(async cwd => {
			const { callerPath } = await writePublishedReadyCrystal(cwd);
			const approval = await runNativeDeepInterviewCommand(["approve-execution", "--json"], cwd);
			expect(approval.status).toBe(0);
			const before = await fs.readFile(callerPath, "utf-8");
			await expect(
				reconcileWorkflowSkillState({
					cwd,
					mode: "deep-interview",
					sessionId: TEST_SESSION_ID,
					active: true,
					phase: "interviewing",
					payload: {},
				}),
			).rejects.toThrow("approved Crystal lifecycle is immutable through runtime reconciliation");
			const generic = await runNativeStateCommand(
				[
					"write",
					"--mode",
					"deep-interview",
					"--input",
					JSON.stringify({ current_phase: "interviewing" }),
					"--json",
				],
				cwd,
			);
			expect(generic.status).toBe(2);
			expect(generic.stderr).toContain("approved Crystal lifecycle is immutable through generic state write");
			const nested = await runNativeStateCommand(
				[
					"write",
					"--mode",
					"deep-interview",
					"--input",
					JSON.stringify({ state: { current_phase: "interviewing" } }),
					"--force",
					"--json",
				],
				cwd,
			);
			expect(nested.status).toBe(2);
			expect(nested.stderr).toContain("approved Crystal lifecycle is immutable through generic state write");
			expect(await fs.readFile(callerPath, "utf-8")).toBe(before);
			await expect(fs.access(modeStatePath(cwd, TEST_SESSION_ID, "ultragoal"))).rejects.toThrow();
		});
	});
	it("rejects legacy final-spec execution handoff without a ready approved Crystal", async () => {
		await withTempCwd(async cwd => {
			const specPath = path.join(cwd, "legacy.md");
			await fs.writeFile(specPath, "# Legacy\n");
			const callerPath = modeStatePath(cwd, TEST_SESSION_ID, "deep-interview");
			await writeJson(callerPath, {
				skill: "deep-interview",
				version: 2,
				active: true,
				current_phase: "handoff",
				spec_path: specPath,
				spec_sha256: createHash("sha256").update("# Legacy\n").digest("hex"),
				state: { rounds: [], established_facts: [] },
			});
			const result = await runNativeStateCommand(
				["handoff", "--mode", "deep-interview", "--to", "ultragoal", "--json"],
				cwd,
			);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain("execution handoff requires checksummed canonical state");
			expect((await readJson(callerPath))?.active).toBe(true);
			await expect(fs.access(modeStatePath(cwd, TEST_SESSION_ID, "ultragoal"))).rejects.toThrow();
		});
	});

	it("bounds referenced legacy specs before a deep-interview handoff mutates workflow state", async () => {
		const writeLegacyCaller = async (cwd: string, spec: string) => {
			const specPath = path.join(cwd, "legacy-spec.md");
			const callerPath = modeStatePath(cwd, TEST_SESSION_ID, "deep-interview");
			await fs.writeFile(specPath, spec, "utf-8");
			await writeJson(callerPath, {
				skill: "deep-interview",
				version: WORKFLOW_STATE_VERSION,
				active: true,
				current_phase: "handoff",
				spec_path: specPath,
				state: { rounds: [] },
			});
			return callerPath;
		};

		await withTempCwd(async cwd => {
			await writeLegacyCaller(cwd, "😀".repeat(100_000));
			const exact = await runNativeStateCommand(
				["handoff", "--mode", "deep-interview", "--to", "ralplan", "--json"],
				cwd,
			);
			expect(exact.status).toBe(0);
		});

		await withTempCwd(async cwd => {
			const callerPath = await writeLegacyCaller(cwd, "😀".repeat(100_001));
			const before = await fs.readFile(callerPath, "utf-8");
			const rejected = await runNativeStateCommand(
				["handoff", "--mode", "deep-interview", "--to", "ralplan", "--json"],
				cwd,
			);
			expect(rejected.status).toBe(1);
			expect(rejected.stderr).toContain("persisted deep-interview spec exceeds max length 100000");
			expect(await fs.readFile(callerPath, "utf-8")).toBe(before);
			await expect(fs.access(modeStatePath(cwd, TEST_SESSION_ID, "ralplan"))).rejects.toThrow();
			await expect(fs.access(activeSnapshotPath(cwd, TEST_SESSION_ID))).rejects.toThrow();
			await expect(fs.access(path.join(sessionStateDir(cwd, TEST_SESSION_ID), "transactions"))).rejects.toThrow();
		});
	});

	it("serializes a handoff with a concurrent state write to the callee mode-state", async () => {
		await withTempCwd(async cwd => {
			const callerPath = modeStatePath(cwd, TEST_SESSION_ID, "deep-interview");
			const calleePath = modeStatePath(cwd, TEST_SESSION_ID, "ralplan");
			await writeJson(callerPath, {
				skill: "deep-interview",
				version: WORKFLOW_STATE_VERSION,
				active: true,
				current_phase: "interviewing",
				updated_at: "2026-01-01T00:00:00.000Z",
			});
			await writeJson(calleePath, {
				skill: "ralplan",
				version: WORKFLOW_STATE_VERSION,
				active: false,
				current_phase: "planner",
				updated_at: "2026-01-01T00:00:00.000Z",
			});

			const [handoff, write] = await Promise.all([
				runNativeStateCommand(["handoff", "--mode", "deep-interview", "--to", "ralplan", "--json"], cwd),
				runNativeStateCommand(
					["write", "--mode", "ralplan", "--input", '{"current_phase":"planner","concurrent":true}', "--json"],
					cwd,
				),
			]);

			expect(handoff.status).toBe(0);
			expect(write.status).toBe(0);
			const callee = await readJson(calleePath);
			expect(callee?.state_revision).toBe(2);
			expect(callee?.skill).toBe("ralplan");
			expect(callee?.version).toBe(WORKFLOW_STATE_VERSION);
		});
	});

	it("normalizes legacy caller and callee envelopes to v2 during handoff", async () => {
		await withTempCwd(async cwd => {
			const callerPath = modeStatePath(cwd, TEST_SESSION_ID, "deep-interview");
			const calleePath = modeStatePath(cwd, TEST_SESSION_ID, "ralplan");
			await writeJson(callerPath, {
				skill: "deep-interview",
				version: 1,
				active: true,
				current_phase: "interviewing",
			});
			await writeJson(calleePath, {
				skill: "ralplan",
				active: false,
				current_phase: "planner",
			});

			const result = await runNativeStateCommand(
				["handoff", "--mode", "deep-interview", "--to", "ralplan", "--json"],
				cwd,
			);

			expect(result.status).toBe(0);
			const caller = await readJson(callerPath);
			const callee = await readJson(calleePath);
			expect(caller?.version).toBe(2);
			expect(callee?.version).toBe(2);
		});
	});

	it("bootstraps an absent callee mode-state during handoff", async () => {
		await withTempCwd(async cwd => {
			const callerPath = modeStatePath(cwd, TEST_SESSION_ID, "deep-interview");
			const calleePath = modeStatePath(cwd, TEST_SESSION_ID, "ralplan");
			await writeJson(callerPath, {
				skill: "deep-interview",
				version: 1,
				active: true,
				current_phase: "interviewing",
			});

			const result = await runNativeStateCommand(
				["handoff", "--mode", "deep-interview", "--to", "ralplan", "--json"],
				cwd,
			);

			expect(result.status).toBe(0);
			const callee = await readJson(calleePath);
			expect(callee?.active).toBe(true);
			expect(callee?.current_phase).toBe("planner");
			expect(callee?.handoff_from).toBe("deep-interview");
		});
	});

	it("fails closed on missing or stale locked intent at shared handoff", async () => {
		await withTempCwd(async cwd => {
			const callerPath = modeStatePath(cwd, TEST_SESSION_ID, "deep-interview");
			await writeJson(callerPath, {
				skill: "deep-interview",
				version: WORKFLOW_STATE_VERSION,
				active: true,
				current_phase: "handoff",
				state: { intent_contract_required: true, rounds: [] },
			});
			const missing = await runNativeStateCommand(
				["handoff", "--mode", "deep-interview", "--to", "ralplan", "--json"],
				cwd,
			);
			expect(missing.status).toBe(2);
			expect(missing.stderr).toContain("requires a locked Round 0 intent contract");
			const runtimeMissing = await runNativeStateCommand(
				["handoff", "--mode", "deep-interview", "--to", "made-up-skill", "--json"],
				cwd,
			);
			expect(runtimeMissing.status).toBe(2);
			expect(runtimeMissing.stderr).toContain("requires a locked Round 0 intent contract");
			const unchanged = await readJson(callerPath);
			expect(unchanged?.active).toBe(true);
		});

		await withTempCwd(async cwd => {
			const callerPath = modeStatePath(cwd, TEST_SESSION_ID, "deep-interview");
			const answerHash = "a".repeat(64);
			const items = [{ id: "artifact:report", category: "artifact" as const, statement: "Produce report" }];
			const contract = createDeepInterviewIntentManifest(items, { round: 0, answer_hash: answerHash });
			const review = reviewDeepInterviewIntent(contract, items, {
				status: "not_required",
				supporting_substitutions: [],
			});
			const specPath = path.join(cwd, "intent-spec.md");
			const content = "# Intent\nartifact:report\n";
			await fs.writeFile(specPath, content, "utf-8");
			await writeJson(callerPath, {
				skill: "deep-interview",
				version: WORKFLOW_STATE_VERSION,
				active: true,
				current_phase: "handoff",
				spec_path: specPath,
				spec_sha256: createHash("sha256").update(content).digest("hex"),
				state: {
					intent_contract_required: true,
					intent_contract: contract,
					intent_review: review,
					rounds: [{ round: 0, answer_hash: answerHash }],
				},
			});
			await fs.writeFile(specPath, `${content}tampered\n`, "utf-8");
			const stale = await runNativeStateCommand(
				["handoff", "--mode", "deep-interview", "--to", "ralplan", "--json"],
				cwd,
			);
			expect(stale.status).toBe(2);
			expect(stale.stderr).toContain("spec hash mismatch");
		});
	});

	it("rejects corrupt callee mode-state without --force and overwrites with --force", async () => {
		await withTempCwd(async cwd => {
			const callerPath = modeStatePath(cwd, TEST_SESSION_ID, "deep-interview");
			const calleePath = modeStatePath(cwd, TEST_SESSION_ID, "ralplan");
			await writeJson(callerPath, {
				skill: "deep-interview",
				version: 1,
				active: true,
				current_phase: "interviewing",
			});
			await fs.mkdir(path.dirname(calleePath), { recursive: true });
			await fs.writeFile(calleePath, "{broken json", "utf-8");

			const rejected = await runNativeStateCommand(
				["handoff", "--mode", "deep-interview", "--to", "ralplan", "--json"],
				cwd,
			);
			expect(rejected.status).toBe(2);
			expect(rejected.stderr).toContain("existing state for ralplan is corrupt or tampered");
			expect(await fs.readFile(calleePath, "utf-8")).toBe("{broken json");

			const forced = await runNativeStateCommand(
				["handoff", "--mode", "deep-interview", "--to", "ralplan", "--json", "--force"],
				cwd,
			);
			expect(forced.status).toBe(0);
			const callee = await readJson(calleePath);
			expect(callee?.active).toBe(true);
			expect(callee?.handoff_from).toBe("deep-interview");
		});
	});

	it("rejects corrupt caller mode-state without --force and proceeds with --force", async () => {
		await withTempCwd(async cwd => {
			const callerPath = modeStatePath(cwd, TEST_SESSION_ID, "deep-interview");
			await fs.mkdir(path.dirname(callerPath), { recursive: true });
			await fs.writeFile(callerPath, "{broken json", "utf-8");

			const rejected = await runNativeStateCommand(
				["handoff", "--mode", "deep-interview", "--to", "ralplan", "--json"],
				cwd,
			);
			expect(rejected.status).toBe(2);
			expect(rejected.stderr).toContain("existing state for deep-interview is corrupt or tampered");
			expect(await fs.readFile(callerPath, "utf-8")).toBe("{broken json");

			const forced = await runNativeStateCommand(
				["handoff", "--mode", "deep-interview", "--to", "ralplan", "--json", "--force"],
				cwd,
			);
			expect(forced.status).toBe(0);
			const caller = await readJson(callerPath);
			expect(caller?.active).toBe(false);
			const callee = await readJson(modeStatePath(cwd, TEST_SESSION_ID, "ralplan"));
			expect(callee?.handoff_from).toBe("deep-interview");
		});
	});

	it("writes callee mode-state before caller mode-state using the caller-write failpoint", async () => {
		await withTempCwd(async cwd => {
			const callerPath = modeStatePath(cwd, TEST_SESSION_ID, "deep-interview");
			const calleePath = modeStatePath(cwd, TEST_SESSION_ID, "ralplan");
			const handoffAt = "2026-06-03T00:00:00.000Z";
			const mutationId = `deep-interview:handoff:ralplan:${handoffAt}`;
			await writeJson(callerPath, {
				skill: "deep-interview",
				version: 1,
				active: true,
				current_phase: "interviewing",
			});

			const priorFailpoint = process.env.GJC_STATE_HANDOFF_FAIL_AFTER_CALLER;
			const originalToISOString = Date.prototype.toISOString;
			Date.prototype.toISOString = () => handoffAt;
			process.env.GJC_STATE_HANDOFF_FAIL_AFTER_CALLER = mutationId;
			try {
				const result = await runNativeStateCommand(
					["handoff", "--mode", "deep-interview", "--to", "ralplan", "--json"],
					cwd,
				);
				expect(result.status).toBe(1);
				expect(result.stderr).toContain(`injected handoff failure after caller write for ${mutationId}`);
			} finally {
				Date.prototype.toISOString = originalToISOString;
				restoreEnvironmentValue("GJC_STATE_HANDOFF_FAIL_AFTER_CALLER", priorFailpoint);
			}

			// The failpoint executes only after the caller write. Its observable state
			// proves the callee was persisted first without relying on filesystem mtimes.
			const callee = await readJson(calleePath);
			const caller = await readJson(callerPath);
			expect(callee?.active).toBe(true);
			expect(callee?.handoff_from).toBe("deep-interview");
			expect(caller?.active).toBe(false);
			expect(caller?.handoff_to).toBe("ralplan");
			expect(await readJson(activeSnapshotPath(cwd, TEST_SESSION_ID))).toBeNull();
		});
	});

	it("serializes the callee read-modify-write with sanctioned callee writers", async () => {
		await withTempCwd(async cwd => {
			const callerPath = modeStatePath(cwd, TEST_SESSION_ID, "deep-interview");
			const calleePath = modeStatePath(cwd, TEST_SESSION_ID, "ralplan");
			await writeJson(callerPath, {
				skill: "deep-interview",
				version: 1,
				active: true,
				current_phase: "interviewing",
			});
			let settled = false;
			let handoff: Promise<StateCommandResult> | undefined;
			await withWorkflowStateLock(
				calleePath,
				async () => {
					handoff = runNativeStateCommand(
						["handoff", "--mode", "deep-interview", "--to", "ralplan", "--json"],
						cwd,
					).then(result => {
						settled = true;
						return result;
					});
					await Bun.sleep(25);
					expect(settled).toBe(false);
					await writeJson(calleePath, {
						skill: "ralplan",
						version: 1,
						active: false,
						current_phase: "final",
						note: "concurrent sanctioned update",
					});
				},
				{ cwd },
			);
			const result = await handoff!;
			expect(result.status).toBe(0);
			expect((await readJson(calleePath))?.note).toBe("concurrent sanctioned update");
		});
	});

	it("recovers an approved ultragoal handoff after caller persistence", async () => {
		await withTempCwd(async cwd => {
			const { callerPath } = await writePublishedReadyCrystal(cwd);
			const approval = await runNativeDeepInterviewCommand(["approve-execution", "--json"], cwd);
			expect(approval.status).toBe(0);
			const handoffAt = "2026-09-04T00:00:00.000Z";
			const mutationId = `deep-interview:handoff:ultragoal:${handoffAt}`;
			const priorFailpoint = process.env.GJC_STATE_HANDOFF_FAIL_AFTER_CALLER;
			const originalToISOString = Date.prototype.toISOString;
			Date.prototype.toISOString = () => handoffAt;
			process.env.GJC_STATE_HANDOFF_FAIL_AFTER_CALLER = mutationId;
			try {
				const failed = await runNativeStateCommand(
					["handoff", "--mode", "deep-interview", "--to", "ultragoal", "--json"],
					cwd,
				);
				expect(failed.status).toBe(1);
			} finally {
				Date.prototype.toISOString = originalToISOString;
				restoreEnvironmentValue("GJC_STATE_HANDOFF_FAIL_AFTER_CALLER", priorFailpoint);
			}
			expect((await readJson(callerPath))?.active).toBe(false);
			const recovered = await runNativeStateCommand(
				["handoff", "--mode", "deep-interview", "--to", "ultragoal", "--json"],
				cwd,
			);
			expect(recovered.status).toBe(0);
			const active = await readJson(activeSnapshotPath(cwd, TEST_SESSION_ID));
			const skills = (active?.active_skills as Array<Record<string, unknown>>) ?? [];
			expect(skills.find(entry => entry.skill === "ultragoal")?.active).toBe(true);
		});
	});

	it("rejects missing --to", async () => {
		await withTempCwd(async cwd => {
			await writeJson(modeStatePath(cwd, TEST_SESSION_ID, "deep-interview"), {
				skill: "deep-interview",
				version: 1,
				active: true,
				current_phase: "interviewing",
			});
			const result = await runNativeStateCommand(["handoff", "--mode", "deep-interview", "--json"], cwd);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain("--to");
		});
	});

	it("demotes canonical caller without creating runtime mode-state when callee is a runtime skill", async () => {
		await withTempCwd(async cwd => {
			await writeJson(modeStatePath(cwd, TEST_SESSION_ID, "deep-interview"), {
				skill: "deep-interview",
				version: 1,
				active: true,
				current_phase: "interviewing",
			});
			const result = await runNativeStateCommand(
				["handoff", "--mode", "deep-interview", "--to", "made-up-skill", "--json"],
				cwd,
			);
			expect(result.status).toBe(0);
			const payload = parseRequiredJson(result.stdout, "runtime-callee handoff stdout");
			expect(payload.from).toBe("deep-interview");
			expect(payload.to).toBe("made-up-skill");

			const caller = await readJson(modeStatePath(cwd, TEST_SESSION_ID, "deep-interview"));
			expect(caller?.active).toBe(false);
			expect(caller?.current_phase).toBe("handoff");
			expect(caller?.handoff_to).toBe("made-up-skill");
			await expect(fs.access(modeStatePath(cwd, TEST_SESSION_ID, "made-up-skill"))).rejects.toThrow();

			const activeState = await readJson(activeSnapshotPath(cwd, TEST_SESSION_ID));
			const activeSkills = (activeState?.active_skills as Array<Record<string, unknown>>) ?? [];
			expect(activeSkills.find(e => e.skill === "made-up-skill")).toBeUndefined();
			const callerEntry = activeSkills.find(e => e.skill === "deep-interview");
			expect(callerEntry?.active).not.toBe(true);
			if (callerEntry) expect(callerEntry.handoff_to).toBe("made-up-skill");
		});
	});

	it("rejects unsafe runtime callee path components", async () => {
		await withTempCwd(async cwd => {
			await writeJson(modeStatePath(cwd, TEST_SESSION_ID, "deep-interview"), {
				skill: "deep-interview",
				version: 1,
				active: true,
				current_phase: "interviewing",
			});
			const result = await runNativeStateCommand(
				["handoff", "--mode", "deep-interview", "--to", "../made-up-skill", "--json"],
				cwd,
			);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain("invalid path component for --to");
		});
	});

	it("rejects --to equal to caller", async () => {
		await withTempCwd(async cwd => {
			await writeJson(modeStatePath(cwd, TEST_SESSION_ID, "ralplan"), {
				skill: "ralplan",
				version: 1,
				active: true,
				current_phase: "planning",
			});
			const result = await runNativeStateCommand(["handoff", "--mode", "ralplan", "--to", "ralplan", "--json"], cwd);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain("must differ from caller");
		});
	});

	it("rejects handoff when caller mode-state file does not exist", async () => {
		await withTempCwd(async cwd => {
			const result = await runNativeStateCommand(
				["handoff", "--mode", "deep-interview", "--to", "ralplan", "--json"],
				cwd,
			);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain("caller is not active");
		});
	});

	it("completes promptly when the handoff cwd equals process.cwd() (no self-locked active-state)", async () => {
		await withTempCwd(async cwd => {
			// Regression: handleHandoff must not hold the `skill-active-state.json`
			// lock across the inner rebuild, which re-locks the same file. That
			// self-contention only manifests when the handoff cwd is also the
			// process cwd (the real CLI case) — otherwise the outer lock resolves
			// against process.cwd() and lands on a different, unused path.
			const priorCwd = process.cwd();
			await writeJson(modeStatePath(cwd, TEST_SESSION_ID, "deep-interview"), {
				skill: "deep-interview",
				version: 1,
				active: true,
				current_phase: "interviewing",
			});
			process.chdir(cwd);
			try {
				const started = Date.now();
				const result = await runNativeStateCommand(
					["handoff", "--mode", "deep-interview", "--to", "ralplan", "--json"],
					cwd,
				);
				const elapsed = Date.now() - started;
				expect(result.status).toBe(0);
				// A self-locked rebuild would exhaust 50 retries (~5s) before failing.
				expect(elapsed).toBeLessThan(3000);
				const callee = await readJson(modeStatePath(cwd, TEST_SESSION_ID, "ralplan"));
				expect(callee?.active).toBe(true);
				expect(callee?.handoff_from).toBe("deep-interview");
			} finally {
				process.chdir(priorCwd);
			}
		});
	});

	it("supports backward chain ultragoal -> ralplan", async () => {
		await withTempCwd(async cwd => {
			await writeJson(modeStatePath(cwd, TEST_SESSION_ID, "ultragoal"), {
				skill: "ultragoal",
				version: 1,
				active: true,
				current_phase: "goal-planning",
			});
			const result = await runNativeStateCommand(
				["handoff", "--mode", "ultragoal", "--to", "ralplan", "--json"],
				cwd,
			);
			expect(result.status).toBe(0);
			const ultragoal = await readJson(modeStatePath(cwd, TEST_SESSION_ID, "ultragoal"));
			expect(ultragoal?.active).toBe(false);
			expect(ultragoal?.current_phase).toBe("handoff");
			expect(ultragoal?.handoff_to).toBe("ralplan");
			const ralplan = await readJson(modeStatePath(cwd, TEST_SESSION_ID, "ralplan"));
			expect(ralplan?.active).toBe(true);
			expect(ralplan?.handoff_from).toBe("ultragoal");
		});
	});
	it("handoffs session-scoped state when --session-id is forwarded", async () => {
		await withTempCwd(async cwd => {
			const sessionId = "session-G007";
			await writeJson(modeStatePath(cwd, sessionId, "deep-interview"), {
				skill: "deep-interview",
				version: 1,
				active: true,
				current_phase: "interviewing",
				session_id: sessionId,
			});

			const result = await runNativeStateCommand(
				["handoff", "--mode", "deep-interview", "--to", "ralplan", "--session-id", sessionId, "--json"],
				cwd,
			);
			expect(result.status).toBe(0);

			// Session-scoped caller mode-state demoted; root mode-state untouched.
			const caller = parseRequiredJson(
				await fs.readFile(modeStatePath(cwd, sessionId, "deep-interview"), "utf-8"),
				"session caller mode state",
			);
			expect(caller.active).toBe(false);
			expect(caller.current_phase).toBe("handoff");

			const callee = parseRequiredJson(
				await fs.readFile(modeStatePath(cwd, sessionId, "ralplan"), "utf-8"),
				"session callee mode state",
			);
			expect(callee.active).toBe(true);
			expect(callee.handoff_from).toBe("deep-interview");

			// Root state files were NOT mutated for this session-scoped handoff.
			await expect(fs.access(modeStatePath(cwd, TEST_SESSION_ID, "deep-interview"))).rejects.toThrow();

			// Session-scoped active-state has callee active and carries lineage.
			const sessionActive = parseRequiredJson(
				await fs.readFile(activeSnapshotPath(cwd, sessionId), "utf-8"),
				"session active state",
			) as { active_skills?: Array<Record<string, unknown>> };
			const ralplanEntry = sessionActive.active_skills?.find(e => e.skill === "ralplan");
			expect(ralplanEntry?.handoff_from).toBe("deep-interview");
			expect(typeof ralplanEntry?.handoff_at).toBe("string");
		});
	});
	it("propagates strict sync failure when active-state write fails after mode-state writes succeed", async () => {
		await withTempCwd(async cwd => {
			const callerPath = modeStatePath(cwd, TEST_SESSION_ID, "deep-interview");
			await writeJson(callerPath, {
				skill: "deep-interview",
				version: 1,
				active: true,
				current_phase: "interviewing",
			});
			// Pre-create the root active-state path AS A DIRECTORY so writing it
			// fails *after* both mode-state writes have already succeeded. This
			// exercises the strict active-state path, not the pre-sync mode-state
			// path, and proves the CLI returns non-zero status when the atomic
			// transaction cannot complete.
			await fs.mkdir(activeSnapshotPath(cwd, TEST_SESSION_ID), { recursive: true });

			const result = await runNativeStateCommand(
				["handoff", "--mode", "deep-interview", "--to", "ralplan", "--json"],
				cwd,
			);
			expect(result.status).toBe(1);
			expect(result.stderr).toMatch(/director(?:y|ies)|EISDIR/i);
			// Mode-state writes precede strict active-state synchronization. Removing
			// the transient obstruction and retrying the same documented handoff command
			// must rebuild the active lineage without overwriting either mode-state.
			const caller = parseRequiredJson(await fs.readFile(callerPath, "utf-8"), "caller mode state");
			expect(caller.current_phase).toBe("handoff");
			expect(caller.active).toBe(false);
			const callee = parseRequiredJson(
				await fs.readFile(modeStatePath(cwd, TEST_SESSION_ID, "ralplan"), "utf-8"),
				"callee mode state",
			);
			expect(callee.active).toBe(true);
			expect(callee.handoff_from).toBe("deep-interview");

			await fs.rm(activeSnapshotPath(cwd, TEST_SESSION_ID), { recursive: true, force: true });
			const retried = await runNativeStateCommand(
				["handoff", "--mode", "deep-interview", "--to", "ralplan", "--json"],
				cwd,
			);
			expect(retried.status).toBe(0);
			const recoveredActive = await readJson(activeSnapshotPath(cwd, TEST_SESSION_ID));
			const recoveredSkills = (recoveredActive?.active_skills as Array<Record<string, unknown>>) ?? [];
			expect(recoveredSkills.find(entry => entry.skill === "deep-interview")?.handoff_to).toBe("ralplan");
			expect(recoveredSkills.find(entry => entry.skill === "ralplan")?.handoff_from).toBe("deep-interview");
		});
	});

	it("treats corrupt active-state JSON as a strict failure", async () => {
		await withTempCwd(async cwd => {
			await writeJson(modeStatePath(cwd, TEST_SESSION_ID, "deep-interview"), {
				skill: "deep-interview",
				version: 1,
				active: true,
				current_phase: "interviewing",
			});
			await fs.mkdir(sessionStateDir(cwd, TEST_SESSION_ID), { recursive: true });
			await fs.writeFile(activeSnapshotPath(cwd, TEST_SESSION_ID), "{ not valid json");

			const result = await runNativeStateCommand(
				["handoff", "--mode", "deep-interview", "--to", "ralplan", "--json"],
				cwd,
			);
			expect(result.status).toBe(1);
			expect(result.stderr).toMatch(/json|parse|unexpected/i);
			expect(await fs.readFile(activeSnapshotPath(cwd, TEST_SESSION_ID), "utf-8")).toBe("{ not valid json");
		});
	});

	it("preserves D->R->U lineage while stripping owner_generation from successor and active-state records", async () => {
		await withTempCwd(async cwd => {
			const stateDir = sessionStateDir(cwd, TEST_SESSION_ID);
			await writeJson(path.join(stateDir, "deep-interview-state.json"), {
				skill: "deep-interview",
				version: 1,
				active: true,
				current_phase: "interviewing",
				owner_generation: "deep-interview-generation",
			});

			// Step 1: D -> R.
			const step1 = await runNativeStateCommand(
				["handoff", "--mode", "deep-interview", "--to", "ralplan", "--json"],
				cwd,
			);
			expect(step1.status).toBe(0);

			// Bridge state for step 2: ralplan must look ready-to-hand-off.
			await fs.writeFile(
				path.join(stateDir, "ralplan-state.json"),
				JSON.stringify(
					{
						...(parseRequiredJson(
							await fs.readFile(path.join(stateDir, "ralplan-state.json"), "utf-8"),
							"ralplan bridge mode state",
						) as Record<string, unknown>),
						current_phase: "handoff",
					},
					null,
					2,
				),
			);

			// Step 2: R -> U.
			const step2 = await runNativeStateCommand(
				["handoff", "--mode", "ralplan", "--to", "ultragoal", "--json", "--force"],
				cwd,
			);
			expect(step2.status).toBe(0);

			// Assert all three lineage records are present in active_skills.
			const activeState = (await readJson(path.join(stateDir, "skill-active-state.json"))) as {
				active_skills?: Array<Record<string, unknown>>;
			};
			const skills = activeState?.active_skills ?? [];
			const di = skills.find(e => e.skill === "deep-interview");
			const rp = skills.find(e => e.skill === "ralplan");
			const ug = skills.find(e => e.skill === "ultragoal");
			expect(di?.active).toBe(false);
			expect(di?.handoff_to).toBe("ralplan");
			expect(rp?.active).toBe(false);
			expect(rp?.handoff_to).toBe("ultragoal");
			expect(rp?.handoff_from).toBe("deep-interview");
			expect(ug?.active).toBe(true);
			expect(ug?.handoff_from).toBe("ralplan");
			for (const entry of [di, rp, ug]) expect(entry?.owner_generation).toBeUndefined();
			const demotedDeepInterview = await readJson(path.join(stateDir, "deep-interview-state.json"));
			const successorRalplan = await readJson(path.join(stateDir, "ralplan-state.json"));
			const finalUltragoal = await readJson(path.join(stateDir, "ultragoal-state.json"));
			expect(demotedDeepInterview?.owner_generation).toBe("deep-interview-generation");
			expect(successorRalplan?.owner_generation).toBeUndefined();
			expect(finalUltragoal?.owner_generation).toBeUndefined();
			expect(finalUltragoal?.handoff_from).toBe("ralplan");
		});
	});
	it("defaults session-id from GJC_SESSION_ID env var when no --session-id flag is passed", async () => {
		await withTempCwd(async cwd => {
			const sessionId = "session-env-default";
			await writeJson(modeStatePath(cwd, sessionId, "deep-interview"), {
				skill: "deep-interview",
				version: 1,
				active: true,
				current_phase: "interviewing",
				session_id: sessionId,
			});

			const prior = process.env.GJC_SESSION_ID;
			process.env.GJC_SESSION_ID = sessionId;
			try {
				// No --session-id flag; runtime must pick the env var.
				const result = await runNativeStateCommand(
					["handoff", "--mode", "deep-interview", "--to", "ralplan", "--json"],
					cwd,
				);
				expect(result.status).toBe(0);
				// Session-scoped mode-state demoted (proves env default was applied).
				const caller = parseRequiredJson(
					await fs.readFile(modeStatePath(cwd, sessionId, "deep-interview"), "utf-8"),
					"env-default caller mode state",
				);
				expect(caller.active).toBe(false);
				expect(caller.current_phase).toBe("handoff");
			} finally {
				restoreSessionId(prior);
			}
		});
	});

	it("supports the documented agent flow: write current_phase=handoff via env-defaulted session, then handoff CLI from skill tool", async () => {
		await withTempCwd(async cwd => {
			const sessionId = "session-docs-flow";
			// Bootstrap: an active deep-interview session-scoped state exists.
			await writeJson(modeStatePath(cwd, sessionId, "deep-interview"), {
				skill: "deep-interview",
				version: 1,
				active: true,
				current_phase: "interviewing",
				session_id: sessionId,
			});

			const prior = process.env.GJC_SESSION_ID;
			process.env.GJC_SESSION_ID = sessionId;
			try {
				// Step 1 (agent shell): documented prep write — no --session-id flag, env picks it up.
				const writeResult = await runNativeStateCommand(
					["write", "--mode", "deep-interview", "--input", JSON.stringify({ current_phase: "handoff" }), "--json"],
					cwd,
				);
				expect(writeResult.status).toBe(0);
				const di1 = parseRequiredJson(
					await fs.readFile(modeStatePath(cwd, sessionId, "deep-interview"), "utf-8"),
					"documented-flow preparation state",
				);
				expect(di1.current_phase).toBe("handoff");
				expect(di1.active).toBe(true); // write does NOT demote; only handoff verb does

				// Step 2 (skill tool path): handoff verb without --session-id; env defaults it.
				const handoffResult = await runNativeStateCommand(
					["handoff", "--mode", "deep-interview", "--to", "ralplan", "--json"],
					cwd,
				);
				expect(handoffResult.status).toBe(0);
				const di2 = parseRequiredJson(
					await fs.readFile(modeStatePath(cwd, sessionId, "deep-interview"), "utf-8"),
					"documented-flow caller mode state",
				);
				expect(di2.active).toBe(false);
				expect(di2.handoff_to).toBe("ralplan");
				const rp = parseRequiredJson(
					await fs.readFile(modeStatePath(cwd, sessionId, "ralplan"), "utf-8"),
					"documented-flow callee mode state",
				);
				expect(rp.active).toBe(true);
				expect(rp.handoff_from).toBe("deep-interview");
			} finally {
				restoreSessionId(prior);
			}
		});
	});
});
