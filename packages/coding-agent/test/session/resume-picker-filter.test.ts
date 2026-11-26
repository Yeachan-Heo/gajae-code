import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	excludeMetadataOnlySessions,
	isMetadataOnlyTranscript,
	RESUME_PICKER_METADATA_SCAN_BYTES,
} from "../../src/session/resume-picker-filter";
import { resolveResumableSession, type SessionInfo, SessionManager } from "../../src/session/session-manager";

const TIMESTAMP = "2026-11-24T00:00:00.000Z";

function jsonl(records: readonly object[]): string {
	return `${records.map(record => JSON.stringify(record)).join("\n")}\n`;
}

function header(id: string, cwd: string, extra: Record<string, unknown> = {}): object {
	return { type: "session", id, version: 5, cwd, timestamp: TIMESTAMP, starredPatchVersion: 1, ...extra };
}

function modelChange(id: string, parentId: string | null, model = "test/model"): object {
	return { type: "model_change", id, parentId, timestamp: TIMESTAMP, model, role: "default" };
}

const thinkingChange = {
	type: "thinking_level_change",
	id: "e2",
	parentId: "e1",
	timestamp: TIMESTAMP,
	thinkingLevel: "low",
};
const serviceTierChange = {
	type: "service_tier_change",
	id: "e3",
	parentId: "e2",
	timestamp: TIMESTAMP,
	serviceTier: "priority",
};
const configuredModelChain = {
	type: "configured_model_chain",
	id: "e4",
	parentId: null,
	timestamp: TIMESTAMP,
	role: "default",
	chain: ["test/model"],
};
const userMessage = {
	type: "message",
	id: "m1",
	parentId: "e2",
	timestamp: TIMESTAMP,
	message: { role: "user", content: [{ type: "text", text: "fix the flaky test" }], timestamp: 1 },
};
const handoffMessage = {
	type: "custom_message",
	id: "h1",
	parentId: "e2",
	timestamp: TIMESTAMP,
	customType: "handoff",
	content: "Continue the refactor from the previous session.",
	display: false,
};
const customEntry = {
	type: "custom",
	id: "c1",
	parentId: "e2",
	timestamp: TIMESTAMP,
	customType: "workflow-intent-diff",
	data: {},
};

describe("isMetadataOnlyTranscript", () => {
	const cwd = "/work";

	it("accepts a header followed only by supported pre-conversation control records", () => {
		expect(isMetadataOnlyTranscript(jsonl([header("a", cwd), modelChange("e1", null), thinkingChange]))).toBe(true);
		expect(isMetadataOnlyTranscript(jsonl([header("a", cwd), serviceTierChange]))).toBe(true);
		expect(isMetadataOnlyTranscript(jsonl([header("a", cwd), configuredModelChain]))).toBe(true);
	});

	it("keeps a header-only transcript, which has no startup metadata", () => {
		expect(isMetadataOnlyTranscript(jsonl([header("a", cwd)]))).toBe(false);
		expect(isMetadataOnlyTranscript("")).toBe(false);
	});

	it("treats conversation and context-bearing records as content", () => {
		const startup = [header("a", cwd), modelChange("e1", null), thinkingChange];
		expect(isMetadataOnlyTranscript(jsonl([...startup, userMessage]))).toBe(false);
		expect(isMetadataOnlyTranscript(jsonl([...startup, handoffMessage]))).toBe(false);
		expect(isMetadataOnlyTranscript(jsonl([...startup, customEntry]))).toBe(false);
	});

	it("treats unknown record types and header patches as content", () => {
		const startup = [header("a", cwd), modelChange("e1", null)];
		expect(isMetadataOnlyTranscript(jsonl([...startup, { type: "future_record", id: "f1" }]))).toBe(false);
		expect(isMetadataOnlyTranscript(jsonl([...startup, { type: "header_patch", patch: { cwd } }]))).toBe(false);
		expect(isMetadataOnlyTranscript(jsonl([...startup, { id: "no-type" }]))).toBe(false);
	});

	it("keeps records outside the supported control set, such as mode and tool selections", () => {
		const startup = [header("a", cwd), modelChange("e1", null)];
		expect(isMetadataOnlyTranscript(jsonl([...startup, { type: "mode_change", id: "x1", mode: "plan" }]))).toBe(
			false,
		);
		expect(isMetadataOnlyTranscript(jsonl([...startup, { type: "mcp_tool_selection", id: "x2" }]))).toBe(false);
		expect(isMetadataOnlyTranscript(jsonl([...startup, { type: "label", id: "x3", targetId: "e1" }]))).toBe(false);
	});

	it("reads CRLF line endings the same as LF", () => {
		const records = [header("a", cwd), modelChange("e1", null), thinkingChange];
		const crlf = `${records.map(record => JSON.stringify(record)).join("\r\n")}\r\n`;
		expect(isMetadataOnlyTranscript(crlf)).toBe(true);
		expect(isMetadataOnlyTranscript(`${crlf}${JSON.stringify(userMessage)}\r\n`)).toBe(false);
	});

	it("requires the first record to be the session header", () => {
		expect(isMetadataOnlyTranscript(jsonl([modelChange("e1", null), header("a", cwd)]))).toBe(false);
		expect(isMetadataOnlyTranscript("null\n")).toBe(false);
	});

	it("treats an unparseable line, such as a record still being appended, as content", () => {
		const startup = jsonl([header("a", cwd), modelChange("e1", null)]);
		expect(isMetadataOnlyTranscript(`${startup}{"type":"message","id":"m1","mess`)).toBe(false);
	});
});

