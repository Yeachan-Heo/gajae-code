import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionIndex, type SessionIndexEvent } from "../src/sdk/broker/session-index";
import { SESSION_INDEX_SNAPSHOT_VERSION } from "../src/sdk/broker/state-version";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

// Issue #4250: on Windows, fsync (FlushFileBuffers) rejects a file handle opened
// read-only with EPERM, so snapshot publication must sync through a writable
// handle (replaceAtomically -> writeAndSync) and must never leak the temp file.
// The Windows dev-ci job (windows-dev-doctor) is required whenever this file or
// session-index.ts changes; see scripts/ci-dev-affected.ts.
describe.skipIf(process.platform !== "win32")("Windows session-index snapshot fsync (#4250)", () => {
	it("publishes and re-publishes the snapshot without EPERM or temp leftovers", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-index-fsync-"));
		temporaryDirectories.push(root);
		const sessionsDir = path.join(root, "sdk", "sessions");
		const snapshotFile = path.join(sessionsDir, "index.snapshot.json");

		const index = await new SessionIndex(root).open();
		await index.append({
			type: "host_registered",
			sessionId: "win",
			locator: { repo: "r", stateRoot: "q" },
			endpointGeneration: 1,
			pid: process.pid,
			hostIncarnation: "windows-ci-seam",
		});
		await index.snapshot();

		let snapshot = JSON.parse(await fs.readFile(snapshotFile, "utf8")) as {
			version: number;
			indexSeq: number;
			events: SessionIndexEvent[];
		};
		expect(snapshot.version).toBe(SESSION_INDEX_SNAPSHOT_VERSION);
		expect(snapshot.events.map(event => event.sessionId)).toEqual(["win"]);

		// Re-publish over the existing snapshot: exercises the atomic replace
		// (writeAndSync + rename + directory fsync) on top of a present snapshot.
		await index.append({
			type: "host_registered",
			sessionId: "win2",
			locator: { repo: "r", stateRoot: "q" },
			endpointGeneration: 1,
			pid: process.pid,
			hostIncarnation: "windows-ci-seam",
		});
		await index.snapshot();

		snapshot = JSON.parse(await fs.readFile(snapshotFile, "utf8")) as {
			version: number;
			indexSeq: number;
			events: SessionIndexEvent[];
		};
		expect(snapshot.indexSeq).toBe(2);
		expect(snapshot.events.map(event => event.sessionId).sort()).toEqual(["win", "win2"]);

		// Compaction also publishes a snapshot through the same path.
		await index.compact();
		snapshot = JSON.parse(await fs.readFile(snapshotFile, "utf8")) as {
			version: number;
			indexSeq: number;
			events: SessionIndexEvent[];
		};
		expect(snapshot.indexSeq).toBe(2);

		// Publication must not leave temp artifacts behind.
		const entries = await fs.readdir(sessionsDir);
		expect(entries.filter(name => name.endsWith(".tmp"))).toEqual([]);
	});
});
