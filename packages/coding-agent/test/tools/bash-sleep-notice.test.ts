import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { BashTool } from "@gajae-code/coding-agent/tools/bash";
import { ToolError } from "@gajae-code/coding-agent/tools/tool-errors";
import * as shellSnapshot from "@gajae-code/coding-agent/utils/shell-snapshot";
import { resetShellConfigCache } from "@gajae-code/utils/shell-config";

/**
 * Observable BashTool integration for the sleep-advisory notice (#4465 review).
 *
 * The unit suite (`bash-sleep-advisory.test.ts`) covers the pure notice
 * constructor, including the default-timeout bounded wording
 * (`longSleepAdvisory("sleep 800", 300)`). These tests drive the full
 * `BashTool.execute` path to prove the notice — with the bounded-timeout
 * wording derived from the effective clamped timeout — reaches the observable
 * result body for a real killed command.
 *
 * The requested sleep (130s) exceeds the 120s advisory threshold, and the
 * explicit 2s timeout both bounds the real test wall-clock and produces the
 * "timeout will kill this command" sentence, so the P2 wording is asserted
 * end to end without any multi-minute wait. The timeout throws a `ToolError`;
 * the notice is appended to the failure message so the operator sees the
 * guidance even when the sleep is what triggered the kill.
 */

function createBashTool(cwd: string): BashTool {
	const session = {
		cwd,
		getSessionFile: () => null,
		getSessionId: () => "bash-sleep-notice-test",
		bashAllowedPrefixes: undefined,
		bashRestrictionProfile: undefined,
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
		},
	} as unknown as ToolSession;
	return new BashTool(session);
}

function tmpWorkspace(): string {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-bash-sleep-notice-")));
}

/** Run a command through a real BashTool and return the outcome as a string. */
async function runBashOutcome(command: string, timeout: number | undefined): Promise<string> {
	const dir = tmpWorkspace();
	try {
		resetShellConfigCache();
		// Skip the sourced shell snapshot so the one-shot path runs in the
		// controlled env without depending on a developer CLI / global PATH.
		const snapshotSpy = vi.spyOn(shellSnapshot, "getOrCreateSnapshot").mockResolvedValue(null);
		try {
			const tool = createBashTool(dir);
			const result = await tool.execute("sleep-notice", {
				command,
				...(timeout === undefined ? {} : { timeout }),
			});
			if (typeof result === "string") return result;
			return (result as { output?: string }).output ?? "";
		} finally {
			snapshotSpy.mockRestore();
		}
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	} finally {
		resetShellConfigCache();
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

describe("BashTool sleep-advisory notice (#4465 review)", () => {
	it("surfaces the bounded-timeout notice for a long sleep killed by an explicit short timeout", async () => {
		const message = await runBashOutcome("sleep 130", 2);
		// The command timed out, so the tool threw a ToolError; the notice is
		// appended to the failure message and carries the bounded-timeout wording.
		expect(message).toContain("timed out");
		expect(message).toContain("#4465");
		expect(message).toContain("requests a sleep of ~2m");
		expect(message).toContain("timeout will kill this command after ~2s");
		expect(message).toContain("subagent await");
		expect(message).toContain("job poll");
	});

	it("surfaces the notice on the chained sleep-then-check pattern killed by the timeout", async () => {
		const message = await runBashOutcome("sleep 130; echo checked", 2);
		expect(message).toContain("timed out");
		expect(message).toContain("#4465");
		expect(message).toContain("requests a sleep of ~2m");
		expect(message).toContain("timeout will kill this command after ~2s");
	});

	it("does not surface the notice for a short sleep", async () => {
		const message = await runBashOutcome("sleep 1", 30);
		expect(message).not.toContain("#4465");
	});

	it("does not surface the notice for a command with no sleep", async () => {
		const message = await runBashOutcome("echo quick", 30);
		expect(message).not.toContain("#4465");
	});

	it("throws a ToolError (not a silent return) when the long sleep times out, carrying the notice", async () => {
		const dir = tmpWorkspace();
		try {
			resetShellConfigCache();
			const snapshotSpy = vi.spyOn(shellSnapshot, "getOrCreateSnapshot").mockResolvedValue(null);
			try {
				const tool = createBashTool(dir);
				await expect(
					tool.execute("sleep-notice-throw", { command: "sleep 130", timeout: 2 }),
				).rejects.toBeInstanceOf(ToolError);
			} finally {
				snapshotSpy.mockRestore();
			}
		} finally {
			resetShellConfigCache();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
