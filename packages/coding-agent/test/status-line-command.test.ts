import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { visibleWidth } from "@gajae-code/tui";
import { resetSettingsForTest, Settings, settings } from "../src/config/settings";
import type { StatusLineSegmentId } from "../src/config/settings-schema";
import {
	normalizeStatusLineCommandOptions,
	STATUS_LINE_COMMAND_MAX_LENGTH,
} from "../src/modes/components/status-line/command";
import { renderSegment } from "../src/modes/components/status-line/segments";
import type { SegmentContext } from "../src/modes/components/status-line/types";
import { StatusLineComponent } from "../src/modes/components/tool-status-header";
import { EMPTY_JOBS_SNAPSHOT } from "../src/modes/jobs-observer";
import { initTheme } from "../src/modes/theme/theme";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
});

function commandContext(output: string): SegmentContext {
	return {
		session: {
			state: {},
			modelRegistry: { isUsingOAuth: () => false },
		} as unknown as SegmentContext["session"],
		width: 120,
		options: { command: { maxLength: 40 } },
		planMode: null,
		goalMode: null,
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			premiumRequests: 0,
			cost: 0,
			tokensPerSecond: null,
		},
		contextPercent: null,
		contextWindow: 0,
		autoCompactEnabled: false,
		subagentCount: 0,
		jobs: EMPTY_JOBS_SNAPSHOT,
		sessionStartTime: Date.now(),
		git: { branch: null, status: null, pr: null },
		usage: null,
		command: { output, failed: false, pending: false },
	} as unknown as SegmentContext;
}

describe("status line command segment", () => {
	it("reproduces the missing user-produced status content path", () => {
		const rendered = renderSegment("command" as StatusLineSegmentId, commandContext("deploy-ready"));

		expect(rendered.visible).toBe(true);
		expect(Bun.stripANSI(rendered.content)).toContain("deploy-ready");
	});

	it("sanitizes terminal controls and bounds user output before layout", () => {
		const rendered = renderSegment(
			"command" as StatusLineSegmentId,
			commandContext("\x1b[31msecret\x1b[0m\tvalue\nthat-is-too-long"),
		);
		const text = Bun.stripANSI(rendered.content);

		expect(rendered.visible).toBe(true);
		expect(text).toContain("secret value");
		expect(text).not.toContain("\x1b[");
		expect(text).not.toContain("\n");
		expect(visibleWidth(text)).toBeLessThanOrEqual(40);
	});

	it("shows a bounded diagnostic for an unknown configured segment", () => {
		const rendered = renderSegment("not-a-real-segment" as StatusLineSegmentId, commandContext("unused"));
		const text = Bun.stripANSI(rendered.content);

		expect(rendered.visible).toBe(true);
		expect(text).toContain("?unknown:not-a-real-seg");
		expect(visibleWidth(text)).toBeLessThanOrEqual(31);
	});

	it("clamps command execution settings to safe bounds", () => {
		expect(
			normalizeStatusLineCommandOptions({
				command: "  printf ok  ",
				timeoutMs: Number.POSITIVE_INFINITY,
				refreshMs: 1,
				maxLength: STATUS_LINE_COMMAND_MAX_LENGTH + 100,
			}),
		).toEqual({ command: "printf ok", timeoutMs: 500, refreshMs: 250, maxLength: STATUS_LINE_COMMAND_MAX_LENGTH });
	});

	it("does not block the render while a slow command is running", async () => {
		const component = makeComponent("sleep 0.2; printf too-late", { timeoutMs: 50 });
		const started = performance.now();
		const initial = Bun.stripANSI(component.render(120).join("\n"));
		const elapsed = performance.now() - started;

		expect(elapsed).toBeLessThan(100);
		expect(initial).toContain("…");

		await Bun.sleep(150);
		const afterTimeout = Bun.stripANSI(component.render(120).join("\n"));
		expect(afterTimeout).toContain("?");
		expect(afterTimeout).not.toContain("too-late");
	});

	it("keeps command failures out of the status row", async () => {
		const component = makeComponent("printf leaked-error >&2; exit 7");
		component.render(120);

		await Bun.sleep(100);
		const rendered = Bun.stripANSI(component.render(120).join("\n"));

		expect(rendered).toContain("?");
		expect(rendered).not.toContain("leaked-error");
	});

	it("renders successful command output asynchronously", async () => {
		const component = makeComponent("printf 'custom-hud-value'");
		const initial = Bun.stripANSI(component.render(120).join("\n"));
		expect(initial).not.toContain("custom-hud-value");

		await Bun.sleep(100);
		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		expect(rendered).toContain("custom-hud-value");
		component.dispose();
	});
});

function makeComponent(command: string, overrides: { timeoutMs?: number } = {}): StatusLineComponent {
	const component = new StatusLineComponent({
		state: { messages: [] },
		settings,
		isStreaming: false,
		isFastModeActive: () => false,
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				premiumRequests: 0,
				cost: 0,
			}),
			getSessionName: () => "command-test",
		},
		getAsyncJobSnapshot: () => ({ running: [] }),
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0]);
	component.updateSettings({
		preset: "custom",
		leftSegments: ["command" as StatusLineSegmentId],
		rightSegments: [],
		showSkillHud: false,
		showHookStatus: false,
		showActionHints: false,
		sessionAccent: false,
		segmentOptions: {
			command: {
				command,
				timeoutMs: overrides.timeoutMs,
				refreshMs: 250,
				maxLength: 40,
			},
		},
	});
	return component;
}
