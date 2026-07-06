import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import { getProjectDir, setProjectDir } from "@gajae-code/utils";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { StatusLineComponent } from "../src/modes/components/status-line";
import { EMPTY_JOBS_SNAPSHOT } from "../src/modes/jobs-observer";
import { initTheme, theme } from "../src/modes/theme/theme";
import type { AgentSession } from "../src/session/agent-session";
import * as git from "../src/utils/git";

const originalProjectDir = getProjectDir();
beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterEach(() => {
	mock.restore();
	resetSettingsForTest();
	setProjectDir(originalProjectDir);
});

function refHead(branch: string): ReturnType<typeof git.head.resolveSync> {
	return {
		kind: "ref",
		ref: `refs/heads/${branch}`,
		branchName: branch,
		headPath: "/tmp/repo/.git/HEAD",
		headContent: `ref: refs/heads/${branch}`,
		commit: "abc123",
		commonDir: "/tmp/repo/.git",
		gitDir: "/tmp/repo/.git",
		gitEntryPath: "/tmp/repo/.git",
		repoRoot: "/tmp/repo",
	};
}

function makeSession(overrides: Record<string, unknown> = {}): AgentSession {
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, premiumRequests: 0, cost: 0 };
	const session: Record<string, unknown> = {
		messages: [{ role: "user", content: "hello" }],
		state: {
			messages: [{ role: "user", content: "hello" }],
			model: { id: "test-model", name: "test-model", contextWindow: 100_000 },
		},
		model: { id: "test-model", contextWindow: 100_000 },
		systemPrompt: ["You are a test assistant."],
		agent: { state: { tools: [] } },
		skills: [],
		settings: { get: () => false },
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getUsageStatistics: () => usage,
			getSessionName: () => "cache-redteam-session",
			getSessionId: () => "session-abcdef123456",
		},
		isStreaming: false,
		isFastModeActive: () => false,
		getAsyncJobSnapshot: () => ({ running: [] }),
		getGoalModeState: () => undefined,
		...overrides,
	};
	return session as unknown as AgentSession;
}

function makeComponent(session = makeSession()): StatusLineComponent {
	const component = new StatusLineComponent(session, { version: "redteam" });
	component.updateSettings({
		preset: "custom",
		leftSegments: ["git", "pr", "mode", "session_name", "path"],
		rightSegments: [
			"context_pct",
			"token_in",
			"token_out",
			"token_rate",
			"cache_read",
			"cache_write",
			"cost",
			"usage",
			"subagents",
			"jobs",
			"time_spent",
		],
		showSkillHud: true,
		showHookStatus: true,
		sessionAccent: true,
		maxRows: 3,
		segmentOptions: { git: { showBranch: true, showStaged: true, showUnstaged: true, showUntracked: true } },
	});
	return component;
}

function text(rows: string[]): string {
	return rows.join("\n");
}

async function tick(): Promise<void> {
	await Promise.resolve();
	await new Promise(resolve => setTimeout(resolve, 0));
}

