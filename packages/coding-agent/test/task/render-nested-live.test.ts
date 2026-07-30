import { beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
import type { AgentProgress, TaskResultReceipt, TaskToolDetails } from "@gajae-code/coding-agent/task";
import { taskToolRenderer } from "@gajae-code/coding-agent/task/render";
import { collectProviderDegradationGroups } from "../../src/task/provider-retry-status";

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
	it("renders the fast-mode glyph in live and final subagent panels", async () => {
		const theme = (await getThemeByName("red-claw"))!;
		const liveText = await render(
			makeRunningProgress({
				id: "2-FastLive",
				description: "Fast live child",
				fastMode: true,
			}),
		);
		const finalText = await renderResult({
			...makeCompletedSubResult("3-FastFinal", "Fast final child"),
			fastMode: true,
		});

		expect(liveText).toContain(`Fast live child ${theme.icon.fast}`);
		expect(finalText).toContain(`Fast final child ${theme.icon.fast}`);
	});

	it("renders owner-worktree recovery patch receipts", async () => {
		const text = await renderResult({
			...makeCompletedSubResult("4-Recovery", "Recovery child"),
			status: "merge_failed",
			persistence: {
				outcome: "recovery_available",
				ownerWorktreeApplied: false,
				recoveryRef: {
					uri: `local://subagents/${"x".repeat(120)}\t\u0000.patch`,
					sizeBytes: 256,
					sha256: "c".repeat(64),
					durability: "session",
				},
			},
		});

		expect(text).toContain("Unapplied recovery patch: local://subagents/");
		expect(text).not.toContain("\t");
		expect(text).not.toContain("\u0000");
		expect(text).not.toContain("x".repeat(100));
	});

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

	it("keeps completed and running siblings visible in mixed root and nested snapshots", async () => {
		const completed = makeCompletedSubResult("2-Mixed.0-Done", "Completed sibling remains visible");
		const running = makeRunningSubProgress("2-Mixed.1-Live", "Running sibling remains visible");
		const theme = (await getThemeByName("red-claw"))!;
		const rootComponent = taskToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "Running mixed task" }],
				details: {
					projectAgentsDir: null,
					results: [completed],
					totalDurationMs: completed.durationMs,
					progress: [running],
				},
			},
			{ expanded: false, isPartial: true, spinnerFrame: 0 },
			theme,
		);
		const rootText = Bun.stripANSI(rootComponent.render(160).join("\n"));
		expect(rootText).toContain("Completed sibling remains visible");
		expect(rootText).toContain("Running sibling remains visible");
		expect(rootText.indexOf("Completed sibling remains visible")).toBeLessThan(
			rootText.indexOf("Running sibling remains visible"),
		);

		const nestedText = await render(
			makeRunningProgress({
				id: "2-Mixed",
				currentTool: "task",
				inflightTaskDetails: {
					projectAgentsDir: null,
					results: [completed],
					totalDurationMs: completed.durationMs,
					progress: [running],
				},
			}),
		);
		expect(nestedText).toContain("Completed sibling remains visible");
		expect(nestedText).toContain("Running sibling remains visible");
		expect(nestedText.indexOf("Completed sibling remains visible")).toBeLessThan(
			nestedText.indexOf("Running sibling remains visible"),
		);
	});

	it("ignores malformed progress entries while grouping valid retry siblings", () => {
		const retrying = (id: string): AgentProgress => ({
			...makeRunningSubProgress(id, id),
			retryState: {
				attempt: 1,
				maxAttempts: 3,
				kind: "provider_error",
				provider: "anthropic",
				delayMs: 1_000,
				errorMessage: "provider unavailable",
				startedAtMs: 0,
			},
		});
		const groups = collectProviderDegradationGroups([
			null,
			retrying("2-Guard.0-First"),
			retrying("2-Guard.1-Second"),
		] as unknown as AgentProgress[]);
		expect(groups).toEqual([{ provider: "anthropic", count: 2 }]);
	});

	it("aggregates nested same-provider retries and refreshes their age without content mutation", async () => {
		const retryingChild = (id: string): AgentProgress => ({
			...makeRunningSubProgress(id, `${id} retrying`),
			retryState: {
				attempt: 2,
				maxAttempts: 4,
				kind: "idle_stream_stall",
				provider: "anthropic",
				lastProviderProgressAtMs: 0,
				delayMs: 60_000,
				errorMessage: "Anthropic stream stalled while waiting for the next event",
				startedAtMs: 0,
			},
		});
		const parent = makeRunningProgress({
			id: "2-NestedRetryParent",
			currentTool: "task",
			inflightTaskDetails: {
				projectAgentsDir: null,
				results: [],
				totalDurationMs: 0,
				progress: [retryingChild("2-NestedRetryParent.0-Alpha"), retryingChild("2-NestedRetryParent.1-Beta")],
			},
		});
		const theme = (await getThemeByName("red-claw"))!;
		const component = taskToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "Running 1 agents..." }],
				details: {
					projectAgentsDir: null,
					results: [],
					totalDurationMs: 0,
					progress: [parent],
				} satisfies TaskToolDetails,
			},
			{ expanded: false, isPartial: true, spinnerFrame: 0 },
			theme,
		);
		const originalNow = Date.now;
		try {
			Date.now = () => 20_000;
			const first = Bun.stripANSI(component.render(160).join("\n"));
			Date.now = () => 35_000;
			const second = Bun.stripANSI(component.render(160).join("\n"));

			const notice = "provider degraded: 2 subagents retrying on anthropic";
			expect(first).toContain(notice);
			expect(first.split(notice).length - 1).toBe(1);
			expect(first).toContain("last provider progress 20s ago");
			expect(second).toContain("last provider progress 35s ago");
			expect(second).not.toEqual(first);
		} finally {
			Date.now = originalNow;
		}
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
	it("renders a terminal setup failure in live progress", async () => {
		const text = await render(
			makeRunningProgress({
				id: "3-SetupFailure",
				status: "failed",
				setupFailure: { summary: "Credential bootstrap rejected." },
			}),
		);

		expect(text).toContain("Setup failure: Credential bootstrap rejected.");
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
	it("aggregates direct retry siblings once per owning list without hiding healthy or separate nested work", async () => {
		const retry = (id: string): AgentProgress => ({
			...makeRunningSubProgress(id, `${id}\tretrying`),
			retryState: {
				attempt: 1,
				maxAttempts: 3,
				kind: "idle_stream_stall",
				provider: "anthropic",
				lastProviderProgressAtMs: 0,
				delayMs: 60_000,
				errorMessage: `stream\tstalled ${"x".repeat(120)}`,
				startedAtMs: 0,
			},
		});
		const healthy = makeRunningSubProgress("5-Parent.2-Healthy", "Healthy child remains visible");
		const parent = makeRunningProgress({
			id: "5-Parent",
			currentTool: "task",
			inflightTaskDetails: {
				projectAgentsDir: null,
				results: [],
				totalDurationMs: 0,
				progress: [retry("5-Parent.0-First"), retry("5-Parent.1-Second"), healthy],
			},
			extractedToolData: {
				task: [
					{ projectAgentsDir: null, results: [], totalDurationMs: 0, progress: [retry("5-Elsewhere.0-Only")] },
				],
			},
		});
		const theme = (await getThemeByName("red-claw"))!;
		const component = taskToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "Running" }],
				details: { projectAgentsDir: null, results: [], totalDurationMs: 0, progress: [parent] },
			},
			{ expanded: true, isPartial: true, spinnerFrame: 0 },
			theme,
		);
		const originalNow = Date.now;
		try {
			Date.now = () => 20_000;
			const first = Bun.stripANSI(component.render(160).join("\n"));
			Date.now = () => 35_000;
			const second = Bun.stripANSI(component.render(160).join("\n"));
			const notice = "provider degraded: 2 subagents retrying on anthropic";
			expect(first.split(notice).length - 1).toBe(1);
			expect(first).toContain("Healthy child remains visible");
			expect(first.indexOf("5.0 Parent>First")).toBeLessThan(first.indexOf("Healthy child remains visible"));
			expect(first).toContain("last provider progress 20s ago");
			expect(second).toContain("last provider progress 35s ago");
			expect(first).not.toContain("\t");
			expect(component.render(40).every(line => Bun.stringWidth(Bun.stripANSI(line)) <= 40)).toBe(true);
		} finally {
			Date.now = originalNow;
		}
	});
});
