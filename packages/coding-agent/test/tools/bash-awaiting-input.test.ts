import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@gajae-code/agent-core";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { BashTool, type BashToolDetails } from "@gajae-code/coding-agent/tools/bash";
import * as shellSnapshot from "@gajae-code/coding-agent/utils/shell-snapshot";
import { resetShellConfigCache } from "@gajae-code/utils/shell-config";
import { AsyncJobManager } from "../../src/async";
import { createSteerHarness, ptyTurnContext } from "../helpers/steer-fold-harness";
import { stubBashExecutorSettings } from "../helpers/tool-session-settings";

/**
 * A foreground command that prints an auth prompt and then blocks must surface
 * `details.awaitingInput` on a running update, so the notifications extension
 * can tell the remote user. Covered on every foreground route: the managed job
 * (the normal session path), the direct executor (no job manager), and the
 * local interactive PTY.
 */

const PROMPT = String.raw`printf 'To authenticate, visit:\n\n\thttps://login.tailscale.com/a/abc123\n'`;

function createSession(cwd: string, manager: AsyncJobManager | undefined): ToolSession {
	return {
		cwd,
		getSessionFile: () => null,
		getSessionId: () => "bash-awaiting-input-test",
		bashAllowedPrefixes: undefined,
		bashRestrictionProfile: undefined,
		...(manager ? { getAsyncJobManager: () => manager } : {}),
		settings: {
			has(key: string) {
				return this.get(key) !== undefined;
			},
			get(key: string) {
				if (key === "bashInterceptor.enabled") return false;
				if (key === "async.enabled") return false;
				if (key === "bash.autoBackground.enabled") return false;
				if (key === "bash.autoBackground.thresholdMs") return 60_000;
				if (key === "bash.stripTrailingHeadTail") return false;
				return undefined;
			},
			getBashInterceptorRules() {
				return [];
			},
			...stubBashExecutorSettings,
		},
	} as unknown as ToolSession;
}

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function runAndCollect(command: string, managed: boolean): Promise<Array<BashToolDetails["awaitingInput"]>> {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-bash-awaiting-input-")));
	dirs.push(dir);
	resetShellConfigCache();
	const snapshotSpy = vi.spyOn(shellSnapshot, "getOrCreateSnapshot").mockResolvedValue(null);
	const manager = managed ? new AsyncJobManager({ onJobComplete: () => {} }) : undefined;
	try {
		const tool = new BashTool(createSession(dir, manager));
		const signals: Array<BashToolDetails["awaitingInput"]> = [];
		await tool.execute(
			"awaiting-input",
			{ command, timeout: 30 },
			undefined,
			(partial: AgentToolResult<BashToolDetails>) => {
				if (partial.details?.awaitingInput) signals.push(partial.details.awaitingInput);
			},
		);
		return signals;
	} finally {
		snapshotSpy.mockRestore();
	}
}

describe("BashTool awaiting-input signal", () => {
	for (const managed of [true, false]) {
		const route = managed ? "managed job" : "direct executor";

		it(`reports a quiet auth prompt once on the ${route} route`, async () => {
			const signals = await runAndCollect(`${PROMPT}; sleep 4.5`, managed);
			expect(signals.map(signal => signal?.kind)).toEqual(["browser_auth"]);
		}, 15_000);

		it(`stays silent when the command exits before the quiet window on the ${route} route`, async () => {
			const signals = await runAndCollect(`${PROMPT}; sleep 0.2`, managed);
			expect(signals).toEqual([]);
		}, 15_000);
	}
});

describe("BashTool awaiting-input signal on the interactive PTY route", () => {
	async function runPty(command: string, foldAfterMs?: number) {
		const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-bash-awaiting-pty-")));
		dirs.push(dir);
		const harness = createSteerHarness(dir);
		const signals: Array<BashToolDetails["awaitingInput"]> = [];
		try {
			const running = new BashTool(harness.session).execute(
				"awaiting-input-pty",
				{ command, pty: true, timeout: 30 },
				undefined,
				(partial: AgentToolResult<BashToolDetails>) => {
					if (partial.details?.awaitingInput) signals.push(partial.details.awaitingInput);
				},
				ptyTurnContext(),
			);
			if (foldAfterMs !== undefined) {
				await Bun.sleep(foldAfterMs);
				expect(await harness.session.requestForegroundBashBackground?.()).toBe(true);
			}
			const result = await running;
			const jobId = result.details?.async?.jobId;
			if (jobId) await harness.manager.getJob(jobId)?.promise;
			return { signals, folded: result.details?.foldReason !== undefined };
		} finally {
			await harness.manager.dispose();
			AsyncJobManager.resetForTests();
		}
	}

	it("reports a quiet auth prompt once", async () => {
		const { signals, folded } = await runPty(`${PROMPT}; sleep 4.5`);
		expect(folded).toBe(false);
		expect(signals.map(signal => signal?.kind)).toEqual(["browser_auth"]);
	}, 15_000);

	it("stays silent after the wait is folded before the quiet window elapses", async () => {
		const { signals, folded } = await runPty(`${PROMPT}; sleep 4.5`, 1_000);
		expect(folded).toBe(true);
		expect(signals).toEqual([]);
	}, 15_000);
});
