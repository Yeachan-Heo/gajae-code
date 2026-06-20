import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	activeEntryPath,
	decodeSessionSegment,
	encodeSessionSegment,
	GJC_SESSION_PREFIX,
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

describe("session-layout (pure)", () => {
	it("encodes and decodes session ids, escaping dots", () => {
		expect(encodeSessionSegment("a.b/c")).toBe("a%2Eb%2Fc");
		expect(decodeSessionSegment(encodeSessionSegment("a.b/c"))).toBe("a.b/c");
	});

	it("builds session root and category dirs under .gjc/_session-<id>", () => {
		const root = sessionRoot("/proj", "abc");
		expect(root).toBe(path.join("/proj", ".gjc", "_session-abc"));
		expect(sessionStateDir("/proj", "abc")).toBe(path.join(root, "state"));
		expect(modeStatePath("/proj", "abc", "ralplan")).toBe(path.join(root, "state", "ralplan-state.json"));
		expect(activeEntryPath("/proj", "abc", "ultragoal")).toBe(path.join(root, "state", "active", "ultragoal.json"));
		expect(sessionActivityPath("/proj", "abc")).toBe(path.join(root, ".session-activity.json"));
		expect(transactionJournalPath("/proj", "abc", "m:1")).toBe(
			path.join(root, "state", "transactions", `${encodeSessionSegment("m:1")}.json`),
		);
	});

	it("rejects a blank session id at path-build time", () => {
		expect(() => sessionRoot("/proj", "  ")).toThrow();
	});

	it("rejects traversal in dynamic single-segment components (mode, slug)", () => {
		expect(() => modeStatePath("/proj", "abc", "../../escape")).toThrow();
		expect(() => modeStatePath("/proj", "abc", "a/b")).toThrow();
		expect(() => tmuxRuntimeSessionPath("/proj", "abc", "../../escape")).toThrow();
		expect(() => tmuxRuntimeSessionPath("/proj", "abc", "a\\b")).toThrow();
		expect(modeStatePath("/proj", "abc", "deep-interview")).toBe(
			path.join("/proj", ".gjc", "_session-abc", "state", "deep-interview-state.json"),
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

	it("write resolution refuses a missing id", () => {
		expect(() => resolveGjcSessionForWrite("/proj", {})).toThrow(SessionResolutionError);
		expect(resolveGjcSessionForWrite("/proj", { envSessionId: "e" }).source).toBe("env");
	});

	it("read resolution errors when zero session dirs exist", async () => {
		const cwd = await tempDir();
		await expect(resolveGjcSessionForRead(cwd, {})).rejects.toThrow(/no active GJC session/);
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
