/**
 * Session ownership under the default mode on Windows (design §7.4 G1, Windows row).
 *
 * The native file lock has no Windows implementation yet, so every claim must fail open: the
 * session is created, appended to, closed and reopened as if ownership were off, each claim
 * attempt counts `fail_open`, nothing counts `claim_failed`, the owners report still reads, and the
 * counts reach the stats database. The other ownership suites skip Windows; this one runs only there.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readSessionOwnershipStats } from "@gajae-code/stats/session-ownership";
import { sessionClaimSetOf } from "../../src/session/internal/session-claim-set";
import { SessionManager } from "../../src/session/session-manager";
import {
	inspectSessionOwners,
	persistSessionOwnershipCounters,
	resetSessionOwnershipForTests,
	SessionOwnershipTestHooks,
	sessionOwnershipCounters,
} from "../../src/session/session-ownership";
import { sessionOwnershipMode } from "../../src/session/session-ownership-mode";

const roots: string[] = [];

afterEach(async () => {
	delete SessionOwnershipTestHooks.statsDbPath;
	resetSessionOwnershipForTests();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function user(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

describe.skipIf(process.platform !== "win32")("session ownership on Windows, default mode", () => {
	it("fails open on every claim: sessions open, write and reopen, and the counts are recorded", async () => {
		expect(SessionOwnershipTestHooks.mode).toBeUndefined();
		expect(sessionOwnershipMode()).toBe("observe");

		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-ownership-win-")));
		roots.push(root);
		const cwd = path.join(root, "workspace");
		const agentDir = path.join(root, "agent");
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(agentDir, { recursive: true });
		const destination = SessionManager.managedDestination(cwd, agentDir);

		const created = SessionManager.create(cwd, destination);
		created.appendMessage(user("first"));
		created.appendMessage(user("second"));
		await created.ensureOnDisk();
		await created.flush();
		const file = created.getSessionFile();
		expect(file).toBeDefined();
		expect(sessionClaimSetOf(created).sessionIds).toEqual([]);
		await created.close();

		const reopened = await SessionManager.open(file!, destination);
		expect(reopened.buildSessionContext().messages).toHaveLength(2);
		reopened.appendMessage(user("third"));
		await reopened.flush();
		expect(sessionClaimSetOf(reopened).sessionIds).toEqual([]);
		await reopened.close();
		expect(await Bun.file(file!).text()).toContain('"third"');

		const counts = sessionOwnershipCounters();
		expect(counts.fail_open).toBeGreaterThanOrEqual(2);
		expect(counts.claim_failed).toBe(0);
		expect(counts.claim_taken).toBe(0);
		expect(counts.claim_conflict).toBe(0);

		const inventory = await inspectSessionOwners();
		expect(inventory.held).toEqual([]);

		// The write the exit handler makes, to a stats database the test owns.
		const dbPath = path.join(root, "stats.db");
		SessionOwnershipTestHooks.statsDbPath = dbPath;
		persistSessionOwnershipCounters();
		const db = new Database(dbPath, { readonly: true });
		try {
			expect(readSessionOwnershipStats(db)?.counters.fail_open).toBe(counts.fail_open);
		} finally {
			db.close();
		}
	});
});
