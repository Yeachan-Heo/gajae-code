import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveResumableSession, type SessionInfo } from "@gajae-code/coding-agent/session/session-manager";
import fc from "fast-check";
import { safeRmSync } from "../../../scripts/safe-cleanup";

const PROPERTY_SEED = 4102026;

function referencePrefixMatch(session: { id: string; path: string }, sessionArg: string): boolean {
	const normalizedArg = sessionArg.toLowerCase();
	if (session.id.toLowerCase().startsWith(normalizedArg)) return true;
	const fileName = path.basename(session.path, ".jsonl").toLowerCase();
	if (fileName.startsWith(normalizedArg)) return true;
	const separator = fileName.lastIndexOf("_");
	if (separator < 0) return false;
	return fileName.slice(separator + 1).startsWith(normalizedArg);
}

function info(id: string, file: string): SessionInfo {
	return {
		path: `/sessions/${file}.jsonl`,
		id,
		cwd: "/work",
		starred: false,
		created: new Date(0),
		modified: new Date(0),
		messageCount: 0,
		size: 0,
		firstMessage: "",
		allMessagesText: "",
	};
}

describe("resolveResumableSession exact id", () => {
	let tempDir: string;
	let sessionDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-exact-"));
		sessionDir = path.join(tempDir, "sessions");
		fs.mkdirSync(sessionDir);
	});

	afterEach(() => {
		safeRmSync(tempDir, { recursive: true, force: true });
	});

	function writeSession(fileName: string, id: string, mtimeMs: number): void {
		const filePath = path.join(sessionDir, fileName);
		const header = JSON.stringify({
			type: "session",
			id,
			timestamp: "2025-01-01T00:00:00Z",
			cwd: "/tmp/project",
		});
		const message = JSON.stringify({
			type: "message",
			id: "msg-1",
			parentId: null,
			timestamp: "2025-01-01T00:00:01Z",
			message: { role: "user", content: "hello", timestamp: 1 },
		});
		fs.writeFileSync(filePath, `${header}\n${message}\n`);
		const when = new Date(mtimeMs);
		fs.utimesSync(filePath, when, when);
	}

	it("opens the equal session id ahead of a newer case-variant", async () => {
		writeSession("2020-01-01_exact.jsonl", "victim-session-id", 1_000);
		writeSession("2020-01-02_variant.jsonl", "VICTIM-SESSION-ID", 2_000);
		const match = await resolveResumableSession("victim-session-id", "/tmp/project", sessionDir);
		expect(match?.session.id).toBe("victim-session-id");
		expect(match?.session.path).toBe(path.join(sessionDir, "2020-01-01_exact.jsonl"));
	});

	it("opens the equal session id ahead of a newer longer id", async () => {
		writeSession("2020-01-01_exact.jsonl", "victim-session-id", 1_000);
		writeSession("2020-01-02_longer.jsonl", "victim-session-id-extra", 2_000);
		const match = await resolveResumableSession("victim-session-id", "/tmp/project", sessionDir);
		expect(match?.session.id).toBe("victim-session-id");
	});

	it("opens the equal session id ahead of a newer filename prefix", async () => {
		writeSession("2020-01-01_exact.jsonl", "victim-session-id", 1_000);
		writeSession("2020-01-02_victim-session-id.jsonl", "other-session", 2_000);
		const match = await resolveResumableSession("victim-session-id", "/tmp/project", sessionDir);
		expect(match?.session.id).toBe("victim-session-id");
	});

	it("still allows a shorter session id prefix when no id equals the argument", async () => {
		writeSession("2020-01-01_resume.jsonl", "resume1234", 1_000);
		const match = await resolveResumableSession("resume", "/tmp/project", sessionDir);
		expect(match?.session.id).toBe("resume1234");
	});

	it("still allows a case-insensitive session id prefix when that is the only match", async () => {
		writeSession("2020-01-01_resume.jsonl", "Resume1234", 1_000);
		const match = await resolveResumableSession("resume1234", "/tmp/project", sessionDir);
		expect(match?.session.id).toBe("Resume1234");
	});

	it("property: resume picker prefers an equal session id, seed 4102026, 64 inputs", async () => {
		const mod = await import("@gajae-code/coding-agent/session/session-manager");
		const pick = mod.pickResumableSession;
		if (typeof pick !== "function") throw new Error("pickResumableSession is not exported");
		const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-";
		const token = fc
			.array(fc.constantFrom(...alphabet), { minLength: 1, maxLength: 12 })
			.map(chars => chars.join(""));
		const sessionArb = fc.tuple(token, token).map(([id, file]) => info(id, file));
		fc.assert(
			fc.property(fc.array(sessionArb, { minLength: 0, maxLength: 6 }), token, (sessions, arg) => {
				const picked = pick(sessions, arg);
				const exact = sessions.find(session => session.id === arg);
				if (exact) expect(picked).toBe(exact);
				else expect(picked).toBe(sessions.find(session => referencePrefixMatch(session, arg)));
				expect(pick(sessions, arg)?.id).toBe(picked?.id);
				if (picked) expect(sessions).toContain(picked);
			}),
			{ seed: PROPERTY_SEED, numRuns: 64 },
		);
	});
});
