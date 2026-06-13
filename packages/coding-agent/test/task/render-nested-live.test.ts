import { beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
import type { AgentProgress, TaskResultReceipt, TaskToolDetails } from "@gajae-code/coding-agent/task";
import { taskToolRenderer } from "@gajae-code/coding-agent/task/render";

// Defends the live-rendering contract for the `task` tool: while a Level-1
// subagent is still mid-flight, any nested `task` activity it has produced
// (already-completed sub-calls in `extractedToolData.task`, plus the in-flight
// snapshot in `inflightTaskDetails`) MUST surface in the parent's streaming
// output — same way it surfaces in the finished result.
describe("task renderer: nested live rendering", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("red-claw");
		expect(theme).toBeDefined();
		setThemeInstance(theme!);
	});

	function makeRunningProgress(overrides: Partial<AgentProgress>): AgentProgress {
		return {
			index: 0,
			id: "parent",
			agent: "task",
			agentSource: "bundled",
			status: "running",
			task: "parent assignment",
			assignment: "parent assignment",
			description: "Parent Level 1 work",
			recentTools: [],
			recentOutput: [],
			toolCount: 1,
			tokens: 1000,
			cost: 0,
			durationMs: 1234,
			...overrides,
		};
	}

	function makeCompletedSubResult(id: string, description: string): TaskResultReceipt {
		return {
			index: 0,
			id,
			agent: "task",
			agentSource: "bundled",
			task: "sub assignment",
			assignment: "sub assignment",
			description,
			status: "completed",
			exitCode: 0,
			truncated: false,
			durationMs: 500,
			tokens: 200,
			preview: "sub-final-output",
			previewTruncated: false,
			outputUnavailable: true,
		};
	}

	function makeRunningSubProgress(id: string, description: string): AgentProgress {
		return {
			index: 0,
			id,
			agent: "task",
			agentSource: "bundled",
			status: "running",
			task: "sub assignment",
			assignment: "sub assignment",
			description,
			recentTools: [],
			recentOutput: [],
			toolCount: 0,
			tokens: 0,
			cost: 0,
			durationMs: 0,
		};
	}

	async function render(progress: AgentProgress): Promise<string> {
		const theme = (await getThemeByName("red-claw"))!;
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 1234,
			progress: [progress],
		};
		const component = taskToolRenderer.renderResult(
			{ content: [{ type: "text", text: "Running 1 agents..." }], details },
			{ expanded: false, isPartial: true, spinnerFrame: 0 },
			theme,
		);
		return Bun.stripANSI(component.render(160).join("\n"));
	}

	async function renderResult(result: TaskResultReceipt): Promise<string> {
		const theme = (await getThemeByName("red-claw"))!;
		const details: TaskToolDetails = {
			projectAgentsDir: null,
			results: [result],
			totalDurationMs: result.durationMs,
		};
		const component = taskToolRenderer.renderResult(
			{ content: [{ type: "text", text: "Task complete" }], details },
			{ expanded: false, isPartial: false, spinnerFrame: 0 },
			theme,
		);
		return Bun.stripANSI(component.render(160).join("\n"));
	}

	it("renders completed nested task results stored in extractedToolData.task while parent is in-progress", async () => {
		const parent = makeRunningProgress({
			id: "1-Parent",
			recentTools: [{ tool: "task", args: "", endMs: Date.now() }],
			extractedToolData: {
				task: [
					{
						projectAgentsDir: null,
						results: [
							makeCompletedSubResult("1-Parent.0-AlphaSub", "Alpha child"),
							makeCompletedSubResult("1-Parent.1-BetaSub", "Beta child"),
						],
						totalDurationMs: 1000,
					} satisfies TaskToolDetails,
				],
			},
		});

		const text = await render(parent);

		// Parent label is intact.
		expect(text).toContain("Parent Level 1 work");
		// Both nested completed children labels surface (formatTaskId collapses
		// dotted ids → "1.0 Parent>AlphaSub").
		expect(text).toContain("Alpha child");
		expect(text).toContain("Beta child");
		expect(text).toContain("1.0 Parent>AlphaSub");
		expect(text).toContain("1.1 Parent>BetaSub");
	});

	it("renders the in-flight nested task snapshot (progress[]) before the call ends", async () => {
		const inflight: TaskToolDetails = {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 0,
			progress: [
				makeRunningSubProgress("2-Parent.0-GammaSub", "Gamma child running"),
				makeRunningSubProgress("2-Parent.1-DeltaSub", "Delta child running"),
			],
		};
		const parent = makeRunningProgress({
			id: "2-Parent",
			currentTool: "task",
			currentToolStartMs: Date.now(),
			inflightTaskDetails: inflight,
		});

		const text = await render(parent);

		expect(text).toContain("Parent Level 1 work");
		expect(text).toContain("Gamma child running");
		expect(text).toContain("Delta child running");
		expect(text).toContain("2.0 Parent>GammaSub");
		expect(text).toContain("2.1 Parent>DeltaSub");
	});

	it("renders requested model substitution in live progress", async () => {
		const text = await render(
			makeRunningProgress({
				id: "2-ModelSub",
				modelSubstitutionWarning: {
					requested: "openai-codex/gpt-5.3-codex",
					effective: "openai-codex/gpt-5.5",
					reason: "auth_unavailable",
				},
			}),
		);

		expect(text).toContain("Requested model substituted: openai-codex/gpt-5.3-codex -> openai-codex/gpt-5.5");
		expect(text).not.toContain("Model override substituted");
	});

	it("renders requested model substitution in final results", async () => {
		const text = await renderResult({
			...makeCompletedSubResult("4-ModelSub", "Model substituted child"),
			modelSubstitutionWarning: {
				requested: "openai-codex/gpt-5.3-codex",
				effective: "openai-codex/gpt-5.5",
				reason: "assistant_model_mismatch",
			},
		});

		expect(text).toContain("Requested model substituted: openai-codex/gpt-5.3-codex -> openai-codex/gpt-5.5");
		expect(text).not.toContain("Model override substituted");
	});

	it("combines completed and in-flight nested snapshots in one tree", async () => {
		const parent = makeRunningProgress({
			currentTool: "task",
			extractedToolData: {
				task: [
					{
						projectAgentsDir: null,
						results: [makeCompletedSubResult("3.0-EpsilonSub", "Epsilon done")],
						totalDurationMs: 1000,
					} satisfies TaskToolDetails,
				],
			},
			inflightTaskDetails: {
				projectAgentsDir: null,
				results: [],
				totalDurationMs: 0,
				progress: [makeRunningSubProgress("3.1-ZetaSub", "Zeta running")],
			},
		});

		const text = await render(parent);

		expect(text).toContain("Epsilon done");
		expect(text).toContain("Zeta running");
		// Completed entry shows "done" badge, in-flight does not.
		const epsilonIdx = text.indexOf("Epsilon done");
		const zetaIdx = text.indexOf("Zeta running");
		// Completed entries are emitted before the in-flight snapshot.
		expect(epsilonIdx).toBeLessThan(zetaIdx);
	});
});
