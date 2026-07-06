import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { Theme } from "../../src/modes/theme/theme";
import { getThemeByName, setThemeInstance } from "../../src/modes/theme/theme";
import type { AgentProgress } from "../../src/task/types";
import type { SubagentSnapshot, SubagentToolDetails } from "../../src/tools/subagent";
import { subagentBodyCacheTestHooks, subagentToolRenderer } from "../../src/tools/subagent-render";

let theme: Theme;

beforeAll(async () => {
	theme = (await getThemeByName("red-claw"))!;
	expect(theme).toBeDefined();
	setThemeInstance(theme);
});

function progress(overrides: Partial<AgentProgress> & Pick<AgentProgress, "id">): AgentProgress {
	return {
		index: 0,
		agent: "executor",
		agentSource: "bundled",
		status: "running",
		task: "assignment",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		...overrides,
	};
}

function snapshot(overrides: Partial<SubagentSnapshot> & Pick<SubagentSnapshot, "id">): SubagentSnapshot {
	return {
		jobId: overrides.id,
		status: "running",
		label: "subagent",
		agent: "executor",
		agentSource: "bundled",
		durationMs: 0,
		...overrides,
	};
}

function render(details: SubagentToolDetails, expanded = true): string {
	const component = subagentToolRenderer.renderResult(
		{ content: [{ type: "text", text: "" }], details },
		{ expanded, isPartial: true, spinnerFrame: 0 },
		theme,
	);
	return Bun.stripANSI(component.render(160).join("\n"));
}

