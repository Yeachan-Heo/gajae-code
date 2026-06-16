import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	defaultStarReminderState,
	type GhResult,
	readStarReminderStateUnlocked,
	type StarReminderPromptUI,
	scheduleLaunchStarReminderAfterFirstRender,
	starReminderLaunchGate,
} from "@gajae-code/coding-agent/reminders/star-reminder";

const tempDirs: string[] = [];

async function makeStatePath(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-interactive-star-"));
	tempDirs.push(dir);
	return path.join(dir, "star-reminder.json");
}

const notFound = (): GhResult => ({ exitCode: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" });
const missing = (): GhResult => ({ exitCode: -1, stdout: "", stderr: "gh not found" });

function tick(ms = 30): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Poll until `predicate` is satisfied or the deadline elapses. The launch nudge
 * is fire-and-forget (`setTimeout(0)` -> async gh check + temp-file writes), so a
 * fixed sleep races the deferred work under full-suite load. Waiting on the
 * observable outcome makes the assertion deterministic without a blanket skip.
 */
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await predicate()) return;
		if (Date.now() >= deadline) return;
		await new Promise(resolve => setTimeout(resolve, 5));
	}
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("scheduleLaunchStarReminderAfterFirstRender", () => {
	it("does not run the gh check or prompt synchronously", async () => {
		const statePath = await makeStatePath();
		let confirmCalls = 0;
		let ghCalls = 0;
		const ui: StarReminderPromptUI = {
			confirm: async () => {
				confirmCalls++;
				return false;
			},
		};
		scheduleLaunchStarReminderAfterFirstRender(ui, {
			statePath,
			runGh: async () => {
				ghCalls++;
				return notFound();
			},
		});
		// Synchronous: nothing has run yet (deferred to after first render).
		expect(ghCalls).toBe(0);
		expect(confirmCalls).toBe(0);

		// Deferred work persists `declined` last, so once it is true the gh check
		// and confirm prompt have both run. Poll the outcome instead of a fixed sleep.
		await waitFor(async () => (await readStarReminderStateUnlocked(statePath)).declined === true);
		expect(ghCalls).toBe(1);
		expect(ghCalls).toBe(1);
		expect(confirmCalls).toBe(1);
		expect((await readStarReminderStateUnlocked(statePath)).declined).toBe(true);
	});

	it("returns immediately and swallows confirm errors", async () => {
		const statePath = await makeStatePath();
		const ui: StarReminderPromptUI = {
			confirm: async () => {
				throw new Error("ui boom");
			},
		};
		// Must not throw synchronously.
		expect(() =>
			scheduleLaunchStarReminderAfterFirstRender(ui, { statePath, runGh: async () => notFound() }),
		).not.toThrow();
		await tick();
		// The error was swallowed (no throw). The fresh unstarred check was
		// persisted before the prompt, but the decline write never ran because
		// confirm threw, so declined stays false.
		const state = await readStarReminderStateUnlocked(statePath);
		expect(state.declined).toBe(false);
		expect(state.starred).toBe(false);
	});

	it("stays silent when gh is unavailable", async () => {
		const statePath = await makeStatePath();
		let confirmCalls = 0;
		const ui: StarReminderPromptUI = {
			confirm: async () => {
				confirmCalls++;
				return true;
			},
		};
		scheduleLaunchStarReminderAfterFirstRender(ui, { statePath, runGh: async () => missing() });
		await tick();
		expect(confirmCalls).toBe(0);
		expect(await readStarReminderStateUnlocked(statePath)).toEqual(defaultStarReminderState());
	});

	it("skips silently when the idle guard reports busy", async () => {
		const statePath = await makeStatePath();
		let confirmCalls = 0;
		const ui: StarReminderPromptUI = {
			confirm: async () => {
				confirmCalls++;
				return true;
			},
			isIdle: () => false,
		};
		scheduleLaunchStarReminderAfterFirstRender(ui, { statePath, runGh: async () => notFound() });
		await tick();
		expect(confirmCalls).toBe(0);
	});
});

describe("starReminderLaunchGate (interactive wiring)", () => {
	it("enabled + not quiet -> register and schedule", () => {
		expect(starReminderLaunchGate({ enabled: true, quiet: false })).toEqual({ register: true, schedule: true });
	});

	it("enabled + quiet -> register but do not schedule the launch nudge (AC9)", () => {
		expect(starReminderLaunchGate({ enabled: true, quiet: true })).toEqual({ register: true, schedule: false });
	});

	it("disabled -> neither register nor schedule", () => {
		expect(starReminderLaunchGate({ enabled: false, quiet: false })).toEqual({ register: false, schedule: false });
		expect(starReminderLaunchGate({ enabled: false, quiet: true })).toEqual({ register: false, schedule: false });
	});
});
