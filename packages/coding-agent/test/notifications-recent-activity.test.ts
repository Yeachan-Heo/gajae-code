import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { listRecentSessions } from "@gajae-code/coding-agent/notifications/recent-activity";

const roots: string[] = [];
function tempSessionsRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-recent-"));
	roots.push(root);
	return root;
}
afterAll(() => {
	for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

function writeSession(
	root: string,
	project: string,
	id: string,
	header: object,
	mtimeMs: number,
	entries: object[] = [{ type: "message" }],
): string {
	const dir = path.join(root, project);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${id}.jsonl`);
	fs.writeFileSync(file, `${JSON.stringify(header)}\n${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
	fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
	return file;
}

describe("recent-activity picker", () => {
	it("ranks sessions by history mtime, newest first", () => {
		const root = tempSessionsRoot();
		writeSession(root, "repoA", "old", { cwd: "/repoA" }, 1_000_000);
		writeSession(root, "repoB", "newer", { cwd: "/repoB", branch: "feat/x" }, 3_000_000);
		writeSession(root, "repoA", "mid", { cwd: "/repoA", title: "fix bug" }, 2_000_000);

		const out = listRecentSessions({ sessionsRoot: root });
		expect(out.map(e => e.sessionId)).toEqual(["newer", "mid", "old"]);
		expect(out[0]?.path).toBe("/repoB");
		expect(out[0]?.branch).toBe("feat/x");
		expect(out[1]?.title).toBe("fix bug");
		expect(out[0]?.sessionStateFile.endsWith("newer.jsonl")).toBe(true);
	});

	it("respects the limit", () => {
		const root = tempSessionsRoot();
		for (let i = 0; i < 5; i++) writeSession(root, "r", `s${i}`, { cwd: "/r" }, 1000 * (i + 1));
		expect(listRecentSessions({ sessionsRoot: root, limit: 2 })).toHaveLength(2);
	});

	it("flags breadcrumb-referenced sessions as currentTerminal", () => {
		const root = tempSessionsRoot();
		const file = writeSession(root, "r", "live", { cwd: "/r" }, 5000);
		writeSession(root, "r", "other", { cwd: "/r" }, 4000);
		const out = listRecentSessions({ sessionsRoot: root, breadcrumbPaths: [file] });
		expect(out.find(e => e.sessionId === "live")?.currentTerminal).toBe(true);
		expect(out.find(e => e.sessionId === "other")?.currentTerminal).toBeUndefined();
	});

	it("returns empty for a missing root and tolerates bad headers", () => {
		expect(listRecentSessions({ sessionsRoot: "/no/such/dir" })).toEqual([]);
		const root = tempSessionsRoot();
		writeSession(root, "r", "bad", "not json" as unknown as object, 1000);
		const out = listRecentSessions({ sessionsRoot: root });
		expect(out).toHaveLength(1);
		expect(out[0]?.path).toBeUndefined();
	});

	it("marks internal helper sessions and can exclude them", () => {
		const root = tempSessionsRoot();
		writeSession(root, "r", "user", { cwd: "/r" }, 2000);
		writeSession(root, "r", "helper", { cwd: "/r" }, 3000, [
			{ type: "session_init", systemPrompt: "subagent", initialTask: "help" },
		]);

		const defaultOut = listRecentSessions({ sessionsRoot: root });
		expect(defaultOut.map(e => e.sessionId)).toEqual(["helper", "user"]);
		expect(defaultOut.find(e => e.sessionId === "helper")?.internal).toBe(true);
		expect(defaultOut.find(e => e.sessionId === "user")?.internal).toBeUndefined();

		const visibleOnly = listRecentSessions({ sessionsRoot: root, includeInternal: false });
		expect(visibleOnly.map(e => e.sessionId)).toEqual(["user"]);
	});

	it("filters internal sessions before applying the limit", () => {
		const root = tempSessionsRoot();
		writeSession(root, "r", "older-visible", { cwd: "/r" }, 1000);
		writeSession(root, "r", "newer-visible", { cwd: "/r" }, 2000);
		writeSession(root, "r", "newest-helper", { cwd: "/r" }, 3000, [{ type: "session_init" }]);

		const out = listRecentSessions({ sessionsRoot: root, limit: 2, includeInternal: false });
		expect(out.map(e => e.sessionId)).toEqual(["newer-visible", "older-visible"]);
	});
	it("surfaces the authoritative header id (not the timestamped filename stem)", () => {
		const root = tempSessionsRoot();
		// SessionManager writes <isoTimestamp>_<id>.jsonl with the id in the header.
		writeSession(root, "r", "2024-01-02T03-04-05-678Z_s-lifecycle-1", { id: "s-lifecycle-1", cwd: "/r" }, 9000);
		// A timestamped file with no header id falls back to the stripped stem.
		writeSession(root, "r", "2024-01-02T03-04-05-999Z_s-fallback-2", { cwd: "/r" }, 8000);
		const out = listRecentSessions({ sessionsRoot: root });
		expect(out.map(e => e.sessionId)).toEqual(["s-lifecycle-1", "s-fallback-2"]);
	});
});
