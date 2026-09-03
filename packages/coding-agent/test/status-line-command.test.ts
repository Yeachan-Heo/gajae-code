import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { visibleWidth } from "@gajae-code/tui";
import { resetSettingsForTest, Settings } from "../src/config/settings";
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
		try {
			const started = performance.now();
			const initial = Bun.stripANSI(component.render(120).join("\n"));
			const elapsed = performance.now() - started;

			expect(elapsed).toBeLessThan(100);
			expect(initial).toContain("…");

			const afterTimeout = await waitForRendered(component, rendered => rendered.includes("?"));
			expect(afterTimeout).toContain("?");
			expect(afterTimeout).not.toContain("too-late");
		} finally {
			component.dispose();
		}
	});

	it("keeps command failures out of the status row", async () => {
		const component = makeComponent("printf leaked-error >&2; exit 7");
		try {
			component.render(120);

			const rendered = await waitForRendered(component, rendered => rendered.includes("?"));
			expect(rendered).toContain("?");
			expect(rendered).not.toContain("leaked-error");
		} finally {
			component.dispose();
		}
	});

	it("renders successful command output asynchronously", async () => {
		const component = makeComponent("printf 'custom-hud-value'");
		try {
			const initial = Bun.stripANSI(component.render(120).join("\n"));
			expect(initial).not.toContain("custom-hud-value");

			const rendered = await waitForRendered(component, rendered => rendered.includes("custom-hud-value"));
			expect(rendered).toContain("custom-hud-value");
		} finally {
			component.dispose();
		}
	});

	it("refreshes an idle command without another incidental render", async () => {
		const marker = path.join(os.tmpdir(), `gjc-status-line-refresh-${Date.now()}.txt`);
		const quotedMarker = marker.replaceAll("'", "'\\''");
		const command =
			`count=0; if [ -f '${quotedMarker}' ]; then count=$(cat '${quotedMarker}'); fi; ` +
			`count=$((count + 1)); printf '%s' "$count" > '${quotedMarker}'; printf 'refresh-%s' "$count"`;
		let component: StatusLineComponent | undefined;
		try {
			component = makeComponent(command, { refreshMs: 100 }, undefined, () => {
				component?.render(120);
			});
			component.render(120);
			const deadline = Date.now() + 2_000;
			let fileText = "";
			while (Date.now() < deadline) {
				fileText = await Bun.file(marker)
					.text()
					.catch(() => "");
				if (fileText === "2") break;
				await Bun.sleep(10);
			}
			expect(fileText).toBe("2");
		} finally {
			component?.dispose();
			await fs.rm(marker, { force: true });
		}
	});

	it("does not execute a command supplied only by project-scoped status settings", async () => {
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-status-line-project-"));
		const marker = path.join(os.tmpdir(), `gjc-status-line-project-command-${Date.now()}.txt`);
		const quotedMarker = marker.replaceAll("'", "'\\''");
		const command = `printf project-command > '${quotedMarker}'`;
		await fs.mkdir(path.join(projectDir, ".gjc"), { recursive: true });
		await Bun.write(
			path.join(projectDir, ".gjc", "config.yml"),
			`statusLine:\n  preset: custom\n  leftSegments:\n    - command\n  segmentOptions:\n    command:\n      command: ${JSON.stringify(command)}\n`,
		);
		const sessionSettings = await Settings.loadForScope({
			cwd: projectDir,
			agentDir: path.join(projectDir, "agent"),
		});
		const component = makeComponent(command, {}, sessionSettings);
		try {
			component.render(120);
			await Bun.sleep(150);
			expect(
				await Bun.file(marker)
					.text()
					.catch(() => ""),
			).toBe("");
		} finally {
			component.dispose();
			await sessionSettings.close();
			await fs.rm(marker, { force: true });
			await fs.rm(projectDir, { recursive: true, force: true });
		}
	});

	it("cancels an active command when the status component is disposed", async () => {
		const marker = path.join(os.tmpdir(), `gjc-status-line-dispose-${Date.now()}.txt`);
		const quotedMarker = marker.replaceAll("'", "'\\''");
		const component = makeComponent(`sleep 1; printf disposed-command > '${quotedMarker}'`, {
			timeoutMs: 5_000,
		});
		try {
			component.render(120);
			component.dispose();
			await Bun.sleep(1_200);
			expect(
				await Bun.file(marker)
					.text()
					.catch(() => ""),
			).toBe("");
		} finally {
			component.dispose();
			await fs.rm(marker, { force: true });
		}
	});
});

async function waitForRendered(
	component: StatusLineComponent,
	predicate: (rendered: string) => boolean,
): Promise<string> {
	const deadline = Date.now() + 1500;
	let rendered = "";
	while (Date.now() < deadline) {
		rendered = Bun.stripANSI(component.render(120).join("\n"));
		if (predicate(rendered)) return rendered;
		await Bun.sleep(10);
	}
	return rendered;
}

function makeComponent(
	command: string,
	overrides: { timeoutMs?: number; refreshMs?: number } = {},
	sessionSettings?: Settings,
	onUpdate?: () => void,
): StatusLineComponent {
	const resolvedSettings =
		sessionSettings ??
		Settings.isolated({
			"statusLine.leftSegments": ["command"],
			"statusLine.segmentOptions": {
				command: {
					command,
					timeoutMs: overrides.timeoutMs,
					refreshMs: overrides.refreshMs ?? 250,
					maxLength: 40,
				},
			},
		});
	const component = new StatusLineComponent(
		{
			state: { messages: [] },
			settings: resolvedSettings,
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
		} as unknown as ConstructorParameters<typeof StatusLineComponent>[0],
		{ onUpdate },
	);
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
				refreshMs: overrides.refreshMs ?? 250,
				maxLength: 40,
			},
		},
	});
	return component;
}
