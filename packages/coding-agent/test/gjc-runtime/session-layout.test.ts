import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	activeEntryPath,
	canonicalSessionRoot,
	decodeSessionSegment,
	encodeSessionSegment,
	GJC_SESSION_PREFIX,
	gjcSessionsRoot,
	legacySessionRoot,
	modeStatePath,
	sessionActivityPath,
	sessionIdFromDirName,
	sessionRoot,
	sessionStateDir,
	tmuxRuntimeSessionPath,
	transactionJournalPath,
} from "@gajae-code/coding-agent/gjc-runtime/session-layout";
import {
	detectLatestSession,
	resolveGjcSessionForRead,
	resolveGjcSessionForWrite,
	resolveSessionIdFromSources,
	SessionResolutionError,
	writeSessionActivityMarker,
} from "@gajae-code/coding-agent/gjc-runtime/session-resolution";

const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-session-layout-"));
	tempRoots.push(dir);
	return dir;
}

afterAll(async () => {
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("session-layout", () => {
	it("encodes and decodes session ids, escaping dots", () => {
		expect(encodeSessionSegment("a.b/c")).toBe("a%2Eb%2Fc");
		expect(decodeSessionSegment(encodeSessionSegment("a.b/c"))).toBe("a.b/c");
	});

	it("builds canonical session roots and category dirs under .gjc/sessions/_session-<id>", () => {
		const root = canonicalSessionRoot("/proj", "abc");
		expect(gjcSessionsRoot("/proj")).toBe(path.join("/proj", ".gjc", "sessions"));
		expect(root).toBe(path.join("/proj", ".gjc", "sessions", "_session-abc"));
		expect(legacySessionRoot("/proj", "abc")).toBe(path.join("/proj", ".gjc", "_session-abc"));
		expect(sessionRoot("/proj", "abc")).toBe(root);
		expect(sessionStateDir("/proj", "abc")).toBe(path.join(root, "state"));
		expect(modeStatePath("/proj", "abc", "ralplan")).toBe(path.join(root, "state", "ralplan-state.json"));
		expect(activeEntryPath("/proj", "abc", "ultragoal")).toBe(path.join(root, "state", "active", "ultragoal.json"));
		expect(sessionActivityPath("/proj", "abc")).toBe(path.join(root, ".session-activity.json"));
		expect(transactionJournalPath("/proj", "abc", "m:1")).toBe(
			path.join(root, "state", "transactions", `${encodeSessionSegment("m:1")}.json`),
		);
	});

	it("rejects a blank session id at path-build time", () => {
		expect(() => canonicalSessionRoot("/proj", "  ")).toThrow();
	});

	it("rejects traversal in dynamic single-segment components (mode, slug)", () => {
		expect(() => modeStatePath("/proj", "abc", "../../escape")).toThrow();
		expect(() => modeStatePath("/proj", "abc", "a/b")).toThrow();
		expect(() => tmuxRuntimeSessionPath("/proj", "abc", "../../escape")).toThrow();
		expect(() => tmuxRuntimeSessionPath("/proj", "abc", "a\\b")).toThrow();
		expect(modeStatePath("/proj", "abc", "deep-interview")).toBe(
			path.join("/proj", ".gjc", "sessions", "_session-abc", "state", "deep-interview-state.json"),
		);
	});

	it("recovers session id from a _session-* dir name and rejects invalid names", () => {
		expect(sessionIdFromDirName(`${GJC_SESSION_PREFIX}abc`)).toBe("abc");
		expect(sessionIdFromDirName(`${GJC_SESSION_PREFIX}a%2Eb`)).toBe("a.b");
		expect(sessionIdFromDirName("state")).toBeUndefined();
		expect(sessionIdFromDirName(GJC_SESSION_PREFIX)).toBeUndefined();
	});
});

describe("session-resolution (boundary)", () => {
	it("resolves precedence flag > payload > env", () => {
		expect(resolveSessionIdFromSources({ flagValue: "f", payloadSessionId: "p", envSessionId: "e" })).toEqual({
			gjcSessionId: "f",
			source: "flag",
		});
		expect(resolveSessionIdFromSources({ payloadSessionId: "p", envSessionId: "e" })).toEqual({
			gjcSessionId: "p",
			source: "payload",
		});
		expect(resolveSessionIdFromSources({ envSessionId: "e" })).toEqual({ gjcSessionId: "e", source: "env" });
		expect(resolveSessionIdFromSources({})).toBeUndefined();
	});

	it("treats a blank explicit flag as invalid", () => {
		expect(() => resolveSessionIdFromSources({ flagValue: "  " })).toThrow(SessionResolutionError);
	});

	it("ignores blank payload/env (falls through)", () => {
		expect(resolveSessionIdFromSources({ payloadSessionId: "  ", envSessionId: "e" })).toEqual({
			gjcSessionId: "e",
			source: "env",
		});
	});

	it("write resolution refuses a missing id and creates no root during resolution", async () => {
		const cwd = await tempDir();
		expect(() => resolveGjcSessionForWrite(cwd, {})).toThrow(SessionResolutionError);
		const session = resolveGjcSessionForWrite(cwd, { envSessionId: "e" });
		expect(session).toMatchObject({
			gjcSessionId: "e",
			layout: "canonical",
			sessionRoot: canonicalSessionRoot(cwd, "e"),
			source: "env",
		});
		await expect(fs.stat(session.sessionRoot)).rejects.toThrow();
	});
	it("selects an existing legacy root for explicit reads and writes", async () => {
		const cwd = await tempDir();
		const root = legacySessionRoot(cwd, "legacy");
		await fs.mkdir(root, { recursive: true });
		expect(resolveGjcSessionForWrite(cwd, { flagValue: "legacy" })).toMatchObject({
			layout: "legacy",
			sessionRoot: root,
		});
		expect(sessionRoot(cwd, "legacy")).toBe(root);
		expect(sessionStateDir(cwd, "legacy")).toBe(path.join(root, "state"));
		expect(await resolveGjcSessionForRead(cwd, { flagValue: "legacy" })).toMatchObject({
			layout: "legacy",
			sessionRoot: root,
		});
	});

	it("selects an existing canonical root for explicit reads and writes", async () => {
		const cwd = await tempDir();
		const root = canonicalSessionRoot(cwd, "canonical");
		await fs.mkdir(root, { recursive: true });
		expect(resolveGjcSessionForWrite(cwd, { flagValue: "canonical" })).toMatchObject({
			layout: "canonical",
			sessionRoot: root,
		});
		expect(await resolveGjcSessionForRead(cwd, { flagValue: "canonical" })).toMatchObject({
			layout: "canonical",
			sessionRoot: root,
		});
	});

	it("fails closed for duplicate canonical and legacy roots before marker writes", async () => {
		const cwd = await tempDir();
		await Promise.all([
			fs.mkdir(canonicalSessionRoot(cwd, "duplicate"), { recursive: true }),
			fs.mkdir(legacySessionRoot(cwd, "duplicate"), { recursive: true }),
		]);
		expect(() => resolveGjcSessionForWrite(cwd, { flagValue: "duplicate" })).toThrow(
			'duplicate GJC session roots for session id "duplicate"',
		);
		expect(() => sessionRoot(cwd, "duplicate")).toThrow('duplicate GJC session roots for session id "duplicate"');
		await expect(writeSessionActivityMarker(cwd, "duplicate", { writer: "test" })).rejects.toThrow(
			'duplicate GJC session roots for session id "duplicate"',
		);
		await expect(
			fs.stat(path.join(canonicalSessionRoot(cwd, "duplicate"), ".session-activity.json")),
		).rejects.toThrow();
		await expect(fs.stat(path.join(legacySessionRoot(cwd, "duplicate"), ".session-activity.json"))).rejects.toThrow();
	});

	it("read resolution errors when zero session dirs exist", async () => {
		const cwd = await tempDir();
		await expect(resolveGjcSessionForRead(cwd, {})).rejects.toThrow(/no active GJC session/);
	});
	it("fails closed when an activity marker cannot be read", async () => {
		const cwd = await tempDir();
		const root = canonicalSessionRoot(cwd, "unreadable-marker");
		await fs.mkdir(path.join(root, ".session-activity.json"), { recursive: true });
		await expect(resolveGjcSessionForRead(cwd, {})).rejects.toThrow();
	});
	it("rejects invalid and non-canonical session-root entries during latest discovery", async () => {
		for (const [name, kind] of [
			[`${GJC_SESSION_PREFIX}plain-file`, "file"],
			[`${GJC_SESSION_PREFIX}%`, "directory"],
			[`${GJC_SESSION_PREFIX}%61`, "directory"],
		] as const) {
			const cwd = await tempDir();
			const candidate = path.join(gjcSessionsRoot(cwd), name);
			await fs.mkdir(path.dirname(candidate), { recursive: true });
			if (kind === "file") await fs.writeFile(candidate, "not a session directory");
			else await fs.mkdir(candidate);
			await expect(resolveGjcSessionForRead(cwd, {})).rejects.toThrow(/invalid GJC session root entry/);
		}
	});

	it("auto-detects the latest session by activity marker, not raw dir mtime", async () => {
		const cwd = await tempDir();
		await writeSessionActivityMarker(cwd, "old", { writer: "test" });
		await new Promise(r => setTimeout(r, 1100));
		await writeSessionActivityMarker(cwd, "new", { writer: "test" });
		const ctx = await detectLatestSession(cwd);
		expect(ctx.gjcSessionId).toBe("new");
		expect(ctx.source).toBe("latest");
	});
	it("auto-detects the latest session across canonical and legacy roots", async () => {
		const cwd = await tempDir();
		const legacyRoot = legacySessionRoot(cwd, "legacy");
		await fs.mkdir(legacyRoot, { recursive: true });
		await fs.writeFile(
			path.join(legacyRoot, ".session-activity.json"),
			`${JSON.stringify({ updated_at: "2020-01-01T00:00:00.000Z" })}\n`,
		);
		const canonicalRoot = canonicalSessionRoot(cwd, "canonical");
		await fs.mkdir(canonicalRoot, { recursive: true });
		await fs.writeFile(
			path.join(canonicalRoot, ".session-activity.json"),
			`${JSON.stringify({ updated_at: "2021-01-01T00:00:00.000Z" })}\n`,
		);
		await expect(detectLatestSession(cwd)).resolves.toMatchObject({
			gjcSessionId: "canonical",
			layout: "canonical",
			sessionRoot: canonicalRoot,
		});
	});

	it("errors on an ambiguous (near-tie) latest session", async () => {
		const cwd = await tempDir();
		await writeSessionActivityMarker(cwd, "a", { writer: "test" });
		await writeSessionActivityMarker(cwd, "b", { writer: "test" });
		await expect(detectLatestSession(cwd)).rejects.toThrow(/ambiguous latest session/);
	});

	it("ignores session dirs without an activity marker", async () => {
		const cwd = await tempDir();
		await fs.mkdir(sessionStateDir(cwd, "no-marker"), { recursive: true });
		await writeSessionActivityMarker(cwd, "marked", { writer: "test" });
		const ctx = await detectLatestSession(cwd);
		expect(ctx.gjcSessionId).toBe("marked");
	});
});