describe("subagentToolRenderer", () => {
	it("renders live progress (current tool + recent output) when present", () => {
		const out = render({
			subagents: [
				snapshot({
					id: "0-Live",
					liveProgressAvailable: true,
					progress: progress({ id: "0-Live", currentTool: "read", recentOutput: ["scanning the repo"] }),
				}),
			],
		});
		expect(out).toContain("read");
		expect(out).toContain("scanning the repo");
	});

	it("expands live recent output, tool args, and the full task section when expanded=true and collapses them back (AC1/AC2)", () => {
		const details: SubagentToolDetails = {
			subagents: [
				snapshot({
					id: "0-Toggle",
					liveProgressAvailable: true,
					progress: progress({
						id: "0-Toggle",
						currentTool: "bash",
						currentToolArgs: "bun test --watch",
						// First line is wider than the 40-col collapsed header preview,
						// so the second line can only surface via the expand-gated
						// Task section (renderTaskSection).
						task: "Refactor the authentication module across services\nMigrate sessions to JWT with rotating refresh tokens",
						recentOutput: ["compiling workspace", "running unit tests"],
					}),
				}),
			],
		};

		const expanded = render(details, true);
		expect(expanded).toContain("bash");
		expect(expanded).toContain("bun test --watch");
		expect(expanded).toContain("compiling workspace");
		expect(expanded).toContain("running unit tests");
		expect(expanded).toContain("Migrate sessions to JWT with rotating refresh tokens");

		const collapsed = render(details, false);
		expect(collapsed).toContain("bash");
		// Truncated task title stays visible in the collapsed header line.
		expect(collapsed).toContain("Refactor the authentication");
		// The expand-gated Task section and recent output must not leak.
		expect(collapsed).not.toContain("Migrate sessions to JWT");
		expect(collapsed).not.toContain("compiling workspace");
		expect(collapsed).not.toContain("running unit tests");
	});

	it("degrades to a static snapshot when liveProgressAvailable=false despite retained progress (AC5 defense in depth)", () => {
		const out = render({
			subagents: [
				snapshot({
					id: "0-Stale",
					status: "running",
					liveProgressAvailable: false,
					progress: progress({ id: "0-Stale", currentTool: "edit", recentOutput: ["stale output line"] }),
				}),
			],
		});
		expect(out).toContain("0-Stale");
		expect(out).not.toContain("edit");
		expect(out).not.toContain("stale output line");
		expect(out).not.toContain("running, no activity yet");
	});

	it("shows the ctrl+s observe hint under the header while any subagent is running, in both expand states (AC3)", () => {
		const details: SubagentToolDetails = {
			subagents: [
				snapshot({ id: "0-Run", status: "running", liveProgressAvailable: true }),
				snapshot({ id: "0-Done", status: "completed", resultText: "done" }),
			],
		};
		for (const expanded of [true, false]) {
			const out = render(details, expanded);
			const lines = out.split("\n");
			expect(lines[1]).toContain("(ctrl+s to observe sessions)");
		}
	});

	it("treats queued subagents as awaited active work in the aggregate header", () => {
		const out = render(
			{
				subagents: [snapshot({ id: "0-Queued", status: "queued", liveProgressAvailable: true })],
			},
			false,
		);
		const lines = out.split("\n");
		expect(lines[0]).toContain("awaiting 1 of 1");
		expect(lines[1]).toContain("(ctrl+s to observe sessions)");
		expect(out).toContain("running, no activity yet");
	});

	it("omits the ctrl+s observe hint when no subagent is running (AC4)", () => {
		const out = render({
			subagents: [
				snapshot({ id: "0-Done", status: "completed", resultText: "done" }),
				snapshot({ id: "0-Fail", status: "failed", errorText: "boom" }),
			],
		});
		expect(out).not.toContain("ctrl+s");
	});

	it("uses digest-sized result previews when collapsed and agent-card-sized previews when expanded (AC2)", () => {
		const details: SubagentToolDetails = {
			subagents: [
				snapshot({
					id: "0-Preview",
					status: "completed",
					resultText:
						"line one\nline two\nline three\nline four\nline five\nline six\nline seven\nline eight\nline nine\nline ten\nline eleven\nline twelve\nline thirteen",
				}),
			],
		};

		const collapsed = render(details, false);
		expect(collapsed).toContain("Result:");
		expect(collapsed).toContain("line one");
		expect(collapsed).toContain("line three");
		expect(collapsed).not.toContain("line four");

		const expanded = render(details, true);
		expect(expanded).toContain("line one");
		expect(expanded).toContain("line twelve");
		expect(expanded).not.toContain("line thirteen");
	});

	it("turns task-summary XML into user-facing findings instead of showing wrapper tags", () => {
		const out = render(
			{
				subagents: [
					snapshot({
						id: "0-Panel",
						status: "completed",
						resultText: `<task-summary>
<header>3/3 succeeded [2m13s]</header>

<agent id="ResearcherLens" agent="architect">
<status>completed</status>
<synopsis>
Supabase/static-site boundary needs confirmation before the next round.
</synopsis>
</agent>
</task-summary>`,
					}),
				],
			},
			false,
		);

		expect(out).toContain("Findings:");
		expect(out).toContain("Outcome: 3/3 succeeded [2m13s]");
		expect(out).toContain("ResearcherLens: Supabase/static-site boundary needs confirmation");
		expect(out).not.toContain("<task-summary>");
		expect(out).not.toContain("<header>");
	});

	it("fails closed for wrapper-only task-summary payloads in both digest and agent-card stages", () => {
		const details: SubagentToolDetails = {
			subagents: [
				snapshot({
					id: "0-EmptySummary",
					status: "completed",
					resultText: "<task-summary>\n</task-summary>",
				}),
			],
		};

		for (const expanded of [false, true]) {
			const out = render(details, expanded);
			expect(out).toContain("Findings:");
			expect(out).toContain("Task summary produced no previewable findings.");
			expect(out).not.toContain("<task-summary>");
		}
	});

	it("renders merge-summary findings and decodes XML entities", () => {
		const out = render(
			{
				subagents: [
					snapshot({
						id: "0-MergeSummary",
						status: "completed",
						resultText: `<task-summary>
<header>1/1 succeeded &amp; checked</header>
<merge-summary>
Verdict &quot;usable&quot; for Array&lt;string&gt; &amp; ready.
</merge-summary>
</task-summary>`,
					}),
				],
			},
			false,
		);

		expect(out).toContain("Outcome: 1/1 succeeded & checked");
		expect(out).toContain('Merged: Verdict "usable" for Array<string> & ready.');
		expect(out).not.toContain("<merge-summary>");
	});

	it("renders the placeholder when a live producer exists but no progress yet", () => {
		const out = render({
			subagents: [snapshot({ id: "0-Pending", status: "running", liveProgressAvailable: true })],
		});
		expect(out).toContain("running, no activity yet");
	});

	it("renders static status without a no-activity claim when no live producer", () => {
		const out = render({
			subagents: [snapshot({ id: "0-Static", status: "running", liveProgressAvailable: false })],
		});
		expect(out).toContain("0-Static");
		expect(out).not.toContain("running, no activity yet");
	});

	it("stacks multiple awaited subagents", () => {
		const out = render({
			subagents: [
				snapshot({
					id: "0-A",
					liveProgressAvailable: true,
					progress: progress({ id: "0-A", currentTool: "read" }),
				}),
				snapshot({
					id: "0-B",
					liveProgressAvailable: true,
					progress: progress({ id: "0-B", currentTool: "bash" }),
				}),
			],
		});
		expect(out).toContain("read");
		expect(out).toContain("bash");
	});

	it("preserves static receipt fields for non-await actions (guidance, output ref, description, agent, assignment, truncation)", () => {
		const out = render({
			subagents: [
				snapshot({
					id: "0-Done",
					jobId: "job-done",
					status: "completed",
					agent: "executor",
					description: "did the thing",
					assignment: "Do the work carefully.",
					outputRef: "agent://0-Done",
					resultText: "final answer",
					truncated: true,
					guidance: "This subagent is terminal. Provide `message` to start a follow-up resume run.",
				}),
			],
		});
		expect(out).toContain("job-done");
		expect(out).toContain("Agent: executor");
		expect(out).toContain("did the thing");
		expect(out).toContain("Assignment:");
		expect(out).toContain("Do the work carefully.");
		expect(out).toContain("agent://0-Done");
		expect(out).toContain("final answer");
		expect(out).toContain("Preview truncated");
		expect(out).toContain("terminal");
	});

	it("keeps collapsed subagent panels focused on digest content instead of metadata", () => {
		const details: SubagentToolDetails = {
			subagents: [
				snapshot({
					id: "0-Done",
					jobId: "job-done",
					status: "completed",
					agent: "executor",
					description: "did the thing",
					assignment: "Do the work carefully.\nInclude extra details.",
					outputRef: "agent://0-Done",
					resultText: "final answer",
					effectiveModel: "anthropic/claude-opus-4-8",
				}),
			],
		};

		const collapsed = render(details, false);
		expect(collapsed).toContain("final answer");
		expect(collapsed).not.toContain("Job: job-done");
		expect(collapsed).not.toContain("Agent: executor");
		expect(collapsed).not.toContain("Model: anthropic/claude-opus-4-8");
		expect(collapsed).not.toContain("Assignment:");
		expect(collapsed).not.toContain("agent://0-Done");

		const expanded = render(details, true);
		expect(expanded).toContain("Job: job-done");
		expect(expanded).toContain("Agent: executor");
		expect(expanded).toContain("Model: anthropic/claude-opus-4-8");
		expect(expanded).toContain("Focus: did the thing");
		expect(expanded).toContain("Assignment:");
		expect(expanded).toContain("agent://0-Done");
	});

	it("keeps failed subagent previews error-first while preserving two-stage log disclosure", () => {
		const details: SubagentToolDetails = {
			subagents: [
				snapshot({
					id: "0-Fail",
					status: "failed",
					errorText: "boom\nstack line",
					resultText: "should not render",
					outputRef: "agent://0-Fail",
					truncated: true,
				}),
			],
		};

		const collapsed = render(details, false);
		expect(collapsed).toContain("Error:");
		expect(collapsed).toContain("boom");
		expect(collapsed).toContain("stack line");
		expect(collapsed).not.toContain("should not render");
		expect(collapsed).not.toContain("agent://0-Fail");

		const expanded = render(details, true);
		expect(expanded).toContain("Error:");
		expect(expanded).toContain("Log: agent://0-Fail");
		expect(expanded).toContain("Preview truncated");
	});

	it("intentionally suppresses an unknown agent line (no noisy 'Agent: unknown')", () => {
		const out = render({
			subagents: [
				snapshot({
					id: "0-Missing",
					status: "not_found",
					agent: "unknown",
					guidance: "No visible detached subagent matches this id.",
				}),
			],
		});
		expect(out).not.toContain("Agent: unknown");
		expect(out).toContain("No visible detached subagent");
	});

	it("does not throw on empty subagents", () => {
		const out = render({ subagents: [] });
		expect(out).toContain("No subagents");
	});

	it("renders the effective model for a subagent", () => {
		const out = render({
			subagents: [snapshot({ id: "0-Codex", effectiveModel: "openai-codex/gpt-5.5" })],
		});
		expect(out).toContain("Model: openai-codex/gpt-5.5");
		expect(out).not.toContain("fell back");
	});

	it("flags an auth fallback with the requested vs effective model", () => {
		const out = render({
			subagents: [
				snapshot({
					id: "0-Fallback",
					effectiveModel: "anthropic/claude-opus-4-8",
					requestedModel: "openai-codex/gpt-5.5",
					modelFellBack: true,
				}),
			],
		});
		expect(out).toContain("Model: anthropic/claude-opus-4-8");
		expect(out).toContain("requested openai-codex/gpt-5.5");
		expect(out).toContain("fell back");
	});
});