describe("excludeMetadataOnlySessions", () => {
	let root: string;
	let cwd: string;
	let sessionDir: string;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-resume-picker-filter-"));
		cwd = path.join(root, "work");
		sessionDir = path.join(root, "sessions");
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(sessionDir, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	async function writeSession(name: string, records: readonly object[]): Promise<string> {
		const file = path.join(sessionDir, `${name}.jsonl`);
		await Bun.write(file, jsonl(records));
		return file;
	}

	async function listPickerIds(): Promise<string[]> {
		const listed = await SessionManager.listForResumePickerReadOnly(cwd, sessionDir);
		return (await excludeMetadataOnlySessions(listed)).map(session => session.id);
	}

	function startup(id: string, extra: Record<string, unknown> = {}): object[] {
		return [header(id, cwd, extra), modelChange("e1", null), thinkingChange];
	}

	it("hides a startup-only session and keeps a real conversation (#8028 repro)", async () => {
		await writeSession("startup-only_aaa111", startup("aaa111"));
		await writeSession("real_bbb222", [header("bbb222", cwd), userMessage]);

		expect((await SessionManager.listForResumePickerReadOnly(cwd, sessionDir)).map(s => s.id).sort()).toEqual([
			"aaa111",
			"bbb222",
		]);
		expect(await listPickerIds()).toEqual(["bbb222"]);
	});

	it("keeps header-only, handoff, named, and starred sessions", async () => {
		await writeSession("header-only", [header("header-only", cwd)]);
		await writeSession("handoff", [...startup("handoff"), handoffMessage]);
		await writeSession("named", startup("named", { title: "Planning notes" }));
		await writeSession("starred", startup("starred", { starred: true }));
		await writeSession("startup-only", startup("startup-only"));

		expect((await listPickerIds()).sort()).toEqual(["handoff", "header-only", "named", "starred"]);
	});

	it("finds a message that lies beyond the listing's 4 KiB prefix", async () => {
		const padding = Array.from({ length: 40 }, (_, index) =>
			modelChange(`pad${index}`, null, `provider/${"x".repeat(100)}-${index}`),
		);
		const file = await writeSession("late-message", [header("late-message", cwd), ...padding, userMessage]);
		const [listed] = await SessionManager.listForResumePickerReadOnly(cwd, sessionDir);
		expect(listed?.messageCount).toBe(0);
		expect(listed?.messageCountIsEstimate).toBe(true);
		expect((await fs.stat(file)).size).toBeLessThan(RESUME_PICKER_METADATA_SCAN_BYTES);

		expect(await listPickerIds()).toEqual(["late-message"]);
	});

	it("hides a startup-only session larger than the listing prefix but within the scan bound", async () => {
		const controls = Array.from({ length: 40 }, (_, index) =>
			modelChange(`c${index}`, null, `provider/${"y".repeat(100)}-${index}`),
		);
		await writeSession("large-startup", [header("large-startup", cwd), ...controls]);

		expect(await listPickerIds()).toEqual([]);
	});

	it("keeps a session over the scan bound without reading it in full", async () => {
		const controls = Array.from({ length: 700 }, (_, index) =>
			modelChange(`c${index}`, null, `provider/${"z".repeat(100)}-${index}`),
		);
		const file = await writeSession("over-bound", [header("over-bound", cwd), ...controls]);
		expect((await fs.stat(file)).size).toBeGreaterThan(RESUME_PICKER_METADATA_SCAN_BYTES);

		expect(await listPickerIds()).toEqual(["over-bound"]);
	});

	it("keeps a session that grew past the scan bound after it was listed", async () => {
		const file = await writeSession("growing", startup("growing"));
		const listed = await SessionManager.listForResumePickerReadOnly(cwd, sessionDir);
		const growth = Array.from({ length: 700 }, (_, index) =>
			modelChange(`g${index}`, null, `provider/${"w".repeat(100)}-${index}`),
		);
		await fs.appendFile(file, jsonl(growth));

		expect((await excludeMetadataOnlySessions(listed)).map(session => session.id)).toEqual(["growing"]);
	});

	it("keeps a session whose transcript cannot be read", async () => {
		const missing: SessionInfo = {
			path: path.join(sessionDir, "missing.jsonl"),
			id: "missing",
			cwd,
			starred: false,
			created: new Date(0),
			modified: new Date(0),
			messageCount: 0,
			size: 0,
			firstMessage: "(no messages)",
			allMessagesText: "",
		};

		expect(await excludeMetadataOnlySessions([missing])).toEqual([missing]);
	});

	it("keeps the input order of the sessions it keeps", async () => {
		await writeSession("first", [header("first", cwd), userMessage]);
		await writeSession("hidden", startup("hidden"));
		await writeSession("second", [header("second", cwd), userMessage]);
		const listed = await SessionManager.listForResumePickerReadOnly(cwd, sessionDir);
		const expected = listed.filter(session => session.id !== "hidden");

		expect(await excludeMetadataOnlySessions(listed)).toEqual(expected);
	});

	it("leaves the generic inventories and explicit ID resolution unfiltered", async () => {
		const file = await writeSession("startup-only", startup("startup-only"));

		expect((await SessionManager.list(cwd, sessionDir)).map(session => session.id)).toEqual(["startup-only"]);
		expect((await SessionManager.listForResumePickerReadOnly(cwd, sessionDir)).map(s => s.id)).toEqual([
			"startup-only",
		]);
		const resolved = await resolveResumableSession("startup-only", cwd, sessionDir);
		expect(resolved?.session.path).toBe(file);
	});
});
