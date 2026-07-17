import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { StatusLineComponent } from "../src/modes/components/tool-status-header";
import { initTheme } from "../src/modes/theme/theme";
import type { AgentSession } from "../src/session/agent-session";
import * as git from "../src/utils/git";

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterEach(() => {
	mock.restore();
	resetSettingsForTest();
});

function makeSession(): AgentSession {
	return {
		messages: [{ role: "user", content: "hello" }],
		state: {
			messages: [{ role: "user", content: "hello" }],
			model: { id: "test-model", contextWindow: 100_000 },
		},
		model: { id: "test-model", contextWindow: 100_000 },
		systemPrompt: ["You are a test assistant."],
		agent: { state: { tools: [] } },
		skills: [],
		sessionManager: {
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				premiumRequests: 0,
				cost: 0,
			}),
			getSessionName: () => "cache-test-session",
		},
		isStreaming: false,
		getAsyncJobSnapshot: () => ({ running: [] }),
	} as unknown as AgentSession;
}

function makeComponent(): StatusLineComponent {
	const component = new StatusLineComponent(makeSession());
	component.updateSettings({
		preset: "custom",
		leftSegments: ["git"],
		rightSegments: ["context_pct"],
		showSkillHud: false,
		showHookStatus: false,
		sessionAccent: false,
		segmentOptions: { git: { showBranch: true, showStaged: false, showUnstaged: false, showUntracked: false } },
	});
	return component;
}

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

describe("StatusLineComponent branch and rendered row caches", () => {
	it("resolves the current branch at most once across steady renders inside the TTL", () => {
		const branch = "feature/cache";
		const resolveSpy = spyOn(git.head, "resolveSync").mockImplementation(() => refHead(branch));
		const component = makeComponent();

		for (let i = 0; i < 30; i++) component.render(120);

		expect(resolveSpy).toHaveBeenCalledTimes(1);
		expect(component.render(120).join("\n")).toContain("feature/cache");
	});

	it("refreshes the branch after explicit branch-change invalidation", () => {
		let branch = "feature/old";
		const resolveSpy = spyOn(git.head, "resolveSync").mockImplementation(() => refHead(branch));
		const component = makeComponent();

		const first = component.render(120).join("\n");
		branch = "feature/new";
		component.invalidateBranchForTest();
		const second = component.render(120).join("\n");

		expect(resolveSpy).toHaveBeenCalledTimes(2);
		expect(first).toContain("feature/old");
		expect(second).toContain("feature/new");
	});

	it("refreshes the branch after the TTL elapses", () => {
		let now = 10_000;
		spyOn(Date, "now").mockImplementation(() => now);
		let branch = "feature/ttl-a";
		const resolveSpy = spyOn(git.head, "resolveSync").mockImplementation(() => refHead(branch));
		const component = makeComponent();

		component.render(120);
		branch = "feature/ttl-b";
		for (let i = 0; i < 10; i++) component.render(120);
		expect(resolveSpy).toHaveBeenCalledTimes(1);

		now += 1001;
		const updated = component.render(120).join("\n");
		expect(resolveSpy).toHaveBeenCalledTimes(2);
		expect(updated).toContain("feature/ttl-b");
	});

	it("reuses rendered rows when inputs are unchanged and updates after an input changes", () => {
		let branch = "feature/row-cache";
		spyOn(git.head, "resolveSync").mockImplementation(() => refHead(branch));
		const component = makeComponent();

		const first = component.render(120);
		const afterFirst = component.getCacheStatsForTest();
		const second = component.render(120);
		const afterSecond = component.getCacheStatsForTest();

		expect(second).toEqual(first);
		expect(afterSecond.rowHits).toBe(afterFirst.rowHits + 1);

		branch = "feature/row-cache-updated";
		component.invalidateBranchForTest();
		const third = component.render(120);
		const afterThird = component.getCacheStatsForTest();

		expect(third.join("\n")).toContain("feature/row-cache-updated");
		expect(third).not.toEqual(second);
		expect(afterThird.rowMisses).toBe(afterSecond.rowMisses + 1);
	});

	it("does not perform sync git HEAD resolution on steady cached frames", () => {
		const resolveSpy = spyOn(git.head, "resolveSync").mockImplementation(() => refHead("feature/no-sync-steady"));
		const component = makeComponent();

		component.render(120);
		resolveSpy.mockClear();
		for (let i = 0; i < 30; i++) component.render(120);

		expect(resolveSpy).not.toHaveBeenCalled();
	});
});
