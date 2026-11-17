import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { GJC_SESSION_ACTIVITY_FILE, sessionRoot } from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import {
	appendLedger,
	HUMAN_BLOCKED_ASK_ANSWERED_EVENT,
	readUltragoalLedger,
	recordUltragoalHumanBlockedAskAnswered,
} from "@gajae-code/coding-agent/gjc-runtime/ultragoal-runtime";

const TEST_SESSION_ID = "test-session";
const tempRoots: string[] = [];

let savedSessionId: string | undefined;

beforeEach(() => {
	savedSessionId = process.env.GJC_SESSION_ID;
	process.env.GJC_SESSION_ID = TEST_SESSION_ID;
});

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "appendledger-test-"));
	tempRoots.push(dir);
	return dir;
}

/** Make the activity-marker write fail: a directory sits where the marker file goes. */
async function breakActivityMarker(cwd: string): Promise<string> {
	const markerPath = path.join(sessionRoot(cwd, TEST_SESSION_ID), GJC_SESSION_ACTIVITY_FILE);
	await fs.mkdir(markerPath, { recursive: true });
	return markerPath;
}

afterEach(async () => {
	if (savedSessionId === undefined) delete process.env.GJC_SESSION_ID;
	else process.env.GJC_SESSION_ID = savedSessionId;
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("appendLedger activity marker contract", () => {
	it("writes the row and advances the marker", async () => {
		const dir = await tempDir();
		const entry = await appendLedger(dir, { event: "test", data: "test-data" }, TEST_SESSION_ID);

		expect(entry.event).toBe("test");
		const ledger = await readUltragoalLedger(dir, TEST_SESSION_ID);
		expect(ledger.map(row => row.eventId)).toEqual([entry.eventId]);
		const marker = JSON.parse(
			await fs.readFile(path.join(sessionRoot(dir, TEST_SESSION_ID), GJC_SESSION_ACTIVITY_FILE), "utf-8"),
		);
		expect(marker.session_id).toBe(TEST_SESSION_ID);
		expect(marker.writer).toBe("ultragoal-runtime");
	});

	it("fails a generic append when the marker write fails", async () => {
		const dir = await tempDir();
		await breakActivityMarker(dir);

		// State commands rely on this rejection: implicit session resolution reads the
		// marker, so reporting success here would leave it stale.
		await expect(appendLedger(dir, { event: "blocker_classified" }, TEST_SESSION_ID)).rejects.toThrow();
	});

	it("settles an ask whose row committed before the marker write failed", async () => {
		const dir = await tempDir();
		await breakActivityMarker(dir);
		const receipt = { cwd: dir, sessionId: TEST_SESSION_ID, classificationEventId: "classification-1" };

		// The row is durable, so settlement reports the decision it committed.
		await expect(recordUltragoalHumanBlockedAskAnswered(receipt)).resolves.toBeUndefined();
		const ledger = await readUltragoalLedger(dir, TEST_SESSION_ID);
		expect(
			ledger.filter(
				row => row.event === HUMAN_BLOCKED_ASK_ANSWERED_EVENT && row.classificationEventId === "classification-1",
			),
		).toHaveLength(1);

		// Settling again sees its own row and appends nothing.
		await expect(recordUltragoalHumanBlockedAskAnswered(receipt)).resolves.toBeUndefined();
		expect(await readUltragoalLedger(dir, TEST_SESSION_ID)).toHaveLength(1);
	});
});
