import { afterAll, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { appendEvent, sessionPaths, writeSessionState } from "../../src/harness-control-plane/storage";
import {
	type EventEnvelope,
	SESSION_SCHEMA_VERSION,
	type SessionHandle,
	type SessionState,
} from "../../src/harness-control-plane/types";

// Mode bits and final-component symlinks are POSIX. Windows ACLs are out of scope.
const skipPosix = process.platform === "win32";
const execFileAsync = promisify(execFile);

function hasMkfifo(): boolean {
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		try {
			accessSync(path.join(dir, "mkfifo"), fsConstants.X_OK);
			return true;
		} catch {
			// keep looking
		}
	}
	return false;
}
const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-harness-mode-"));
	tempRoots.push(dir);
	return dir;
}

afterAll(async () => {
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function state(sessionId: string): SessionState {
	const now = "2026-01-01T00:00:00.000Z";
	return {
		schemaVersion: SESSION_SCHEMA_VERSION,
		sessionId,
		lifecycle: "started",
		harness: "gajae-code",
		handle: { sessionId, harness: "gajae-code", workspace: "." } as SessionHandle,
		retries: {},
		blockers: [],
		createdAt: now,
		updatedAt: now,
	};
}

function envelope(cursor: number, sessionId: string): EventEnvelope {
	return {
		eventId: `e-${cursor}`,
		cursor,
		createdAt: "2026-01-01T00:00:00.000Z",
		severity: "info",
		kind: "test",
		state: { sessionId, lifecycle: "started", harness: "gajae-code", ownerLive: false, blockers: [] },
		evidence: {},
		nextAllowedActions: [],
		writer: { ownerId: "owner-1", leaseEpoch: 1 },
	};
}

async function modeOf(filePath: string): Promise<number> {
	return (await fs.lstat(filePath)).mode & 0o777;
}

describe("harness storage mode", () => {
	it.skipIf(skipPosix)("refuses a symlink session directory", async () => {
		const root = await tempDir();
		const outside = path.join(root, "outside");
		await fs.mkdir(outside);
		const dir = sessionPaths(root, "h-link").dir;
		await fs.mkdir(path.dirname(dir));
		await fs.symlink(outside, dir);

		await expect(writeSessionState(root, state("h-link"))).rejects.toThrow(/not a directory/);
		expect(await fs.readdir(outside)).toEqual([]);
		expect((await fs.lstat(dir)).isSymbolicLink()).toBe(true);
	});

	it.skipIf(skipPosix || !hasMkfifo())("refuses a FIFO state.json and leaves it in place", async () => {
		const root = await tempDir();
		const paths = sessionPaths(root, "h-fifo");
		await fs.mkdir(paths.dir, { recursive: true });
		await execFileAsync("mkfifo", [paths.state]);

		await expect(writeSessionState(root, state("h-fifo"))).rejects.toThrow(/not a regular file/);
		expect((await fs.lstat(paths.state)).isFIFO()).toBe(true);
	});

	it.skipIf(skipPosix)("refuses a symlink state.json", async () => {
		const root = await tempDir();
		const outside = path.join(root, "outside.json");
		await fs.writeFile(outside, "kept");
		await writeSessionState(root, state("h-state"));
		const file = sessionPaths(root, "h-state").state;
		await fs.rm(file);
		await fs.symlink(outside, file);

		await expect(writeSessionState(root, state("h-state"))).rejects.toThrow(/not a regular file/);
		expect(await fs.readFile(outside, "utf8")).toBe("kept");
		expect((await fs.lstat(file)).isSymbolicLink()).toBe(true);
	});

	it.skipIf(skipPosix)("refuses a symlink events.jsonl", async () => {
		const root = await tempDir();
		const outside = path.join(root, "outside.jsonl");
		await fs.writeFile(outside, "kept");
		await writeSessionState(root, state("h-events"));
		const file = sessionPaths(root, "h-events").events;
		await fs.symlink(outside, file);

		await expect(appendEvent(root, "h-events", envelope(1, "h-events"))).rejects.toThrow(/not a regular file/);
		expect(await fs.readFile(outside, "utf8")).toBe("kept");
		expect((await fs.lstat(file)).isSymbolicLink()).toBe(true);
	});

	it.skipIf(skipPosix)("creates session state and events as mode 0600 under a permissive umask", async () => {
		const previous = process.umask(0);
		try {
			const root = await tempDir();
			await writeSessionState(root, state("h-umask"));
			await appendEvent(root, "h-umask", envelope(1, "h-umask"));
			const paths = sessionPaths(root, "h-umask");
			expect(await modeOf(paths.dir)).toBe(0o700);
			expect(await modeOf(paths.state)).toBe(0o600);
			expect(await modeOf(paths.events)).toBe(0o600);
		} finally {
			process.umask(previous);
		}
	});

	it.skipIf(skipPosix)("tightens an existing mode 0666 state.json to 0600", async () => {
		const root = await tempDir();
		const paths = sessionPaths(root, "h-open-state");
		await fs.mkdir(paths.dir, { recursive: true, mode: 0o700 });
		await fs.writeFile(paths.state, "{}\n", { mode: 0o666 });
		await fs.chmod(paths.state, 0o666);

		await writeSessionState(root, state("h-open-state"));

		expect(await modeOf(paths.state)).toBe(0o600);
		expect(await fs.readFile(paths.state, "utf8")).toContain('"sessionId": "h-open-state"');
	});

	it.skipIf(skipPosix)("tightens an existing mode 0666 events.jsonl to 0600", async () => {
		const root = await tempDir();
		const paths = sessionPaths(root, "h-open-events");
		await fs.mkdir(paths.dir, { recursive: true, mode: 0o700 });
		await fs.writeFile(paths.events, "", { mode: 0o666 });
		await fs.chmod(paths.events, 0o666);

		await appendEvent(root, "h-open-events", envelope(1, "h-open-events"));

		expect(await modeOf(paths.events)).toBe(0o600);
		expect(await fs.readFile(paths.events, "utf8")).toContain('"eventId":"e-1"');
	});

	it.skipIf(skipPosix)("tightens an existing mode 0777 session directory to 0700", async () => {
		const root = await tempDir();
		const paths = sessionPaths(root, "h-open-dir");
		await fs.mkdir(paths.dir, { recursive: true });
		await fs.chmod(paths.dir, 0o777);

		await writeSessionState(root, state("h-open-dir"));

		expect(await modeOf(paths.dir)).toBe(0o700);
		expect(await modeOf(paths.state)).toBe(0o600);
	});

	it.skipIf(skipPosix || process.getuid?.() === 0)(
		"still allows state and events in a mode 0300 directory",
		async () => {
			const root = await tempDir();
			const paths = sessionPaths(root, "h-0300");
			await fs.mkdir(paths.dir, { recursive: true, mode: 0o700 });
			await fs.chmod(paths.dir, 0o300);
			try {
				await writeSessionState(root, state("h-0300"));
				await appendEvent(root, "h-0300", envelope(1, "h-0300"));
				expect(await fs.readFile(paths.state, "utf8")).toContain('"sessionId": "h-0300"');
				expect(await fs.readFile(paths.events, "utf8")).toContain('"cursor":1');
			} finally {
				await fs.chmod(paths.dir, 0o700);
			}
		},
	);

	it("still allows a second event append on a regular file", async () => {
		const root = await tempDir();
		await writeSessionState(root, state("h-append"));
		await appendEvent(root, "h-append", envelope(1, "h-append"));
		await appendEvent(root, "h-append", envelope(2, "h-append"));
		const text = await fs.readFile(sessionPaths(root, "h-append").events, "utf8");
		expect(text).toContain('"cursor":1');
		expect(text).toContain('"cursor":2');
	});

	it("still allows rewriting session state on a regular file", async () => {
		const root = await tempDir();
		await writeSessionState(root, state("h-rewrite"));
		await writeSessionState(root, { ...state("h-rewrite"), lifecycle: "completed" });
		expect(await fs.readFile(sessionPaths(root, "h-rewrite").state, "utf8")).toContain('"completed"');
	});

	it.skipIf(skipPosix)("still allows session state through a symlinked root", async () => {
		const root = await tempDir();
		const real = path.join(root, "real");
		await fs.mkdir(real);
		const via = path.join(root, "via");
		await fs.symlink(real, via);

		await writeSessionState(via, state("h-via"));

		expect(await fs.readFile(sessionPaths(real, "h-via").state, "utf8")).toContain('"sessionId": "h-via"');
	});
});