describe("StatusLineComponent cache red-team coverage", () => {
	it("limits branch resolution inside TTL and refreshes once at the TTL boundary", () => {
		let now = 50_000;
		spyOn(Date, "now").mockImplementation(() => now);
		let branch = "feature/ttl-a";
		const resolveSpy = spyOn(git.head, "resolveSync").mockImplementation(() => refHead(branch));
		const component = makeComponent();

		for (let i = 0; i < 30; i++) component.render(160);
		expect(resolveSpy).toHaveBeenCalledTimes(1);

		branch = "feature/ttl-b";
		now += 999;
		for (let i = 0; i < 10; i++) component.render(160);
		expect(resolveSpy).toHaveBeenCalledTimes(1);

		now += 1;
		for (let i = 0; i < 30; i++) component.render(160);
		expect(resolveSpy).toHaveBeenCalledTimes(2);
		expect(text(component.render(160))).toContain("feature/ttl-b");
	});

	it("shows branch changes immediately after explicit watcher-style invalidation", () => {
		let branch = "feature/stale-old";
		const resolveSpy = spyOn(git.head, "resolveSync").mockImplementation(() => refHead(branch));
		const component = makeComponent();

		const first = text(component.render(160));
		branch = "feature/stale-new";
		component.invalidateBranchForTest();
		const second = text(component.render(160));

		expect(resolveSpy).toHaveBeenCalledTimes(2);
		expect(first).toContain("feature/stale-old");
		expect(second).toContain("feature/stale-new");
		expect(second).not.toContain("feature/stale-old");
	});

	it("refreshes branch cache when project dir changes inside the TTL", () => {
		const now = 75_000;
		spyOn(Date, "now").mockImplementation(() => now);
		const repoA = "/tmp/gjc-status-line-repo-a";
		const repoB = "/tmp/gjc-status-line-repo-b";
		const resolveSpy = spyOn(git.head, "resolveSync").mockImplementation(projectDir => {
			const branch = projectDir === repoB ? "feature/repo-b" : "feature/repo-a";
			const head = refHead(branch) as NonNullable<ReturnType<typeof git.head.resolveSync>>;
			return { ...head, repoRoot: projectDir, headPath: `${projectDir}/.git/HEAD` };
		});
		const component = makeComponent();

		fs.mkdirSync(repoA, { recursive: true });
		fs.mkdirSync(repoB, { recursive: true });
		setProjectDir(repoA);
		const first = text(component.render(160));
		setProjectDir(repoB);
		const second = text(component.render(160));

		expect(resolveSpy).toHaveBeenCalledTimes(2);
		expect(first).toContain("feature/repo-a");
		expect(second).toContain("feature/repo-b");
		expect(second).not.toContain("feature/repo-a");
	});

	it("misses row cache when only row layout theme glyphs or border color change", () => {
		spyOn(git.head, "resolveSync").mockImplementation(() => refHead("feature/theme-layout"));
		const component = makeComponent();
		component.updateSettings({ sessionAccent: false });

		const beforeSeparator = text(component.render(160));
		const beforeSeparatorStats = component.getCacheStatsForTest();
		const originalSep = theme.sep;
		Object.defineProperty(theme, "sep", { configurable: true, get: () => ({ ...originalSep, slash: "X" }) });
		const afterSeparator = text(component.render(160));
		const afterSeparatorStats = component.getCacheStatsForTest();
		expect(afterSeparator).not.toBe(beforeSeparator);
		expect(afterSeparator).toContain("X");
		expect(afterSeparatorStats.rowMisses).toBeGreaterThan(beforeSeparatorStats.rowMisses);
		delete (theme as { sep?: unknown }).sep;
		component.invalidateBranchForTest();
		spyOn(git.head, "resolveSync").mockImplementation(() => refHead("feature/theme-layout"));

		const beforeBorder = text(component.render(160));
		const beforeBorderStats = component.getCacheStatsForTest();
		const originalGetFgAnsi = theme.getFgAnsi.bind(theme);
		const fgSpy = spyOn(theme, "getFgAnsi").mockImplementation(color =>
			color === "border" ? "\x1b[38;5;201m" : originalGetFgAnsi(color),
		);
		const afterBorder = text(component.render(160));
		const afterBorderStats = component.getCacheStatsForTest();
		expect(afterBorder).not.toBe(beforeBorder);
		expect(afterBorder).toContain("\x1b[38;5;201m");
		expect(afterBorderStats.rowMisses).toBeGreaterThan(beforeBorderStats.rowMisses);
		fgSpy.mockRestore();
		component.invalidateBranchForTest();
		spyOn(git.head, "resolveSync").mockImplementation(() => refHead("feature/theme-layout"));

		const beforeHorizontal = text(component.render(160));
		const beforeHorizontalStats = component.getCacheStatsForTest();
		const originalBoxRound = theme.boxRound;
		Object.defineProperty(theme, "boxRound", {
			configurable: true,
			get: () => ({ ...originalBoxRound, horizontal: "=" }),
		});
		const afterHorizontal = text(component.render(160));
		const afterHorizontalStats = component.getCacheStatsForTest();
		expect(afterHorizontal).not.toBe(beforeHorizontal);
		expect(afterHorizontal).toContain("=");
		expect(afterHorizontalStats.rowMisses).toBeGreaterThan(beforeHorizontalStats.rowMisses);
		delete (theme as { boxRound?: unknown }).boxRound;
	});

	it("misses row cache when the cached PR number changes", () => {
		spyOn(git.head, "resolveSync").mockImplementation(() => refHead("feature/pr-cache"));
		const component = makeComponent();

		component.setCachedPrForTest({ number: 123, url: "https://example.test/pull/123" });
		const first = text(component.render(160));
		const beforeStats = component.getCacheStatsForTest();
		component.setCachedPrForTest({ number: 456, url: "https://example.test/pull/456" });
		const second = text(component.render(160));
		const afterStats = component.getCacheStatsForTest();

		expect(first).toContain("#123");
		expect(second).toContain("#456");
		expect(second).not.toContain("#123");
		expect(afterStats.rowMisses).toBeGreaterThan(beforeStats.rowMisses);
	});

	it("misses the rendered-row cache for output-affecting input mutations", async () => {
		let now = 100_000;
		spyOn(Date, "now").mockImplementation(() => now);
		const branch = "feature/matrix";
		let gitStatus = { staged: 0, unstaged: 0, untracked: 0 };
		spyOn(git.head, "resolveSync").mockImplementation(() => refHead(branch));
		spyOn(git.status, "summary").mockImplementation(async () => gitStatus);

		const usageStats = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, premiumRequests: 0, cost: 0 };
		let sessionName = "cache-redteam-session";
		let jobSnapshot = { running: [] as Array<{ id: string; metadata?: Record<string, unknown> }> };
		const assistant = { role: "assistant", content: "hello", timestamp: 1_000, usage: { output: 20 } };
		const session = makeSession({
			messages: [{ role: "user", content: "hello" }, assistant],
			state: {
				messages: [{ role: "user", content: "hello" }, assistant],
				model: { id: "test-model", name: "test-model", contextWindow: 100_000 },
			},
			sessionManager: {
				getUsageStatistics: () => usageStats,
				getSessionName: () => sessionName,
				getSessionId: () => "session-abcdef123456",
			},
			isStreaming: true,
			getAsyncJobSnapshot: () => jobSnapshot,
		}) as AgentSession & { isStreaming: boolean };
		const component = makeComponent(session);
		component.setSessionStartTime(now - 2_000);
		component.setJobs(EMPTY_JOBS_SNAPSHOT);
		component.render(160);
		await tick();
		const baseline = text(component.render(160));

		async function expectMutationChanges(
			label: string,
			mutate: () => void | Promise<void>,
			width = 160,
		): Promise<void> {
			const beforeStats = component.getCacheStatsForTest();
			const before = text(component.render(width));
			await mutate();
			const after = text(component.render(width));
			const afterStats = component.getCacheStatsForTest();
			expect(after, label).not.toBe(before);
			expect(afterStats.rowMisses, label).toBeGreaterThan(beforeStats.rowMisses);
		}

		await expectMutationChanges("git status counts", async () => {
			gitStatus = { staged: 2, unstaged: 3, untracked: 4 };
			now += 1000;
			component.invalidateBranchForTest();
			await tick();
		});
		await expectMutationChanges("usage/context breakdown", () => {
			session.messages.push({ role: "user", content: "expanded context".repeat(30) } as never);
			session.state.messages.push({ role: "user", content: "expanded context".repeat(30) } as never);
		});
		await expectMutationChanges("TPS/streaming", () => {
			assistant.usage.output = 400;
			assistant.timestamp = 99_000;
			session.isStreaming = true;
		});
		await expectMutationChanges("mode/skill HUD", () => {
			component.setPlanModeStatus({ enabled: true, paused: false });
			component.setSkillHudEntriesForTest([{ name: "redteam", status: "active" } as never]);
		});
		await expectMutationChanges("jobs/subagents count", () => {
			component.setSubagentCount(3);
			component.setJobs({ activeMonitorCount: 1, activeCronCount: 1, worstState: "running" } as never);
			jobSnapshot = { running: [{ id: "job-1", metadata: {} }] };
		});
		await expectMutationChanges("session accent/theme", () => {
			sessionName = "cache-redteam-renamed";
		});
		{
			const beforeStats = component.getCacheStatsForTest();
			const before = text(component.render(160));
			const after = text(component.render(72));
			const afterStats = component.getCacheStatsForTest();
			expect(after, "terminal width").not.toBe(before);
			expect(afterStats.rowMisses, "terminal width").toBeGreaterThan(beforeStats.rowMisses);
		}
		await expectMutationChanges(
			"maxRows",
			() => {
				component.updateSettings({ maxRows: 1 });
			},
			72,
		);
		expect(baseline.length).toBeGreaterThan(0);
	});

	it("defensively copies cached rows so caller mutation cannot corrupt the cache", () => {
		spyOn(git.head, "resolveSync").mockImplementation(() => refHead("feature/mutation"));
		const component = makeComponent();
		const original = component.render(160);
		const expected = [...original];
		original.splice(0, original.length, "CORRUPTED");
		const rerendered = component.render(160);
		expect(rerendered).toEqual(expected);
		expect(rerendered).not.toContain("CORRUPTED");
	});

	it("does not freeze time-based animation-like segments behind the rendered-row cache", () => {
		let now = 200_000;
		spyOn(Date, "now").mockImplementation(() => now);
		spyOn(git.head, "resolveSync").mockImplementation(() => refHead("feature/time"));
		const component = makeComponent();
		component.setSessionStartTime(now - 61_000);
		const first = text(component.render(160));
		now += 61_000;
		const second = text(component.render(160));
		expect(second).not.toBe(first);
		expect(second).toContain("2m");
	});
});
