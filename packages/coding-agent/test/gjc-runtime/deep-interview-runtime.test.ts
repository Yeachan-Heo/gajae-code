import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as url from "node:url";
import { runNativeDeepInterviewCommand } from "@gajae-code/coding-agent/gjc-runtime/deep-interview-runtime";
import {
	createDeepInterviewIntentManifest,
	MAX_INITIAL_CONTEXT_LENGTH,
	reviewDeepInterviewIntent,
	validateDeepInterviewV1Envelope,
} from "@gajae-code/coding-agent/gjc-runtime/deep-interview-state";
import { runNativeRalplanCommand } from "@gajae-code/coding-agent/gjc-runtime/ralplan-runtime";
import {
	activeSnapshotPath,
	auditPath,
	modeStatePath,
	sessionPlansDir,
	sessionSpecsDir,
} from "@gajae-code/coding-agent/gjc-runtime/session-layout";

import { getConfigRootDir, setAgentDir } from "@gajae-code/utils";
import { resetSettingsForTest } from "../../src/config/settings";

const tempRoots: string[] = [];
const codingAgentRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../..");

const TEST_SESSION_ID = "test-session";
const originalSessionId = process.env.GJC_SESSION_ID;
const originalAgentDir = process.env.GJC_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");
async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-deep-interview-runtime-"));
	tempRoots.push(dir);
	return dir;
}

beforeAll(() => {
	process.env.GJC_SESSION_ID = TEST_SESSION_ID;
});

beforeEach(async () => {
	resetSettingsForTest();
	setAgentDir(await tempDir());
});

