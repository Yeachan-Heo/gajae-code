import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as url from "node:url";
import { runNativeDeepInterviewCommand } from "@gajae-code/coding-agent/gjc-runtime/deep-interview-runtime";
import { runNativeRalplanCommand } from "@gajae-code/coding-agent/gjc-runtime/ralplan-runtime";

const tempRoots: string[] = [];
const codingAgentRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../..");

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-deep-interview-runtime-"));
	tempRoots.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
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
		expect(payload.path).toBe(path.join(root, ".gjc", "specs", "deep-interview-persist-me.md"));
		expect(await fs.readFile(payload.path, "utf-8")).toBe("# Final Spec\n\nAcceptance: persist me.\n");

		const state = JSON.parse(
			await fs.readFile(path.join(root, ".gjc", "state", "deep-interview-state.json"), "utf-8"),
		);
		expect(state.current_phase).toBe("handoff");
		expect(state.active).toBe(true);
		expect(state.spec_path).toBe(payload.path);
		expect(state.spec_slug).toBe("persist-me");
		await expect(fs.access(path.join(root, ".gjc", "plans"))).rejects.toThrow();
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

		const specPath = path.join(root, ".gjc", "specs", "deep-interview-deliberate-spec.md");
		expect(await fs.readFile(specPath, "utf-8")).toContain("Use ralplan deliberately.");

		const deepInterviewState = JSON.parse(
			await fs.readFile(path.join(root, ".gjc", "state", "deep-interview-state.json"), "utf-8"),
		);
		expect(deepInterviewState.active).toBe(false);
		expect(deepInterviewState.current_phase).toBe("handoff");
		expect(deepInterviewState.handoff_to).toBe("ralplan");
		expect(deepInterviewState.spec_path).toBe(specPath);

		const ralplanState = JSON.parse(
			await fs.readFile(path.join(root, ".gjc", "state", "ralplan-state.json"), "utf-8"),
		);
		expect(ralplanState.active).toBe(true);
		expect(ralplanState.current_phase).toBe("planning");
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
		expect(deepPayload.path).toContain(path.join(".gjc", "specs", "deep-interview-separate.md"));

		const ralplanResult = await runNativeRalplanCommand(
			["--write", "--stage", "final", "--stage_n", "1", "--artifact", "# Plan", "--run-id", "separate", "--json"],
			root,
		);
		expect(ralplanResult.status).toBe(0);
		const ralplanPayload = JSON.parse(ralplanResult.stdout ?? "{}");
		expect(ralplanPayload.path).toContain(path.join(".gjc", "plans", "ralplan", "separate", "stage-01-final.md"));
		expect(await fs.readFile(deepPayload.path, "utf-8")).toBe("# Requirements\n");
		expect(await fs.readFile(ralplanPayload.path, "utf-8")).toBe("# Plan\n");
	});
	it("persists Korean as the deep-interview question language when the initial idea is Korean", async () => {
		const root = await tempDir();
		const result = await runNativeDeepInterviewCommand(["--json", "한국어 세션에서 구현 방향을 명확히 해줘"], root);
		expect(result.status).toBe(0);
		const payload = JSON.parse(result.stdout ?? "{}");
		expect(payload.language).toMatchObject({
			code: "ko",
			label: "Korean",
			source: "initial-idea",
		});
		expect(payload.language.instruction).toContain("Korean");

		const state = JSON.parse(
			await fs.readFile(path.join(root, ".gjc", "state", "deep-interview-state.json"), "utf-8"),
		);
		expect(state.language).toEqual(payload.language);
		expect(state.state.language).toEqual(payload.language);
	});

	it("lets explicit English requests override Korean deep-interview language detection", async () => {
		const root = await tempDir();
		const result = await runNativeDeepInterviewCommand(["--json", "한국어 배경이지만 질문은 영어로 해줘"], root);
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
		const state = JSON.parse(
			await fs.readFile(path.join(root, ".gjc", "state", "deep-interview-state.json"), "utf-8"),
		);
		expect(state.resolution).toBe("standard");
		expect(state.threshold).toBeCloseTo(0.05);
		expect(state.threshold_source).toBe("default");
		expect(state.state.initial_idea).toBe("my vague idea");
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
		const active = JSON.parse(
			await fs.readFile(path.join(root, ".gjc", "state", "skill-active-state.json"), "utf-8"),
		);
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
