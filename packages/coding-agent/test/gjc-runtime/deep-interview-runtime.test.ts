import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as url from "node:url";
import { runNativeDeepInterviewCommand } from "@gajae-code/coding-agent/gjc-runtime/deep-interview-runtime";
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
		expect(source).toContain("handoff: Flags.string");
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
		expect(state.state.established_facts).toEqual([]);
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