afterEach(async () => {
	resetSettingsForTest();
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.GJC_CODING_AGENT_DIR;
	}
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

afterAll(() => {
	if (originalSessionId !== undefined) process.env.GJC_SESSION_ID = originalSessionId;
	else delete process.env.GJC_SESSION_ID;
});

describe("native gjc deep-interview runtime", () => {
	it("advertises the deep-interview spec persistence and handoff surface in command help", async () => {
		const source = await fs.readFile(path.join(codingAgentRoot, "src/commands/deep-interview.ts"), "utf-8");
		// The lightweight CLI help renderer advertises exactly the static flags/examples declared by the command.
		expect(source).toContain("write: Flags.boolean");
		expect(source).toContain("stage: Flags.string");
		expect(source).toContain("slug: Flags.string");
		expect(source).toContain("spec: Flags.string");
		expect(source).toContain("deliberate: Flags.boolean");
		expect(source).toContain("trace: Flags.boolean");
		expect(source).toContain("handoff: Flags.string");
	});
	it("routes kickoff locking and parent creation through state-writer", async () => {
		const source = await fs.readFile(
			path.join(codingAgentRoot, "src/gjc-runtime/deep-interview-runtime.ts"),
			"utf-8",
		);

		expect(source).toMatch(/withWorkflowStateLock\(\s*`\$\{statePath\}\.kickoff`/);
		expect(source).toMatch(/\n\s+\{ cwd \},\n\s+\);\n\}/);
		expect(source).not.toContain('from "../config/file-lock"');
		expect(source).not.toContain("fs.mkdir(path.dirname(statePath), { recursive: true });");
	});

	it("handles missing, valid, and corrupt deep-interview state during spec persistence", async () => {
		const missingRoot = await tempDir();
		const missing = await runNativeDeepInterviewCommand(
			["--write", "--stage", "final", "--slug", "missing-state", "--spec", "# Missing", "--json"],
			missingRoot,
		);
		expect(missing.status).toBe(0);
		const missingState = JSON.parse(
			await fs.readFile(modeStatePath(missingRoot, TEST_SESSION_ID, "deep-interview"), "utf-8"),
		);
		expect(missingState.spec_slug).toBe("missing-state");

		const validRoot = await tempDir();
		const validStatePath = modeStatePath(validRoot, TEST_SESSION_ID, "deep-interview");
		await fs.mkdir(path.dirname(validStatePath), { recursive: true });
		await fs.writeFile(
			validStatePath,
			`${JSON.stringify({ transcript: [{ question: "q", answer: "a" }], current_phase: "interviewing" })}\n`,
			"utf-8",
		);
		const valid = await runNativeDeepInterviewCommand(
			["--write", "--stage", "final", "--slug", "valid-state", "--spec", "# Valid", "--json"],
			validRoot,
		);
		expect(valid.status).toBe(0);
		const validState = JSON.parse(await fs.readFile(validStatePath, "utf-8"));
		expect(validState.transcript).toEqual([{ question: "q", answer: "a" }]);
		expect(validState.spec_slug).toBe("valid-state");
	});

	it("enforces locked-intent review before creating a spec while preserving legacy handoff", async () => {
		const lockedItems = [
			{ id: "artifact:report", category: "artifact" as const, statement: "Produce an audit report" },
			{ id: "surface:review", category: "surface" as const, statement: "Provide a reviewer surface" },
		];
		const confirmationHash = "a".repeat(64);
		const approvalHash = "b".repeat(64);
		const locked = createDeepInterviewIntentManifest(lockedItems, { round: 0, answer_hash: confirmationHash });
		const fullSpec = "# Full\nartifact:report\nsurface:review";
		const reducedSpec = "# Reduced\nartifact:report";
		const approvedReduction = reviewDeepInterviewIntent(locked, [lockedItems[0]], {
			status: "approved",
			supporting_substitutions: [
				{
					removed_id: "surface:review",
					replacement_ids: ["artifact:report"],
					rationale: "Report covers the review",
				},
			],
			approval_round: 2,
			answer_hash: approvalHash,
			user_answer_evidence: `answer_hash:${approvalHash}`,
		});
		const notRequired = reviewDeepInterviewIntent(locked, lockedItems, {
			status: "not_required",
			supporting_substitutions: [],
		});

		async function writeState(root: string, state: Record<string, unknown>): Promise<void> {
			const statePath = modeStatePath(root, TEST_SESSION_ID, "deep-interview");
			await fs.mkdir(path.dirname(statePath), { recursive: true });
			await fs.writeFile(statePath, `${JSON.stringify({ state })}\n`, "utf-8");
		}
		async function expectBlocked(
			name: string,
			state: Record<string, unknown>,
			spec: string,
			message: string,
		): Promise<void> {
			const root = await tempDir();
			await writeState(root, state);
			const result = await runNativeDeepInterviewCommand(
				["--write", "--stage", "final", "--slug", name, "--spec", spec, "--json"],
				root,
			);
			expect(result.status, name).toBe(2);
			expect(result.stderr, name).toContain(message);
			await expect(
				fs.access(path.join(sessionSpecsDir(root, TEST_SESSION_ID), `deep-interview-${name}.md`)),
			).rejects.toThrow();
		}

		const legacyRoot = await tempDir();
		await writeState(legacyRoot, { rounds: [] });
		const legacy = await runNativeDeepInterviewCommand(
			["--write", "--stage", "final", "--slug", "legacy", "--spec", fullSpec, "--json"],
			legacyRoot,
		);
		expect(legacy.status).toBe(0);

		const fullRoot = await tempDir();
		await writeState(fullRoot, { intent_contract: locked, intent_review: notRequired, rounds: [] });
		const full = await runNativeDeepInterviewCommand(
			["--write", "--stage", "final", "--slug", "full", "--spec", fullSpec, "--json"],
			fullRoot,
		);
		expect(full.status).toBe(0);
		expect(
			await fs.readFile(path.join(sessionSpecsDir(fullRoot, TEST_SESSION_ID), "deep-interview-full.md"), "utf-8"),
		).toContain("surface:review");

		const automaticRoot = await tempDir();
		await writeState(automaticRoot, { intent_contract: locked, rounds: [] });
		const automatic = await runNativeDeepInterviewCommand(
			["--write", "--stage", "final", "--slug", "automatic-review", "--spec", fullSpec, "--json"],
			automaticRoot,
		);
		expect(automatic.status).toBe(0);
		const automaticState = JSON.parse(
			await fs.readFile(modeStatePath(automaticRoot, TEST_SESSION_ID, "deep-interview"), "utf-8"),
		);
		expect(automaticState.state.intent_review).toMatchObject({ status: "not_required", removed_locked_ids: [] });
		await expectBlocked(
			"malformed-review",
			{ intent_contract: locked, intent_review: {}, rounds: [] },
			fullSpec,
			"invalid intent review",
		);
		await expectBlocked(
			"pending-review",
			{
				intent_contract: locked,
				intent_review: {
					...approvedReduction,
					status: "pending",
					approval_round: undefined,
					answer_hash: undefined,
					user_answer_evidence: undefined,
				},
				rounds: [],
			},
			reducedSpec,
			"pending or unapproved",
		);
		await expectBlocked(
			"stale-review",
			{
				intent_contract: locked,
				intent_review: { ...approvedReduction, observed_digest: "0".repeat(64) },
				rounds: [],
			},
			reducedSpec,
			"stale intent review",
		);
		await expectBlocked(
			"omitted-locked",
			{ intent_contract: locked, intent_review: notRequired, rounds: [] },
			reducedSpec,
			"stale intent review",
		);
		await expectBlocked(
			"missing-substitution",
			{
				intent_contract: locked,
				intent_review: { ...approvedReduction, supporting_substitutions: [] },
				rounds: [{ round: 2, answer_hash: approvalHash }],
			},
			reducedSpec,
			"every substitution",
		);
		await expectBlocked(
			"absent-replacement",
			{
				intent_contract: locked,
				intent_review: {
					...approvedReduction,
					supporting_substitutions: [
						{ ...approvedReduction.supporting_substitutions[0], replacement_ids: ["surface:review"] },
					],
				},
				rounds: [{ round: 2, answer_hash: approvalHash }],
			},
			reducedSpec,
			"invalid intent substitution",
		);
		await expectBlocked(
			"unrecorded-approval",
			{
				intent_contract: locked,
				intent_review: approvedReduction,
				rounds: [{ round: 2, answer_hash: confirmationHash }],
			},
			reducedSpec,
			"approval evidence is invalid",
		);

		const approvedRoot = await tempDir();
		await writeState(approvedRoot, {
			intent_contract: locked,
			intent_review: approvedReduction,
			rounds: [{ round: 2, answer_hash: approvalHash }],
		});
		const approved = await runNativeDeepInterviewCommand(
			["--write", "--stage", "final", "--slug", "approved", "--spec", reducedSpec, "--json"],
			approvedRoot,
		);
		expect(approved.status).toBe(0);
		expect(
			await fs.readFile(
				path.join(sessionSpecsDir(approvedRoot, TEST_SESSION_ID), "deep-interview-approved.md"),
				"utf-8",
			),
		).toContain("artifact:report");
	});

	it("fails closed on corrupt deep-interview state unless --force is supplied", async () => {
		const root = await tempDir();
		const statePath = modeStatePath(root, TEST_SESSION_ID, "deep-interview");
		await fs.mkdir(path.dirname(statePath), { recursive: true });
		await fs.writeFile(statePath, '{"current_phase":', "utf-8");

		const rejected = await runNativeDeepInterviewCommand(
			["--write", "--stage", "final", "--slug", "corrupt-rejected", "--spec", "# Rejected", "--json"],
			root,
		);
		expect(rejected.status).toBe(2);
		expect(rejected.stderr).toContain("existing deep-interview state is corrupt or tampered");
		expect(rejected.stderr).toContain("use --force to overwrite");
		expect(await fs.readFile(statePath, "utf-8")).toBe('{"current_phase":');
		await expect(
			fs.access(path.join(sessionSpecsDir(root, TEST_SESSION_ID), "deep-interview-corrupt-rejected.md")),
		).rejects.toThrow();

		const forced = await runNativeDeepInterviewCommand(
			["--write", "--stage", "final", "--slug", "corrupt-forced", "--spec", "# Forced", "--force", "--json"],
			root,
		);
		expect(forced.status).toBe(0);
		const forcedState = JSON.parse(await fs.readFile(statePath, "utf-8"));
		expect(forcedState.spec_slug).toBe("corrupt-forced");
		expect(forcedState.receipt).toMatchObject({ skill: "deep-interview", owner: "gjc-runtime" });
		const audit = (await fs.readFile(auditPath(root, TEST_SESSION_ID), "utf-8"))
			.trim()
			.split("\n")
			.map(line => JSON.parse(line) as Record<string, unknown>);
		expect(
			audit.some(entry => entry.skill === "deep-interview" && entry.verb === "write" && entry.forced === true),
		).toBe(true);
	});

	it("persists a final spec under .gjc/specs through the native CLI/API", async () => {
		const root = await tempDir();
		const specPath = path.join(root, "final-spec.md");
		await fs.writeFile(specPath, "# Final Spec\n\nAcceptance: persist me.\n");

		const result = await runNativeDeepInterviewCommand(
			["--write", "--stage", "final", "--slug", "persist-me", "--spec", specPath, "--json"],
			root,
		);
		expect(result.status).toBe(0);
		const payload = JSON.parse(result.stdout ?? "{}");
		expect(payload.path).toBe(path.join(sessionSpecsDir(root, TEST_SESSION_ID), "deep-interview-persist-me.md"));
		expect(await fs.readFile(payload.path, "utf-8")).toBe("# Final Spec\n\nAcceptance: persist me.\n");

		const state = JSON.parse(await fs.readFile(modeStatePath(root, TEST_SESSION_ID, "deep-interview"), "utf-8"));
		expect(state.current_phase).toBe("handoff");
		expect(state.active).toBe(true);
		expect(state.spec_path).toBe(payload.path);
		expect(state.spec_slug).toBe("persist-me");
		await expect(fs.access(sessionPlansDir(root, TEST_SESSION_ID))).rejects.toThrow();
	});

	it("accepts a long inline --spec that exceeds the OS path-length limit", async () => {
		const root = await tempDir();
		// A spec far longer than PATH_MAX so path.resolve(...) + fs.stat throws ENAMETOOLONG
		// instead of ENOENT; the runtime must fall through to treating --spec as inline content.
		const inlineSpec = `# Final Spec\n\n${"acceptance criterion line ".repeat(2000)}`;
		expect(inlineSpec.length).toBeGreaterThan(4096);

		const result = await runNativeDeepInterviewCommand(
			["--write", "--stage", "final", "--slug", "long-inline", "--spec", inlineSpec, "--json"],
			root,
		);
		expect(result.status).toBe(0);
		const payload = JSON.parse(result.stdout ?? "{}");
		expect(payload.path).toBe(path.join(sessionSpecsDir(root, TEST_SESSION_ID), "deep-interview-long-inline.md"));
		expect(await fs.readFile(payload.path, "utf-8")).toBe(`${inlineSpec}\n`);
	});

	it("accepts a 100k-code-point resolved spec and rejects +1 before persisting artifacts or handoff state", async () => {
		const acceptedRoot = await tempDir();
		const exactSpec = "😀".repeat(100_000);
		const sourceSpecPath = path.join(acceptedRoot, "exact-spec.md");
		await fs.writeFile(sourceSpecPath, exactSpec, "utf-8");

		const accepted = await runNativeDeepInterviewCommand(
			["--write", "--stage", "final", "--slug", "exact-limit", "--spec", sourceSpecPath, "--json"],
			acceptedRoot,
		);
		expect(accepted.status).toBe(0);
		expect(
			await fs.readFile(
				path.join(sessionSpecsDir(acceptedRoot, TEST_SESSION_ID), "deep-interview-exact-limit.md"),
				"utf-8",
			),
		).toBe(`${exactSpec}\n`);

		const rejectedRoot = await tempDir();
		const rejected = await runNativeDeepInterviewCommand(
			[
				"--write",
				"--stage",
				"final",
				"--slug",
				"over-limit",
				"--spec",
				"😀".repeat(100_001),
				"--deliberate",
				"--json",
			],
			rejectedRoot,
		);
		expect(rejected.status).toBe(1);
		expect(rejected.stderr).toContain("structured deep-interview response exceeds max length 100000");
		await expect(
			fs.access(path.join(sessionSpecsDir(rejectedRoot, TEST_SESSION_ID), "deep-interview-over-limit.md")),
		).rejects.toThrow();
		await expect(
			fs.access(path.join(sessionSpecsDir(rejectedRoot, TEST_SESSION_ID), "deep-interview-index.jsonl")),
		).rejects.toThrow();
		await expect(fs.access(modeStatePath(rejectedRoot, TEST_SESSION_ID, "deep-interview"))).rejects.toThrow();
		await expect(fs.access(modeStatePath(rejectedRoot, TEST_SESSION_ID, "ralplan"))).rejects.toThrow();
		await expect(fs.access(activeSnapshotPath(rejectedRoot, TEST_SESSION_ID))).rejects.toThrow();
	});

	it("uses --deliberate to persist the final spec and hand off to ralplan", async () => {
		const root = await tempDir();
		const result = await runNativeDeepInterviewCommand(
			[
				"--write",
				"--stage",
				"final",
				"--slug",
				"deliberate-spec",
				"--spec",
				"# Final Spec\n\nUse ralplan deliberately.",
				"--deliberate",
				"--json",
			],
			root,
		);
		expect(result.status).toBe(0);
		const payload = JSON.parse(result.stdout ?? "{}");
		expect(payload.handoff).toMatchObject({ to: "ralplan", mode: "deliberate" });

		const specPath = path.join(sessionSpecsDir(root, TEST_SESSION_ID), "deep-interview-deliberate-spec.md");
		expect(await fs.readFile(specPath, "utf-8")).toContain("Use ralplan deliberately.");

		const deepInterviewState = JSON.parse(
			await fs.readFile(modeStatePath(root, TEST_SESSION_ID, "deep-interview"), "utf-8"),
		);
		expect(deepInterviewState.active).toBe(false);
		expect(deepInterviewState.current_phase).toBe("handoff");
		expect(deepInterviewState.handoff_to).toBe("ralplan");
		expect(deepInterviewState.spec_path).toBe(specPath);

		const ralplanState = JSON.parse(await fs.readFile(modeStatePath(root, TEST_SESSION_ID, "ralplan"), "utf-8"));
		expect(ralplanState.active).toBe(true);
		expect(ralplanState.current_phase).toBe("planner");
		expect(ralplanState.mode).toBe("deliberate");
		expect(ralplanState.task).toBe(specPath);
		expect(ralplanState.handoff_from).toBe("deep-interview");
	});

	it("keeps deep-interview spec persistence distinct from ralplan plan writes", async () => {
		const root = await tempDir();
		const deepResult = await runNativeDeepInterviewCommand(
			["--write", "--stage", "final", "--slug", "separate", "--spec", "# Requirements", "--json"],
			root,
		);
		expect(deepResult.status).toBe(0);
		const deepPayload = JSON.parse(deepResult.stdout ?? "{}");
		expect(deepPayload.path).toBe(path.join(sessionSpecsDir(root, TEST_SESSION_ID), "deep-interview-separate.md"));

		const ralplanResult = await runNativeRalplanCommand(
			["--write", "--stage", "final", "--stage_n", "1", "--artifact", "# Plan", "--run-id", "separate", "--json"],
			root,
		);
		expect(ralplanResult.status).toBe(0);
		const ralplanPayload = JSON.parse(ralplanResult.stdout ?? "{}");
		expect(ralplanPayload.path).toContain(
			path.join(sessionPlansDir(root, TEST_SESSION_ID), "ralplan", "separate", "stage-01-final.md"),
		);
		expect(await fs.readFile(deepPayload.path, "utf-8")).toBe("# Requirements\n");
		expect(await fs.readFile(ralplanPayload.path, "utf-8")).toBe("# Plan\n");
	});
	it("preserves an obvious non-English user/session language without a language-specific directive", async () => {
		const root = await tempDir();
		const result = await runNativeDeepInterviewCommand(["--json", "한국어 세션에서 구현 방향을 명확히 해줘"], root);
		expect(result.status).toBe(0);
		const payload = JSON.parse(result.stdout ?? "{}");
		expect(payload.language).toMatchObject({
			code: "user",
			label: "User language",
			source: "initial-idea",
		});
		expect(payload.language.instruction).toContain("user/session language");
		expect(payload.language.instruction).not.toContain("Korean");
		expect(payload.language.instruction).not.toContain("한국어");

		const state = JSON.parse(await fs.readFile(modeStatePath(root, TEST_SESSION_ID, "deep-interview"), "utf-8"));
		expect(state.language).toEqual(payload.language);
		expect(state.state.language).toEqual(payload.language);
	});

	it("honors explicit English requests without language-specific keyword branches", async () => {
		const root = await tempDir();
		const result = await runNativeDeepInterviewCommand(["--json", "Please respond in English"], root);
		expect(result.status).toBe(0);
		const payload = JSON.parse(result.stdout ?? "{}");
		expect(payload.language).toMatchObject({
			code: "en",
			label: "English",
			source: "explicit-user-request",
		});
		expect(payload.language.instruction).toContain("explicitly requested English");
	});

	it("defaults to the SKILL.md default threshold (0.05) when no resolution flag or settings exist", async () => {
		const root = await tempDir();
		const result = await runNativeDeepInterviewCommand(["my vague idea"], root);
		expect(result.status).toBe(0);
		const state = JSON.parse(await fs.readFile(modeStatePath(root, TEST_SESSION_ID, "deep-interview"), "utf-8"));
		expect(state.resolution).toBe("standard");
		expect(state.threshold).toBeCloseTo(0.05);
		expect(state.threshold_source).toBe("default");
		expect(state.state.initial_idea).toBe("my vague idea");
		validateDeepInterviewV1Envelope(state);
		expect(state.schema_version).toBe(1);
		expect(state.state.type).toBe("greenfield");
		expect(state.state.ontology_snapshots).toEqual([]);
		expect(state.state.auto_researched_rounds).toEqual([]);
		expect(state.state.auto_answered_rounds).toEqual([]);
		expect(state.state.architect_failures).toBe(0);
		expect(state.state.topology).toEqual({ status: "pending", components: [], deferred_components: [] });
		expect(state.state.established_facts).toEqual([]);
	});
	it("surfaces threshold-config filesystem failures instead of treating them as absent", async () => {
		const root = await tempDir();
		const agentDir = await tempDir();
		setAgentDir(agentDir);
		await fs.mkdir(path.join(agentDir, "config.yml"));

		const result = await runNativeDeepInterviewCommand(["idea"], root);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("config.yml");
	});
	it("uses exit 3 for corrupt kickoff state while preserving parser exit 2", async () => {
		const root = await tempDir();
		const statePath = modeStatePath(root, TEST_SESSION_ID, "deep-interview");
		await fs.mkdir(path.dirname(statePath), { recursive: true });
		await fs.writeFile(statePath, '{"state":', "utf-8");

		const corrupt = await runNativeDeepInterviewCommand(["--json", "idea"], root);
		expect(corrupt.status).toBe(3);
		expect(corrupt.stderr).toContain("DI_STATE_CORRUPT");

		const invalid = await runNativeDeepInterviewCommand(["--threshold", "not-a-number", "idea"], root);
		expect(invalid.status).toBe(2);
	});

	it("rejects an oversized initial idea before seeding workflow state", async () => {
		const root = await tempDir();
		const result = await runNativeDeepInterviewCommand(["--json", "한".repeat(MAX_INITIAL_CONTEXT_LENGTH + 1)], root);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("initial_idea exceeds max length");
		await expect(fs.stat(modeStatePath(root, TEST_SESSION_ID, "deep-interview"))).rejects.toThrow();
	});

	it("runs an optional bounded trace pre-step before deep-interview questions", async () => {
		const root = await tempDir();
		await fs.mkdir(path.join(root, "packages/coding-agent/src/gjc-runtime"), { recursive: true });
		await fs.writeFile(
			path.join(root, "package.json"),
			JSON.stringify({ name: "trace-fixture", scripts: { test: "bun test", check: "bun check" } }),
		);
		await fs.writeFile(
			path.join(root, "packages/coding-agent/src/gjc-runtime/deep-interview-runtime.ts"),
			"raw content must not be copied into the trace summary\n".repeat(200),
		);

		const result = await runNativeDeepInterviewCommand(
			["--trace", "--json", "Add trace pre-skill option to deep-interview"],
			root,
		);

		expect(result.status).toBe(0);
		const payload = JSON.parse(result.stdout ?? "{}");
		expect(payload.trace).toMatchObject({ enabled: true, bounded: true });
		expect(payload.trace.relevant_paths.length).toBeLessThanOrEqual(12);
		expect(
			payload.trace.relevant_paths.some((entry: { path: string }) =>
				entry.path.includes("deep-interview-runtime.ts"),
			),
		).toBe(true);

		const state = JSON.parse(await fs.readFile(modeStatePath(root, TEST_SESSION_ID, "deep-interview"), "utf-8"));
		expect(state.state.rounds).toEqual([]);
		expect(state.state.type).toBe("brownfield");
		expect(state.state.trace_summary).toEqual(payload.trace);
		expect(state.state.codebase_context).toMatchObject({ source: "trace" });
		expect(JSON.stringify(state.state.trace_summary)).not.toContain("raw content must not be copied");
	});

	it("keeps trace path scanning on a hard budget and skips heavy directories", async () => {
		const root = await tempDir();
		await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "trace-budget-fixture" }));
		await fs.mkdir(path.join(root, "vendor", "deep-interview"), { recursive: true });
		await fs.writeFile(path.join(root, "vendor", "deep-interview", "secret-token.ts"), "token should not be listed");
		await fs.mkdir(path.join(root, "target", "deep-interview"), { recursive: true });
		await fs.writeFile(path.join(root, "target", "deep-interview", "generated.ts"), "generated should not be listed");
		for (let index = 0; index < 80; index += 1) {
			await fs.mkdir(path.join(root, `src-${index}`), { recursive: true });
			await fs.writeFile(path.join(root, `src-${index}`, `deep-interview-${index}.ts`), "bounded path hint only");
		}

		const result = await runNativeDeepInterviewCommand(["--trace", "--json", "deep interview budget"], root);

		expect(result.status).toBe(0);
		const payload = JSON.parse(result.stdout ?? "{}");
		expect(payload.trace.limits).toMatchObject({
			max_directory_visits: 1200,
			max_entry_visits: 5000,
			max_pending_directories: 1200,
		});
		expect(payload.trace.relevant_paths.length).toBeLessThanOrEqual(12);
		expect(payload.trace.relevant_paths.map((entry: { path: string }) => entry.path)).not.toContain(
			"vendor/deep-interview/secret-token.ts",
		);
		expect(payload.trace.relevant_paths.map((entry: { path: string }) => entry.path)).not.toContain(
			"target/deep-interview/generated.ts",
		);
	});

	it("keeps the normal no-trace deep-interview seed path unchanged", async () => {
		const root = await tempDir();
		const statePath = modeStatePath(root, TEST_SESSION_ID, "deep-interview");
		const stateDirectoryExistsBeforeKickoff = await fs
			.stat(path.dirname(statePath))
			.then(() => true)
			.catch(() => false);
		expect(stateDirectoryExistsBeforeKickoff).toBe(false);
		const result = await runNativeDeepInterviewCommand(["--json", "my vague idea"], root);
		expect(result.status).toBe(0);
		const payload = JSON.parse(result.stdout ?? "{}");
		expect(payload.trace).toBeUndefined();

		const state = JSON.parse(await fs.readFile(modeStatePath(root, TEST_SESSION_ID, "deep-interview"), "utf-8"));
		expect(state.trace).toBeUndefined();
		expect(state.state.trace).toBeUndefined();
		expect(state.state.trace_summary).toBeUndefined();
		expect(state.state.codebase_context).toBeUndefined();
	});

	it("honors gjc.deepInterview.ambiguityThreshold in project .gjc/settings.json", async () => {
		const root = await tempDir();
		await fs.mkdir(path.join(root, ".gjc"), { recursive: true });
		await fs.writeFile(
			path.join(root, ".gjc", "settings.json"),
			JSON.stringify({ gjc: { deepInterview: { ambiguityThreshold: 0.08 } } }),
		);
		const result = await runNativeDeepInterviewCommand(["--standard", "--json", "idea"], root);
		expect(result.status).toBe(0);
		const payload = JSON.parse(result.stdout ?? "{}");
		expect(payload.threshold).toBeCloseTo(0.08);
		expect(payload.threshold_source).toBe(path.join(root, ".gjc", "settings.json"));
	});

	it("prefers modern config.yml threshold over legacy project settings.json", async () => {
		const root = await tempDir();
		const agentDir = await tempDir();
		setAgentDir(agentDir);
		resetSettingsForTest();
		await fs.writeFile(path.join(agentDir, "config.yml"), "gjc:\n  deepInterview:\n    ambiguityThreshold: 0.2\n");
		await fs.mkdir(path.join(root, ".gjc"), { recursive: true });
		await fs.writeFile(
			path.join(root, ".gjc", "settings.json"),
			JSON.stringify({ gjc: { deepInterview: { ambiguityThreshold: 0.08 } } }),
		);

		resetSettingsForTest();
		const result = await runNativeDeepInterviewCommand(["--standard", "--json", "idea"], root);

		expect(result.status).toBe(0);
		const payload = JSON.parse(result.stdout ?? "{}");
		expect(payload.threshold).toBeCloseTo(0.2);
		expect(payload.threshold_source).toBe(path.join(agentDir, "config.yml"));
	});

	it("--threshold beats project settings.json", async () => {
		const root = await tempDir();
		await fs.mkdir(path.join(root, ".gjc"), { recursive: true });
		await fs.writeFile(
			path.join(root, ".gjc", "settings.json"),
			JSON.stringify({ gjc: { deepInterview: { ambiguityThreshold: 0.08 } } }),
		);
		const result = await runNativeDeepInterviewCommand(
			["--threshold", "0.25", "--threshold-source", "flag:explicit", "--json", "idea"],
			root,
		);
		expect(result.status).toBe(0);
		const payload = JSON.parse(result.stdout ?? "{}");
		expect(payload.threshold).toBeCloseTo(0.25);
		expect(payload.threshold_source).toBe("flag:explicit");
	});

	it("--quick / --standard / --deep map to their resolution thresholds", async () => {
		const root = await tempDir();
		const quick = await runNativeDeepInterviewCommand(["--quick", "--json", "idea"], root);
		expect(quick.status).toBe(0);
		expect(JSON.parse(quick.stdout ?? "{}").resolution).toBe("quick");
		expect(JSON.parse(quick.stdout ?? "{}").threshold).toBeCloseTo(0.6);

		const root2 = await tempDir();
		const deep = await runNativeDeepInterviewCommand(["--deep", "--json", "idea"], root2);
		expect(JSON.parse(deep.stdout ?? "{}").resolution).toBe("deep");
		expect(JSON.parse(deep.stdout ?? "{}").threshold).toBeCloseTo(0.35);
	});

	it("syncs deep-interview HUD chips for the active run", async () => {
		const root = await tempDir();
		await runNativeDeepInterviewCommand(["--standard", "idea body"], root);
		const active = JSON.parse(await fs.readFile(activeSnapshotPath(root, TEST_SESSION_ID), "utf-8"));
		const entry = (
			active.active_skills as Array<{
				skill: string;
				phase?: string;
				hud?: { chips?: Array<{ label: string; value?: string }> };
			}>
		).find(e => e.skill === "deep-interview");
		expect(entry).toBeTruthy();
		expect(entry?.phase).toBe("interviewing");
		const chips = entry?.hud?.chips ?? [];
		expect(chips.some(c => c.label === "phase" && c.value === "interviewing")).toBe(true);
		expect(chips.some(c => c.label === "ambiguity")).toBe(true);
	});

	it("rejects --threshold outside (0,1] with exit 2", async () => {
		const root = await tempDir();
		const tooBig = await runNativeDeepInterviewCommand(["--threshold", "1.5", "idea"], root);
		expect(tooBig.status).toBe(2);
		expect(tooBig.stderr).toContain("invalid --threshold");

		const negative = await runNativeDeepInterviewCommand(["--threshold", "-0.1", "idea"], root);
		expect(negative.status).toBe(2);
	});

	it("rejects combining multiple resolution flags with exit 2", async () => {
		const root = await tempDir();
		const result = await runNativeDeepInterviewCommand(["--quick", "--deep", "idea"], root);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("at most one");
	});

	it("rejects missing idea with exit 2", async () => {
		const root = await tempDir();
		const result = await runNativeDeepInterviewCommand(["--standard"], root);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("requires an idea");
	});

	it("rejects unknown flags with exit 2", async () => {
		const root = await tempDir();
		const result = await runNativeDeepInterviewCommand(["--no-such-flag", "idea"], root);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("unknown flag");
	});
});
