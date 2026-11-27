/**
 * Opening a transcript path that has no session yet initializes a fresh session at that
 * exact path: a single header line whose id is the manager's id. Covers the explicit open
 * with and without session memory, and a staged attempt, which all reach the
 * fresh-transcript branch of `#initSessionFile`. A missing file is never admitted to the
 * bounded (sidecar) path, so session memory only changes which caller routes it there.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { FileSessionStorage } from "@gajae-code/coding-agent/session/session-storage";

const tempDirs: string[] = [];
const managers: SessionManager[] = [];

afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.close().catch(() => undefined);
	for (const dir of tempDirs.splice(0)) await fs.promises.rm(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gjc-fresh-transcript-")));
	tempDirs.push(dir);
	return dir;
}

function readLines(file: string): Record<string, unknown>[] {
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter(line => line.length > 0)
		.map(line => JSON.parse(line) as Record<string, unknown>);
}

function expectFreshTranscript(manager: SessionManager, file: string): void {
	expect(manager.getSessionFile()).toBe(file);
	const lines = readLines(file);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toMatchObject({ type: "session", id: manager.getSessionId(), cwd: manager.getCwd() });
	expect(manager.getEntries()).toEqual([]);
}

describe("fresh transcript initialization at a missing path", () => {
	it("explicit eager open writes one header for the new session id", async () => {
		const file = path.join(makeTempDir(), "missing.jsonl");
		const manager = await SessionManager.open(file);
		managers.push(manager);
		expectFreshTranscript(manager, file);
	});

	it("open with session memory enabled writes the same single header", async () => {
		const file = path.join(makeTempDir(), "missing-bounded.jsonl");
		const manager = await SessionManager.open(file, undefined, new FileSessionStorage(), "copy-retain", "enabled");
		managers.push(manager);
		expectFreshTranscript(manager, file);
	});

	it("two opens of different missing paths get different session ids", async () => {
		const dir = makeTempDir();
		const first = await SessionManager.open(path.join(dir, "a.jsonl"));
		const second = await SessionManager.open(path.join(dir, "b.jsonl"));
		managers.push(first, second);
		expect(first.getSessionId()).not.toBe(second.getSessionId());
	});

	it("a staged attempt initializes its staged transcript, not the final path", async () => {
		const finalFile = path.join(makeTempDir(), "final.jsonl");
		const manager = await SessionManager.openStaged(finalFile);
		managers.push(manager);
		const staged = manager.getSessionFile();
		expect(staged).toBeDefined();
		expect(staged).not.toBe(finalFile);
		expect(fs.existsSync(finalFile)).toBe(false);
		const lines = readLines(staged!);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({ type: "session", id: manager.getSessionId() });
		await manager.discardStaged();
	});
});