describe("subagent await renderer body cache (PR2)", () => {
	beforeEach(() => {
		subagentBodyCacheTestHooks.reset();
	});

	const renderWith = (
		details: SubagentToolDetails,
		{
			expanded = true,
			width = 160,
			spinnerFrame = 0,
		}: { expanded?: boolean; width?: number; spinnerFrame?: number } = {},
	): string[] => {
		// A fresh component each call models the built-in renderer recreating the
		// result component on every partial update.
		const component = subagentToolRenderer.renderResult(
			{ content: [{ type: "text", text: "" }], details },
			{ expanded, isPartial: true, spinnerFrame },
			theme,
		);
		return component.render(width);
	};

	const live = (id: string, overrides: Partial<AgentProgress> = {}): SubagentToolDetails => ({
		subagents: [
			snapshot({
				id,
				liveProgressAvailable: true,
				progress: progress({ id, currentTool: "read", recentOutput: ["scan"], ...overrides }),
			}),
		],
	});

	it("reuses the cached heavy body across component recreation for identical content", () => {
		renderWith(live("0-A"));
		expect(subagentBodyCacheTestHooks.bodyRenders).toBe(1);
		// New component (new renderResult), identical content -> module cache hit.
		renderWith(live("0-A"));
		expect(subagentBodyCacheTestHooks.bodyRenders).toBe(1);
	});

	it("does not re-render the heavy body for spinner-only frame changes", () => {
		const details = live("0-A");
		renderWith(details, { spinnerFrame: 0 });
		expect(subagentBodyCacheTestHooks.bodyRenders).toBe(1);
		renderWith(details, { spinnerFrame: 1 });
		renderWith(details, { spinnerFrame: 2 });
		expect(subagentBodyCacheTestHooks.bodyRenders).toBe(1);
	});

	it("re-renders the heavy body when content, width, or expanded changes", () => {
		renderWith(live("0-A", { currentTool: "read" }));
		expect(subagentBodyCacheTestHooks.bodyRenders).toBe(1);
		// Content change.
		renderWith(live("0-A", { currentTool: "bash" }));
		expect(subagentBodyCacheTestHooks.bodyRenders).toBe(2);
		// Width change.
		renderWith(live("0-A", { currentTool: "read" }), { width: 100 });
		expect(subagentBodyCacheTestHooks.bodyRenders).toBe(3);
		// Expanded change.
		renderWith(live("0-A", { currentTool: "read" }), { expanded: false });
		expect(subagentBodyCacheTestHooks.bodyRenders).toBe(4);
		// Back to the first key -> cache hit, no new render.
		renderWith(live("0-A", { currentTool: "read" }));
		expect(subagentBodyCacheTestHooks.bodyRenders).toBe(4);
	});

	it("re-renders the heavy body when terminal result metadata changes", () => {
		const first: SubagentToolDetails = {
			subagents: [snapshot({ id: "0-Terminal", status: "completed", resultText: "first result" })],
		};
		const second: SubagentToolDetails = {
			subagents: [snapshot({ id: "0-Terminal", status: "completed", resultText: "second result" })],
		};
		renderWith(first);
		expect(subagentBodyCacheTestHooks.bodyRenders).toBe(1);
		renderWith(second);
		expect(subagentBodyCacheTestHooks.bodyRenders).toBe(2);
		renderWith(first);
		expect(subagentBodyCacheTestHooks.bodyRenders).toBe(2);
	});

	it("ignores time-only churn in the body cache key", () => {
		const a: SubagentToolDetails = {
			subagents: [
				snapshot({
					id: "0-A",
					durationMs: 1_000,
					liveProgressAvailable: true,
					progress: progress({ id: "0-A", durationMs: 1_000, currentTool: "read", currentToolStartMs: 1_000 }),
				}),
			],
		};
		const b: SubagentToolDetails = {
			subagents: [
				snapshot({
					id: "0-A",
					durationMs: 999_999,
					liveProgressAvailable: true,
					progress: progress({ id: "0-A", durationMs: 999_999, currentTool: "read", currentToolStartMs: 2_000 }),
				}),
			],
		};
		renderWith(a);
		expect(subagentBodyCacheTestHooks.bodyRenders).toBe(1);
		// Only time-derived fields differ -> identical signature -> cache hit.
		renderWith(b);
		expect(subagentBodyCacheTestHooks.bodyRenders).toBe(1);
	});

	it("invalidates the body cache when the Theme instance changes (no stale ANSI)", async () => {
		const altTheme = (await getThemeByName("blue-crab"))!;
		expect(altTheme).toBeDefined();
		const details = live("0-A");
		const renderTheme = (t: Theme): string[] =>
			subagentToolRenderer
				.renderResult(
					{ content: [{ type: "text", text: "" }], details },
					{ expanded: true, isPartial: true, spinnerFrame: 0 },
					t,
				)
				.render(160);

		const first = renderTheme(theme);
		expect(subagentBodyCacheTestHooks.bodyRenders).toBe(1);
		// A different Theme instance (distinct object) must re-render the body, even if
		// the theme name is unchanged — guards against stale themed ANSI/glyph reuse.
		const second = renderTheme(altTheme);
		expect(subagentBodyCacheTestHooks.bodyRenders).toBe(2);
		expect(second).not.toEqual(first);
	});

	it("bounds the cache via LRU eviction", () => {
		for (let i = 0; i < 140; i++) {
			renderWith(live(`0-${i}`, { currentTool: `tool-${i}` }));
		}
		expect(subagentBodyCacheTestHooks.bodyRenders).toBe(140);
		expect(subagentBodyCacheTestHooks.size).toBeLessThanOrEqual(128);
	});
});
