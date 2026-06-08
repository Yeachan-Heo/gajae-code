import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	autoStarRepo,
	checkGhStarred,
	createStarReminderBeforeAgentStartContributor,
	createStarReminderMessage,
	defaultStarReminderState,
	type GhResult,
	isStarredCacheFresh,
	maybeShowLaunchStarReminder,
	readStarReminderStateUnlocked,
	recordDeclinedAfterNo,
	recordFreshStarCheck,
	recordStarredFromPut,
	refreshStarStateForSession,
	STAR_REMINDER_CUSTOM_TYPE,
	STAR_REMINDER_REPO,
	STARRED_CACHE_TTL_MS,
	type StarReminderState,
	updateStarReminderStateLocked,
} from "@gajae-code/coding-agent/reminders/star-reminder";

const tempDirs: string[] = [];

async function makeStatePath(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-star-reminder-"));
	tempDirs.push(dir);
	return path.join(dir, "nested", "star-reminder.json");
}

interface GhCall {
	args: string[];
}

function ghRecorder(handler: (args: string[]) => GhResult) {
	const calls: GhCall[] = [];
	const runGh = async (args: string[]): Promise<GhResult> => {
		calls.push({ args });
		return handler(args);
	};
	return { runGh, calls };
}

const ok = (stdout = ""): GhResult => ({ exitCode: 0, stdout, stderr: "" });
const notFound = (): GhResult => ({ exitCode: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" });

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("state IO", () => {
	it("returns default for a missing file", async () => {
		const statePath = await makeStatePath();
		expect(await readStarReminderStateUnlocked(statePath)).toEqual(defaultStarReminderState());
	});

	it("returns default for malformed JSON without throwing", async () => {
		const statePath = await makeStatePath();
		await fs.mkdir(path.dirname(statePath), { recursive: true });
		await fs.writeFile(statePath, "{ not json");
		expect(await readStarReminderStateUnlocked(statePath)).toEqual(defaultStarReminderState());
	});

	it("returns default for a shape mismatch", async () => {
		const statePath = await makeStatePath();
		await fs.mkdir(path.dirname(statePath), { recursive: true });
		await fs.writeFile(statePath, JSON.stringify({ declined: "yes" }));
		expect(await readStarReminderStateUnlocked(statePath)).toEqual(defaultStarReminderState());
	});

	it("locked write creates the parent dir and writes valid JSON", async () => {
		const statePath = await makeStatePath();
		const next: StarReminderState = { declined: true, starred: false, starredCheckedAt: "" };
		const written = await updateStarReminderStateLocked(() => next, { statePath });
		expect(written).toEqual(next);
		const reread = JSON.parse(await fs.readFile(statePath, "utf8"));
		expect(reread).toEqual(next);
	});
});

describe("isStarredCacheFresh (AC8)", () => {
	const now = new Date("2026-01-02T00:00:00.000Z");

	it("is fresh just under 24h", () => {
		const checkedAt = new Date(now.getTime() - (STARRED_CACHE_TTL_MS - 1)).toISOString();
		expect(isStarredCacheFresh({ declined: false, starred: true, starredCheckedAt: checkedAt }, now)).toBe(true);
	});

	it("is stale at exactly 24h", () => {
		const checkedAt = new Date(now.getTime() - STARRED_CACHE_TTL_MS).toISOString();
		expect(isStarredCacheFresh({ declined: false, starred: true, starredCheckedAt: checkedAt }, now)).toBe(false);
	});

	it("is stale older than 24h", () => {
		const checkedAt = new Date(now.getTime() - STARRED_CACHE_TTL_MS - 1000).toISOString();
		expect(isStarredCacheFresh({ declined: false, starred: true, starredCheckedAt: checkedAt }, now)).toBe(false);
	});

	it("is stale for a malformed timestamp", () => {
		expect(isStarredCacheFresh({ declined: false, starred: true, starredCheckedAt: "nope" }, now)).toBe(false);
	});

	it("is never fresh when unstarred", () => {
		expect(isStarredCacheFresh({ declined: false, starred: false, starredCheckedAt: now.toISOString() }, now)).toBe(
			false,
		);
	});
});

describe("checkGhStarred classification", () => {
	it("exit 0 -> starred and uses exact args", async () => {
		const { runGh, calls } = ghRecorder(() => ok());
		expect(await checkGhStarred({ runGh })).toBe("starred");
		expect(calls[0]?.args).toEqual(["api", `user/starred/${STAR_REMINDER_REPO}`]);
	});

	it("404 -> unstarred", async () => {
		const { runGh } = ghRecorder(() => notFound());
		expect(await checkGhStarred({ runGh })).toBe("unstarred");
	});

	it("missing gh -> unavailable", async () => {
		const { runGh } = ghRecorder(() => ({ exitCode: -1, stdout: "", stderr: "gh not found" }));
		expect(await checkGhStarred({ runGh })).toBe("unavailable");
	});

	it("auth failure -> unavailable", async () => {
		const { runGh } = ghRecorder(() => ({ exitCode: 1, stdout: "", stderr: "gh auth login required" }));
		expect(await checkGhStarred({ runGh })).toBe("unavailable");
	});

	it("network failure -> unavailable", async () => {
		const { runGh } = ghRecorder(() => ({ exitCode: 1, stdout: "", stderr: "dial tcp: lookup api.github.com" }));
		expect(await checkGhStarred({ runGh })).toBe("unavailable");
	});

	it("timeout -> unavailable", async () => {
		const { runGh } = ghRecorder(() => ({ exitCode: -1, stdout: "", stderr: "", timedOut: true }));
		expect(await checkGhStarred({ runGh })).toBe("unavailable");
	});
});

describe("autoStarRepo", () => {
	it("uses exact PUT args and returns true on success", async () => {
		const { runGh, calls } = ghRecorder(() => ok());
		expect(await autoStarRepo({ runGh })).toBe(true);
		expect(calls[0]?.args).toEqual(["api", "-X", "PUT", `user/starred/${STAR_REMINDER_REPO}`]);
	});

	it("returns false on failure", async () => {
		const { runGh } = ghRecorder(() => ({ exitCode: 1, stdout: "", stderr: "boom" }));
		expect(await autoStarRepo({ runGh })).toBe(false);
	});
});

describe("monotonic merge", () => {
	it("recordStarredFromPut writes starred and clears declined", async () => {
		const statePath = await makeStatePath();
		await updateStarReminderStateLocked(() => ({ declined: true, starred: false, starredCheckedAt: "" }), {
			statePath,
		});
		const result = await recordStarredFromPut({ statePath, now: () => new Date("2026-01-01T00:00:00.000Z") });
		expect(result.starred).toBe(true);
		expect(result.declined).toBe(false);
	});

	it("stale declined write cannot overwrite a confirmed star", async () => {
		const statePath = await makeStatePath();
		await updateStarReminderStateLocked(
			() => ({ declined: false, starred: true, starredCheckedAt: new Date().toISOString() }),
			{ statePath },
		);
		const result = await recordDeclinedAfterNo({ statePath });
		expect(result.starred).toBe(true);
		expect(result.declined).toBe(false);
	});

	it("recordDeclinedAfterNo sets declined when not starred", async () => {
		const statePath = await makeStatePath();
		const result = await recordDeclinedAfterNo({ statePath });
		expect(result).toEqual({ declined: true, starred: false, starredCheckedAt: "" });
	});

	it("fresh unstarred check does not downgrade a still-fresh confirmed star", async () => {
		const statePath = await makeStatePath();
		const now = new Date("2026-01-02T00:00:00.000Z");
		await updateStarReminderStateLocked(
			() => ({ declined: false, starred: true, starredCheckedAt: now.toISOString() }),
			{ statePath },
		);
		const result = await recordFreshStarCheck("unstarred", { statePath, now: () => now });
		expect(result.starred).toBe(true);
	});

	it("fresh unstarred check downgrades a stale star", async () => {
		const statePath = await makeStatePath();
		const now = new Date("2026-01-02T00:00:00.000Z");
		const stale = new Date(now.getTime() - STARRED_CACHE_TTL_MS - 1000).toISOString();
		await updateStarReminderStateLocked(() => ({ declined: false, starred: true, starredCheckedAt: stale }), {
			statePath,
		});
		const result = await recordFreshStarCheck("unstarred", { statePath, now: () => now });
		expect(result.starred).toBe(false);
	});

	it("unstarred check does not clobber a concurrently-newer confirmed star", async () => {
		const statePath = await makeStatePath();
		const opTime = new Date("2026-01-02T00:00:00.000Z");
		// A concurrent process recorded a star AFTER this operation captured its time.
		const newer = new Date(opTime.getTime() + 5000).toISOString();
		await updateStarReminderStateLocked(() => ({ declined: false, starred: true, starredCheckedAt: newer }), {
			statePath,
		});
		const result = await recordFreshStarCheck("unstarred", { statePath, now: () => opTime });
		expect(result.starred).toBe(true);
	});
});

describe("refreshStarStateForSession (AC5, AC8)", () => {
	it("skips gh when starred cache is fresh", async () => {
		const statePath = await makeStatePath();
		const now = new Date("2026-01-02T00:00:00.000Z");
		await updateStarReminderStateLocked(
			() => ({ declined: false, starred: true, starredCheckedAt: now.toISOString() }),
			{ statePath },
		);
		const { runGh, calls } = ghRecorder(() => ok());
		expect(await refreshStarStateForSession({ statePath, now: () => now, runGh })).toBe("starred");
		expect(calls).toHaveLength(0);
	});

	it("rechecks gh when unstarred and records the result", async () => {
		const statePath = await makeStatePath();
		const { runGh, calls } = ghRecorder(() => notFound());
		expect(await refreshStarStateForSession({ statePath, runGh })).toBe("unstarred");
		expect(calls).toHaveLength(1);
	});
});

describe("maybeShowLaunchStarReminder", () => {
	it("AC2: stays fully silent when gh is unavailable", async () => {
		const statePath = await makeStatePath();
		const { runGh } = ghRecorder(() => ({ exitCode: -1, stdout: "", stderr: "gh not found" }));
		let confirmCalls = 0;
		await maybeShowLaunchStarReminder(
			{
				confirm: async () => {
					confirmCalls++;
					return true;
				},
			},
			{ statePath, runGh },
		);
		expect(confirmCalls).toBe(0);
		expect(await readStarReminderStateUnlocked(statePath)).toEqual(defaultStarReminderState());
	});

	it("Yes path stars the repo (AC3)", async () => {
		const statePath = await makeStatePath();
		const { runGh } = ghRecorder(args => (args.includes("PUT") ? ok() : notFound()));
		await maybeShowLaunchStarReminder({ confirm: async () => true }, { statePath, runGh });
		const state = await readStarReminderStateUnlocked(statePath);
		expect(state.starred).toBe(true);
		expect(state.declined).toBe(false);
	});

	it("No path records declined and suppresses a later prompt (AC4)", async () => {
		const statePath = await makeStatePath();
		const { runGh } = ghRecorder(() => notFound());
		let confirmCalls = 0;
		const ui = {
			confirm: async () => {
				confirmCalls++;
				return false;
			},
		};
		await maybeShowLaunchStarReminder(ui, { statePath, runGh });
		expect((await readStarReminderStateUnlocked(statePath)).declined).toBe(true);

		// Second launch: declined users get no prompt.
		await maybeShowLaunchStarReminder(ui, { statePath, runGh });
		expect(confirmCalls).toBe(1);
	});

	it("does not prompt when already starred and fresh (AC5)", async () => {
		const statePath = await makeStatePath();
		const now = new Date("2026-01-02T00:00:00.000Z");
		await updateStarReminderStateLocked(
			() => ({ declined: false, starred: true, starredCheckedAt: now.toISOString() }),
			{ statePath },
		);
		const { runGh, calls } = ghRecorder(() => ok());
		let confirmCalls = 0;
		await maybeShowLaunchStarReminder(
			{
				confirm: async () => {
					confirmCalls++;
					return true;
				},
			},
			{ statePath, now: () => now, runGh },
		);
		expect(confirmCalls).toBe(0);
		expect(calls).toHaveLength(0);
	});

	it("skips silently when the idle guard is false", async () => {
		const statePath = await makeStatePath();
		const { runGh } = ghRecorder(() => notFound());
		let confirmCalls = 0;
		await maybeShowLaunchStarReminder(
			{
				confirm: async () => {
					confirmCalls++;
					return true;
				},
				isIdle: () => false,
			},
			{ statePath, runGh },
		);
		expect(confirmCalls).toBe(0);
	});
});

describe("decline-driven injection (AC6, AC7)", () => {
	function sessionRef(id: string | undefined) {
		return { getSessionId: () => id };
	}

	it("injects once per logical session for declined + unstarred users", async () => {
		const statePath = await makeStatePath();
		await recordDeclinedAfterNo({ statePath });
		const { runGh } = ghRecorder(() => notFound());
		const contributor = createStarReminderBeforeAgentStartContributor(sessionRef("session-a"), { statePath, runGh });

		const first = await contributor({ prompt: "hi", sessionId: "session-a" });
		expect(first?.customType).toBe(STAR_REMINDER_CUSTOM_TYPE);
		const second = await contributor({ prompt: "again", sessionId: "session-a" });
		expect(second).toBeUndefined();
	});

	it("re-injects for a new logical session id", async () => {
		const statePath = await makeStatePath();
		await recordDeclinedAfterNo({ statePath });
		const { runGh } = ghRecorder(() => notFound());
		let currentId = "session-a";
		const contributor = createStarReminderBeforeAgentStartContributor(
			{ getSessionId: () => currentId },
			{ statePath, runGh },
		);
		expect(await contributor({ prompt: "hi", sessionId: currentId })).toBeDefined();
		currentId = "session-b";
		expect(await contributor({ prompt: "hi", sessionId: currentId })).toBeDefined();
	});

	it("does not inject for non-declined users", async () => {
		const statePath = await makeStatePath();
		const { runGh } = ghRecorder(() => notFound());
		const contributor = createStarReminderBeforeAgentStartContributor(sessionRef("session-a"), { statePath, runGh });
		expect(await contributor({ prompt: "hi", sessionId: "session-a" })).toBeUndefined();
	});

	it("stops injecting once the repo is starred externally (AC7)", async () => {
		const statePath = await makeStatePath();
		await recordDeclinedAfterNo({ statePath });
		const { runGh } = ghRecorder(() => ok());
		const contributor = createStarReminderBeforeAgentStartContributor(sessionRef("session-a"), { statePath, runGh });
		expect(await contributor({ prompt: "hi", sessionId: "session-a" })).toBeUndefined();
		// External star was recorded.
		expect((await readStarReminderStateUnlocked(statePath)).starred).toBe(true);
	});

	it("does not inject without a stable session id", async () => {
		const statePath = await makeStatePath();
		await recordDeclinedAfterNo({ statePath });
		const { runGh } = ghRecorder(() => notFound());
		const contributor = createStarReminderBeforeAgentStartContributor(sessionRef(undefined), { statePath, runGh });
		expect(await contributor({ prompt: "hi", sessionId: undefined })).toBeUndefined();
	});
});

describe("createStarReminderMessage", () => {
	it("is a non-displayed agent-attributed custom message", () => {
		const msg = createStarReminderMessage();
		expect(msg.customType).toBe(STAR_REMINDER_CUSTOM_TYPE);
		expect(msg.display).toBe(false);
		expect(msg.attribution).toBe("agent");
		expect(typeof msg.content).toBe("string");
	});
});

describe("regression fixes", () => {
	it("non-404 failure containing the digits 404 stays unavailable", async () => {
		const { runGh } = ghRecorder(() => ({ exitCode: 1, stdout: "", stderr: "dial tcp 10.0.0.404:443: timeout" }));
		expect(await checkGhStarred({ runGh })).toBe("unavailable");
	});

	it("stale starred + fresh unstarred + No records declined (AC4)", async () => {
		const statePath = await makeStatePath();
		const now = new Date("2026-01-02T00:00:00.000Z");
		const stale = new Date(now.getTime() - STARRED_CACHE_TTL_MS - 1000).toISOString();
		await updateStarReminderStateLocked(() => ({ declined: false, starred: true, starredCheckedAt: stale }), {
			statePath,
		});
		const { runGh } = ghRecorder(() => notFound());
		await maybeShowLaunchStarReminder(
			{
				confirm: async () => false,
			},
			{ statePath, now: () => now, runGh },
		);
		const state = await readStarReminderStateUnlocked(statePath);
		expect(state.starred).toBe(false);
		expect(state.declined).toBe(true);
	});

	it("declined + unavailable gh checks once per session, not per prompt", async () => {
		const statePath = await makeStatePath();
		await recordDeclinedAfterNo({ statePath });
		const { runGh, calls } = ghRecorder(() => ({ exitCode: -1, stdout: "", stderr: "gh not found" }));
		const contributor = createStarReminderBeforeAgentStartContributor(
			{ getSessionId: () => "session-a" },
			{ statePath, runGh },
		);
		expect(await contributor({ prompt: "1", sessionId: "session-a" })).toBeUndefined();
		expect(await contributor({ prompt: "2", sessionId: "session-a" })).toBeUndefined();
		expect(calls).toHaveLength(1);
	});
});
