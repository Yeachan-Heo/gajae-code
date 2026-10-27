import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "../../src/config/settings";
import type { Theme } from "../../src/modes/theme/theme";
import { getThemeByName, setThemeInstance } from "../../src/modes/theme/theme";
import type { AgentProgress } from "../../src/task/types";
import {
	type SubagentLiveProgress,
	type SubagentSnapshot,
	type SubagentToolDetails,
	subagentCompactRenderedStateSignature,
} from "../../src/tools/subagent";
import {
	subagentAwaitRenderedStateSignature,
	subagentBodyCacheTestHooks,
	subagentToolRenderer,
} from "../../src/tools/subagent-render";

let theme: Theme;

beforeAll(async () => {
	theme = (await getThemeByName("red-claw"))!;
	expect(theme).toBeDefined();
	setThemeInstance(theme);
});

function progress(overrides: Partial<AgentProgress> & Pick<AgentProgress, "id">): SubagentLiveProgress {
	const retryState = overrides.retryState;
	return {
		id: overrides.id,
		status: overrides.status ?? "running",
		...(overrides.currentTool ? { currentTool: overrides.currentTool } : {}),
		...(overrides.currentTool === undefined && overrides.recentTools?.[0]
			? { recentTool: overrides.recentTools[0].tool }
			: {}),
		...(overrides.recentOutput && overrides.recentOutput.length > 0
			? { recentOutputSummary: { lineCount: Math.min(overrides.recentOutput.length, 6) } }
			: {}),
		...(overrides.toolCount ? { toolCount: overrides.toolCount } : {}),
		...(overrides.contextTokens ? { contextTokens: overrides.contextTokens } : {}),
		...(overrides.contextWindow ? { contextWindow: overrides.contextWindow } : {}),
		...(overrides.lastActivityMs !== undefined ? { lastActivityMs: overrides.lastActivityMs } : {}),
		...(overrides.fastMode ? { fastMode: true } : {}),
		...(retryState
			? {
					retryState: {
						attempt: retryState.attempt,
						maxAttempts: retryState.maxAttempts,
						...(retryState.unbounded ? { unbounded: true } : {}),
						kind: retryState.kind,
						...(retryState.provider ? { provider: retryState.provider } : {}),
						...(retryState.lastProviderProgressAtMs !== undefined
							? { lastProviderProgressAtMs: retryState.lastProviderProgressAtMs }
							: {}),
						delayMs: retryState.delayMs,
						startedAtMs: retryState.startedAtMs,
					},
				}
			: {}),
		...(overrides.retryFailure ? { retryFailure: { attempt: overrides.retryFailure.attempt } } : {}),
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
		expect(out).toContain("recent output available (1 line)");
	});
	it("quantizes last-activity age on the producer cadence", () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(20_000);
		try {
			const details: SubagentToolDetails = {
				subagents: [
					snapshot({
						id: "0-Stats",
						liveProgressAvailable: true,
						progress: progress({
							id: "0-Stats",
							currentTool: "read",
							toolCount: 12,
							contextTokens: 48_000,
							contextWindow: 200_000,
							lastActivityMs: 13_000,
						}),
					}),
				],
			};
			const first = render(details);
			expect(first).toContain("12 tools");
			expect(first).toContain("48K/200K ctx");
			expect(first).toMatch(/last activity 5(?:\.0)?s ago/);

			// Re-rendering the same snapshot inside one age bucket must not mutate its row.
			now.mockReturnValue(22_999);
			expect(render(details)).toBe(first);

			now.mockReturnValue(23_000);
			expect(render(details)).toMatch(/last activity 10(?:\.0)?s ago/);
		} finally {
			now.mockRestore();
		}
	});

	it("omits live stats when the live producer is gone", () => {
		const out = render({
			subagents: [
				snapshot({
					id: "0-Gone",
					liveProgressAvailable: false,
					progress: progress({ id: "0-Gone", toolCount: 3, contextTokens: 9_000, lastActivityMs: 1 }),
				}),
			],
		});
		expect(out).not.toContain("3 tools");
		expect(out).not.toContain("ctx");
		expect(out).not.toContain("last activity");
	});

	it("renders the fast glyph on the model line only when fast mode is enabled", () => {
		const out = render({
			subagents: [
				snapshot({
					id: "0-LiveFast",
					fastMode: true,
					effectiveModel: "openai-codex/gpt-5.6-sol",
					liveProgressAvailable: true,
				}),
				snapshot({
					id: "0-TerminalFast",
					status: "completed",
					fastMode: true,
					effectiveModel: "openai-codex/gpt-5.6-sol",
					resultText: "done",
				}),
				snapshot({
					id: "0-TerminalNormal",
					status: "completed",
					effectiveModel: "anthropic/claude-sonnet-4-5",
					resultText: "done",
				}),
			],
		});
		// The glyph rides the model line, never the id.
		expect(out).toContain(`Model: openai-codex/gpt-5.6-sol ${theme.icon.fast}`);
		expect(out).not.toContain(`0-LiveFast ${theme.icon.fast}`);
		expect(out).not.toContain(`0-TerminalFast ${theme.icon.fast}`);
		expect(out).toContain("Model: anthropic/claude-sonnet-4-5");
		expect(out).not.toContain(`Model: anthropic/claude-sonnet-4-5 ${theme.icon.fast}`);
	});

	it("renders only the approved current-tool and recent-output summary", () => {
		const details: SubagentToolDetails = {
			subagents: [
				snapshot({
					id: "0-Toggle",
					liveProgressAvailable: true,
					progress: progress({
						id: "0-Toggle",
						currentTool: "bash",
						recentOutput: ["compiling workspace", "running unit tests"],
					}),
				}),
			],
		};

		const expanded = render(details, true);
		expect(expanded).toContain("bash");
		expect(expanded).toContain("recent output available (2 lines)");
		expect(expanded).not.toContain("compiling workspace");
		expect(expanded).not.toContain("running unit tests");

		const collapsed = render(details, false);
		expect(collapsed).toContain("bash");
		expect(collapsed).toContain("recent output available (2 lines)");
		// Raw tool output and arguments never cross the approved DTO boundary.
		expect(collapsed).not.toContain("bun test --watch");
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
		expect(out).not.toContain("running, no approved activity summary yet");
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

	it("omits the ctrl+s observe hint when no subagent is running (AC4)", () => {
		const out = render({
			subagents: [
				snapshot({ id: "0-Done", status: "completed", resultText: "done" }),
				snapshot({ id: "0-Fail", status: "failed", errorText: "boom" }),
			],
		});
		expect(out).not.toContain("ctrl+s");
	});

	it("renders a failed aggregate await as an error", () => {
		const out = render({
			subagents: [snapshot({ id: "0-Fail", status: "failed", errorText: "stream stalled" })],
		});
		expect(out).toContain("Subagent failed");
		expect(out).toContain("1 subagent failed");
	});

	it("caps the result preview at one line collapsed and at four lines expanded (AC2)", () => {
		const details: SubagentToolDetails = {
			subagents: [
				snapshot({
					id: "0-Preview",
					status: "completed",
					resultText: "line one\nline two\nline three\nline four\nline five",
				}),
			],
		};

		const collapsed = render(details, false);
		expect(collapsed).toContain("line one");
		expect(collapsed).not.toContain("line two");

		const expanded = render(details, true);
		expect(expanded).toContain("line one");
		expect(expanded).toContain("line four");
		// PREVIEW_LINES_EXPANDED=4 is an upper bound, not a minimum.
		expect(expanded).not.toContain("line five");
	});

	it("renders the placeholder when a live producer exists but no progress yet", () => {
		const out = render({
			subagents: [snapshot({ id: "0-Pending", status: "running", liveProgressAvailable: true })],
		});
		expect(out).toContain("running, no approved activity summary yet");
	});

	it("renders static status without a no-activity claim when no live producer", () => {
		const out = render({
			subagents: [snapshot({ id: "0-Static", status: "running", liveProgressAvailable: false })],
		});
		expect(out).toContain("0-Static");
		expect(out).not.toContain("running, no approved activity summary yet");
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

	it("distinguishes first-event timeout recovery from normal running", () => {
		const out = render({
			subagents: [
				snapshot({
					id: "0-FirstEvent",
					liveProgressAvailable: true,
					progress: progress({
						id: "0-FirstEvent",
						retryState: {
							attempt: 2,
							maxAttempts: 4,
							kind: "first_event_timeout",
							provider: "openai-responses",
							delayMs: 5_000,
							errorMessage: "OpenAI responses stream timed out while waiting for the first event",
							startedAtMs: Date.now(),
						},
					}),
				}),
			],
		});

		expect(out).toContain("provider degraded");
		expect(out).toContain("first event timeout");
		expect(out).toContain("no provider events yet");
		expect(out).toContain("retrying attempt 2 of 4, bounded");
	});

	it("shows idle-stream progress age and aggregates same-provider degradation", () => {
		const lastProviderProgressAtMs = Date.now() - 12_000;
		const retryState = {
			attempt: 1,
			maxAttempts: 3,
			kind: "idle_stream_stall" as const,
			provider: "anthropic",
			lastProviderProgressAtMs,
			delayMs: 10_000,
			errorMessage: "Anthropic stream stalled while waiting for the next event",
			startedAtMs: Date.now(),
		};
		const out = render({
			subagents: [
				snapshot({
					id: "0-StalledA",
					liveProgressAvailable: true,
					progress: progress({ id: "0-StalledA", retryState }),
				}),
				snapshot({
					id: "0-StalledB",
					liveProgressAvailable: true,
					progress: progress({ id: "0-StalledB", retryState }),
				}),
			],
		});

		expect(out).toContain("provider degraded: 2 subagents retrying on anthropic");
		expect(out).toContain("stream stalled");
		expect(out).toMatch(/last provider progress 1[12]s ago/);
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

describe("interrupted await receipts", () => {
	it("renders the interruption state and bounded sanitized active guidance", () => {
		const unsafeGuidance = `Inspect\t${"x".repeat(400)}`;
		const details: SubagentToolDetails = {
			interrupted: true,
			awaitOutcome: "interrupted",
			subagents: [
				snapshot({ id: "0-Running\tUnsafe", status: "running", guidance: unsafeGuidance }),
				snapshot({ id: "0-Terminal", status: "completed" }),
			],
		};
		const out = render(details);

		expect(out).toContain("Subagent await interrupted");
		expect(out).toContain("child subagents continue");
		expect(out).toMatch(/0-Running\s+Unsafe/);
		expect(out).not.toContain("\t");
		expect(out).not.toContain("x".repeat(200));
		expect(out).not.toContain("0-Terminal\n  Inspect");
	});

	it("wraps await-timeout guidance to the terminal width instead of cutting it to one line", () => {
		const guidance =
			"Still running after the await timeout; timeout only bounded this wait and is not a failure. Inspect progress, continue independent work, and never cancel just because an await timed out; cancel only if the subagent has actually failed, gone off-track, or become unrecoverably wrong.";
		for (const width of [60, 80]) {
			const component = subagentToolRenderer.renderResult(
				{
					content: [{ type: "text", text: "" }],
					details: {
						awaitOutcome: "timed_out",
						subagents: [snapshot({ id: "0-Slow", status: "running", guidance })],
					},
				},
				{ expanded: false, isPartial: false, spinnerFrame: 0 },
				theme,
			);
			const lines = component.render(width).map(line => Bun.stripANSI(line));
			for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
			const text = lines.join(" ").replace(/\s+/g, " ");
			expect(text).toContain("Inspect progress");
			expect(text).toContain("never cancel just because an await timed out");
			expect(text).toContain("unrecoverably wrong.");
		}
	});

	it("never exceeds the terminal width with guidance on very narrow terminals", () => {
		for (const width of [0, 1, 2, 3]) {
			const component = subagentToolRenderer.renderResult(
				{
					content: [{ type: "text", text: "" }],
					details: { subagents: [snapshot({ id: "0-Narrow", status: "running", guidance: "A" })] },
				},
				{ expanded: false, isPartial: false, spinnerFrame: 0 },
				theme,
			);
			for (const line of component.render(width))
				expect(Bun.stringWidth(Bun.stripANSI(line))).toBeLessThanOrEqual(width);
		}
	});

	it("keeps pathological guidance bounded", () => {
		const component = subagentToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "" }],
				details: { subagents: [snapshot({ id: "0-Long", status: "running", guidance: "word ".repeat(400) })] },
			},
			{ expanded: false, isPartial: false, spinnerFrame: 0 },
			theme,
		);
		const guidanceLines = component
			.render(40)
			.map(line => Bun.stripANSI(line))
			.filter(line => line.includes("word"));
		expect(guidanceLines).toHaveLength(12);
		expect(guidanceLines.at(-1)).toEndWith("…");
	});

	it("includes changed interruption guidance in the receipt signature and body cache key", () => {
		const active = snapshot({ id: "0-Await", guidance: "Await interrupted; inspect it." });
		const terminal = snapshot({ id: "0-Await", guidance: undefined });

		expect(subagentAwaitRenderedStateSignature([active])).not.toBe(subagentAwaitRenderedStateSignature([terminal]));
		expect(subagentAwaitRenderedStateSignature([terminal])).not.toBe(
			subagentAwaitRenderedStateSignature([terminal], { awaitOutcome: "interrupted", interrupted: true }),
		);
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

	const nestedRetry = (
		provider = "anthropic",
		_errorMessage = "Anthropic stream stalled while waiting for the next event",
	): SubagentToolDetails => ({
		subagents: ["0-Nested.0-Child", "0-Nested.1-Child"].map(id =>
			snapshot({
				id,
				liveProgressAvailable: true,
				progress: progress({
					id,
					retryState: {
						attempt: 2,
						maxAttempts: 4,
						kind: "idle_stream_stall",
						provider,
						lastProviderProgressAtMs: 0,
						delayMs: 60_000,
						errorMessage: _errorMessage,
						startedAtMs: 0,
					},
				}),
			}),
		),
	});

	it("refreshes nested retry age and countdown on await-body updates", () => {
		const details = nestedRetry();
		const originalNow = Date.now;
		try {
			Date.now = () => 20_000;
			const first = renderWith(details).join("\n");
			Date.now = () => 35_000;
			const second = renderWith(details).join("\n");

			expect(first).toContain("provider degraded: 2 subagents retrying on anthropic");
			expect(first).toContain("last provider progress 20s ago");
			expect(first).toContain("in 40.0s");
			expect(second).toContain("last provider progress 35s ago");
			expect(second).toContain("in 25.0s");
			expect(second).not.toEqual(first);
		} finally {
			Date.now = originalNow;
		}
	});

	it("bounds dynamic nested retry lines and sanitizes tabs at narrow widths", () => {
		const lines = renderWith(nestedRetry("anthropic\tproduction", `provider\terror ${"x".repeat(160)}`), {
			width: 40,
		});
		expect(lines.every(line => Bun.stringWidth(Bun.stripANSI(line)) <= 40)).toBe(true);
		expect(lines.join("\n")).not.toContain("\t");
	});

	it("keeps retry groups isolated by snapshot and bypasses only their dynamic cache entries", () => {
		const firstNested = nestedRetry();
		const secondNested = nestedRetry();
		secondNested.subagents[0] = snapshot({
			id: "0-OtherNested",
			liveProgressAvailable: true,
			progress: progress({
				id: "0-OtherNested",
				retryState: {
					attempt: 2,
					maxAttempts: 4,
					kind: "idle_stream_stall",
					provider: "anthropic",
					lastProviderProgressAtMs: 0,
					delayMs: 60_000,
					errorMessage: "provider unavailable",
					startedAtMs: 0,
				},
			}),
		});
		const combined: SubagentToolDetails = { subagents: [...firstNested.subagents, ...secondNested.subagents] };
		const healthy = live("0-Healthy");
		const originalNow = Date.now;
		try {
			Date.now = () => 20_000;
			renderWith(healthy);
			expect(subagentBodyCacheTestHooks.bodyRenders).toBe(1);
			expect(subagentBodyCacheTestHooks.size).toBe(1);
			const first = renderWith(combined).join("\n");
			Date.now = () => 35_000;
			const second = renderWith(combined).join("\n");
			const notice = "provider degraded: 4 subagents retrying on anthropic";
			expect(first.split(notice).length - 1).toBe(1);
			expect(second).toContain("last provider progress 35s ago");
			expect(subagentBodyCacheTestHooks.bodyRenders).toBe(9);
			expect(subagentBodyCacheTestHooks.size).toBe(1);
			renderWith(healthy);
			expect(subagentBodyCacheTestHooks.bodyRenders).toBe(9);
			expect(subagentBodyCacheTestHooks.size).toBe(1);
		} finally {
			Date.now = originalNow;
		}
	});

	it("does not aggregate matching retrying siblings from separate await requests", () => {
		const retryState = {
			attempt: 1,
			maxAttempts: 3,
			kind: "provider_error" as const,
			provider: "anthropic",
			delayMs: 10_000,
			errorMessage: "provider unavailable",
			startedAtMs: 0,
		};
		const request = (id: string): SubagentToolDetails => ({
			subagents: [snapshot({ id, liveProgressAvailable: true, progress: progress({ id, retryState }) })],
		});
		const notice = "provider degraded: 2 subagents retrying on anthropic";
		expect(renderWith(request("0-RequestA")).join("\n")).not.toContain(notice);
		expect(renderWith(request("0-RequestB")).join("\n")).not.toContain(notice);
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

	it("invalidates the cached body when only approved fastMode flips", () => {
		const nested = (fastMode: boolean): SubagentToolDetails => ({
			subagents: [
				snapshot({
					id: "0-Nested",
					liveProgressAvailable: true,
					progress: progress({ id: "0-Nested", currentTool: "read", fastMode }),
				}),
			],
		});

		const slow = renderWith(nested(false));
		expect(subagentBodyCacheTestHooks.bodyRenders).toBe(1);
		// Same value again is a genuine cache hit.
		renderWith(nested(false));
		expect(subagentBodyCacheTestHooks.bodyRenders).toBe(1);

		const fast = renderWith(nested(true));
		expect(subagentBodyCacheTestHooks.bodyRenders).toBe(2);
		expect(fast).not.toEqual(slow);
		expect(theme.icon.fast).toBeTruthy();
		expect(fast.join("\n")).toContain(theme.icon.fast);
		expect(slow.join("\n")).not.toContain(theme.icon.fast);
	});
});

describe("compact subagent panel (#6774)", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		subagentBodyCacheTestHooks.reset();
	});
	afterEach(() => {
		resetSettingsForTest();
	});

	function liveGroup(count: number, idle: number): SubagentSnapshot[] {
		const now = Date.now();
		return Array.from({ length: count }, (_, index) => {
			const id = `0-Worker${index}`;
			return snapshot({
				id,
				description: `worker ${index}`,
				liveProgressAvailable: true,
				progress: progress({
					id,
					currentTool: "bash",
					toolCount: index + 1,
					lastActivityMs: index < idle ? now - 45_000 : now - 1_000,
				}),
			});
		});
	}

	it("renders 15 live subagents as a constant-height summary when collapsed", () => {
		settings.set("task.compactSubagentPanel", true);
		const out = render({ subagents: liveGroup(15, 3) }, false);
		const lines = out.split("\n");
		expect(lines).toEqual([
			expect.stringContaining("awaiting 15 of 15"),
			"  15 subagents running · 3 idle >30s",
			expect.stringMatching(/^ {2}\(.* to list each · ctrl\+s to observe sessions\)$/),
		]);
		expect(out).not.toContain("0-Worker");
		// The heavy per-subagent bodies are never built in compact mode.
		expect(subagentBodyCacheTestHooks.bodyRenders).toBe(0);
	});

	it("keeps the line count independent of the number of subagents", () => {
		settings.set("task.compactSubagentPanel", true);
		const few = render({ subagents: liveGroup(2, 0) }, false).split("\n");
		const many = render({ subagents: liveGroup(40, 0) }, false).split("\n");
		expect(many.length).toBe(few.length);
	});

	it("summarizes mixed terminal states", () => {
		settings.set("task.compactSubagentPanel", true);
		const out = render(
			{
				subagents: [
					...liveGroup(1, 0),
					snapshot({ id: "0-Queued", status: "queued" }),
					snapshot({ id: "0-Done", status: "completed" }),
					snapshot({ id: "0-Failed", status: "failed" }),
					snapshot({ id: "0-Cancelled", status: "cancelled" }),
				],
			},
			false,
		);
		expect(out).toContain("1 subagent running · 1 failed · 1 queued · 1 done · 1 cancelled");
	});

	it("keeps failures visible and marks truncation on a narrow terminal", () => {
		settings.set("task.compactSubagentPanel", true);
		const component = subagentToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "" }],
				details: {
					subagents: [
						...liveGroup(9, 1),
						snapshot({ id: "0-Queued", status: "queued" }),
						snapshot({ id: "0-Paused", status: "paused" }),
						snapshot({ id: "0-Done", status: "completed" }),
						snapshot({ id: "0-Failed", status: "failed" }),
					],
				},
			},
			{ expanded: false, isPartial: true, spinnerFrame: 0 },
			theme,
		);
		const summary = Bun.stripANSI(component.render(40)[1]!);
		expect(summary).toStartWith("  9 subagents running · 1 failed");
		expect(summary).toEndWith("…");
	});

	it("keeps the full receipt, including timeout guidance, once the await result is final", () => {
		settings.set("task.compactSubagentPanel", true);
		const guidance =
			"Subagent is still running after the await timeout; never cancel just because an await timed out.";
		const subagents = liveGroup(15, 0).map(item => ({ ...item, guidance }));
		const component = subagentToolRenderer.renderResult(
			{ content: [{ type: "text", text: "" }], details: { subagents, awaitOutcome: "timed_out" } },
			{ expanded: false, isPartial: false, spinnerFrame: 0 },
			theme,
		);
		const out = Bun.stripANSI(component.render(160).join("\n"));
		expect(out).toContain("0-Worker14");
		expect(out).toContain("still running after the await timeout");
		expect(out).not.toContain("to list each");
	});

	it("keeps the provider degradation warning in the compact summary", () => {
		settings.set("task.compactSubagentPanel", true);
		const retryState = {
			attempt: 2,
			maxAttempts: 5,
			kind: "provider_error" as const,
			provider: "anthropic",
			delayMs: 10_000,
			errorMessage: "overloaded",
			startedAtMs: Date.now(),
		};
		const subagents = liveGroup(12, 0).map((item, index) =>
			index < 4 ? { ...item, progress: progress({ id: item.id, retryState }) } : item,
		);
		const lines = render({ subagents }, false).split("\n");
		expect(lines).toEqual([
			expect.stringContaining("awaiting 12 of 12"),
			"  12 subagents running · 4 retrying",
			"  provider degraded: 4 subagents retrying on anthropic",
			expect.stringContaining("to list each"),
		]);
	});

	it("caps provider degradation at one row however many providers degrade", () => {
		settings.set("task.compactSubagentPanel", true);
		const providers = ["anthropic", "openai", "google", "xai", "mistral", "groq", "deepseek"];
		const subagents = liveGroup(15, 0).map((item, index) => {
			if (index >= 14) return item;
			const retryState = {
				attempt: 1,
				maxAttempts: 3,
				kind: "provider_error" as const,
				provider: providers[index % providers.length],
				delayMs: 10_000,
				errorMessage: "overloaded",
				startedAtMs: Date.now(),
			};
			return { ...item, progress: progress({ id: item.id, retryState }) };
		});
		const lines = render({ subagents }, false).split("\n");
		expect(lines).toHaveLength(4);
		expect(lines[2]).toBe("  provider degraded: 2 subagents retrying on anthropic (+6 more providers)");
		// Same height as a single degraded provider.
		const single = liveGroup(15, 0).map((item, index) =>
			index < 2
				? {
						...item,
						progress: progress({
							id: item.id,
							retryState: {
								attempt: 1,
								maxAttempts: 3,
								kind: "provider_error" as const,
								provider: "anthropic",
								delayMs: 10_000,
								errorMessage: "overloaded",
								startedAtMs: Date.now(),
							},
						}),
					}
				: item,
		);
		expect(render({ subagents: single }, false).split("\n")).toHaveLength(4);
		// The expanded view keeps one row per degraded provider.
		expect(render({ subagents }, true).match(/provider degraded:/g)).toHaveLength(7);
	});

	it("counts a running subagent with no activity yet as idle once its job outlives the threshold", () => {
		settings.set("task.compactSubagentPanel", true);
		const subagents = [
			snapshot({ id: "0-Stalled", durationMs: 45_000 }),
			snapshot({ id: "0-Fresh", durationMs: 5_000 }),
			snapshot({
				id: "0-NoStamp",
				durationMs: 45_000,
				liveProgressAvailable: true,
				progress: progress({ id: "0-NoStamp", lastActivityMs: undefined }),
			}),
		];
		expect(render({ subagents }, false).split("\n")[1]).toBe("  3 subagents running · 2 idle >30s");
	});

	it("signs only the visible degradation row, not per-provider churn", () => {
		const withProviders = (providers: string[]) =>
			liveGroup(providers.length, 0).map((item, index) => ({
				...item,
				progress: progress({
					id: item.id,
					retryState: {
						attempt: 1,
						maxAttempts: 3,
						kind: "provider_error" as const,
						provider: providers[index],
						delayMs: 10_000,
						errorMessage: "overloaded",
						startedAtMs: 0,
					},
				}),
			}));
		const now = Date.now();
		const base = subagentCompactRenderedStateSignature(withProviders(["a", "a", "a", "b", "c"]), now);
		// A lone retrying subagent moving between providers changes nothing on screen.
		expect(subagentCompactRenderedStateSignature(withProviders(["a", "a", "a", "b", "d"]), now)).toBe(base);
		// A second degraded provider does change the visible row.
		expect(subagentCompactRenderedStateSignature(withProviders(["a", "a", "a", "b", "b"]), now)).not.toBe(base);
	});

	it("lists every subagent when tool output is expanded", () => {
		settings.set("task.compactSubagentPanel", true);
		const out = render({ subagents: liveGroup(15, 3) }, true);
		for (let index = 0; index < 15; index++) expect(out).toContain(`0-Worker${index}`);
		expect(out).not.toContain("idle >30s");
	});

	it("keeps the per-subagent list when the setting is off", () => {
		const out = render({ subagents: liveGroup(3, 0) }, false);
		expect(out).toContain("0-Worker0");
		expect(out).toContain("0-Worker2");
		expect(out).not.toContain("subagents running");
	});
});
