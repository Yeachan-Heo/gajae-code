import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { appendCrashEvent } from "@gajae-code/utils";
import { type CrashStatePaths, compactCrashIndex, emptyCrashIndex, readCrashIndex } from "../src/crash/index-store";
import { CRASH_NUDGE_INTERVAL_MS, crashNudgeGate, decideCrashNudge, maybeShowCrashNudge } from "../src/crash/nudge";

const NOW = Date.UTC(2026, 7, 11, 12, 0, 0);
const FP = "0123456789abcdef0123456789abcdef";

function indexWith(
	overrides: Partial<ReturnType<typeof emptyCrashIndex>["signatures"][string]> = {},
	lastNudgedAt = 0,
) {
	const index = emptyCrashIndex();
	index.lastNudgedAt = lastNudgedAt;
	index.signatures[FP] = {
		fpv: 1,
		errorName: "Error",
		messageClass: "shared topic authority unavailable",
		lifetimeCount: 235,
		retainedCount: 3,
		firstSeen: NOW - 10 * 24 * 60 * 60 * 1000,
		lastSeen: NOW - 60_000,
		lastRecordId: "abcdef0123456789",
		...overrides,
	};
	return index;
}

async function tempPaths(): Promise<CrashStatePaths> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-crash-nudge-"));
	return {
		index: path.join(dir, "gjc-crash-index.json"),
		events: path.join(dir, "gjc-crash-events.jsonl"),
		crashLog: path.join(dir, "gjc-crash.log"),
	};
}

describe("crashNudgeGate", () => {
	it("fires only for an enabled, non-quiet, interactive launch", () => {
		expect(crashNudgeGate({ enabled: true, interactive: true, quiet: false })).toBe(true);
		expect(crashNudgeGate({ enabled: false, interactive: true, quiet: false })).toBe(false);
		expect(crashNudgeGate({ enabled: true, interactive: false, quiet: false })).toBe(false);
		expect(crashNudgeGate({ enabled: true, interactive: true, quiet: true })).toBe(false);
	});
});

describe("decideCrashNudge", () => {
	it("reports unreported signatures that gained records since the last nudge", () => {
		const decision = decideCrashNudge(indexWith(), NOW);
		expect(decision.show).toBe(true);
		expect(decision.message).toContain("1 unreported crash signature");
		expect(decision.message).toContain("gjc crash report");
		expect(decision.message).toContain("nothing is sent");
	});

	it("stays silent for reported, dismissed, or unchanged signatures", () => {
		expect(decideCrashNudge(indexWith({ reportedAt: NOW - 1000 }), NOW).show).toBe(false);
		expect(decideCrashNudge(indexWith({ acknowledgedAt: NOW - 1000 }), NOW).show).toBe(false);
		expect(decideCrashNudge(indexWith({}, NOW - 120_000), NOW).show).toBe(false);
	});

	it("rate limits to once per 24h", () => {
		const index = indexWith({}, NOW - CRASH_NUDGE_INTERVAL_MS + 1000);
		expect(decideCrashNudge(index, NOW).show).toBe(false);
		expect(decideCrashNudge(indexWith({}, NOW - CRASH_NUDGE_INTERVAL_MS - 1000), NOW).show).toBe(true);
	});
});

describe("maybeShowCrashNudge", () => {
	it("persists the rate-limit stamp through the journal so a rebuilt index keeps it", async () => {
		const paths = await tempPaths();
		appendCrashEvent(
			{
				kind: "occurrence",
				fingerprint: FP,
				fpv: 1,
				recordId: "abcdef0123456789",
				at: NOW - 60_000,
				errorName: "Error",
				messageClass: "shared topic authority unavailable",
			},
			paths.events,
		);
		const index = await compactCrashIndex({ paths, now: NOW });

		const shown: string[] = [];
		expect(
			await maybeShowCrashNudge(message => shown.push(message), { paths, index, now: () => new Date(NOW) }),
		).toBe(true);
		expect(shown).toHaveLength(1);
		expect((await readCrashIndex(paths)).lastNudgedAt).toBe(NOW);

		// A second launch inside the window stays silent.
		const refreshed = await readCrashIndex(paths);
		expect(
			await maybeShowCrashNudge(message => shown.push(message), {
				paths,
				index: refreshed,
				now: () => new Date(NOW + 1000),
			}),
		).toBe(false);
		expect(shown).toHaveLength(1);
	});

	it("still surfaces the line but reports failure when the stamp cannot be persisted", async () => {
		const paths = await tempPaths();
		await fs.rm(path.dirname(paths.index), { recursive: true, force: true });
		await fs.writeFile(path.dirname(paths.index), "not a directory");
		const shown: string[] = [];
		expect(
			await maybeShowCrashNudge(message => shown.push(message), {
				paths,
				index: indexWith(),
				now: () => new Date(NOW),
			}),
		).toBe(false);
		// The line is best-effort: a broken state dir costs the rate-limit stamp,
		// not the diagnostic.
		expect(shown).toHaveLength(1);
	});
});
