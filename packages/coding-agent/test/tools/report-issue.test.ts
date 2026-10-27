import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { VERSION } from "@gajae-code/utils";
import { BUILTIN_TOOL_DESCRIPTORS, type ToolSession } from "../../src/tools";
import { normalizeToolIssue, ReportIssueTool, recordToolIssue } from "../../src/tools/report-issue";
import { TOOL_CATALOG } from "../../src/tools/tool-catalog.generated";
import { ToolError } from "../../src/tools/tool-errors";

interface StoredIssue {
	tool: string;
	report: string;
	model: string | null;
	gjc_version: string;
	session_id: string | null;
	created_at: string;
}

function makeSession(settings: Record<string, unknown> = {}, extra: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: { get: (key: string) => settings[key], has: (key: string) => Object.hasOwn(settings, key) },
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		...extra,
	} as unknown as ToolSession;
}

function readIssues(dbPath: string): StoredIssue[] {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db
			.query("SELECT tool, report, model, gjc_version, session_id, created_at FROM tool_issues ORDER BY id")
			.all() as StoredIssue[];
	} finally {
		db.close();
	}
}

describe("report_issue tool", () => {
	let root: string;
	let dbPath: string;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-report-issue-"));
		dbPath = path.join(root, "nested", "tool-issues.db");
	});

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	test("appends a report with model, session, and version to the local database", async () => {
		const tool = new ReportIssueTool(
			makeSession({}, { getActiveModelString: () => "openai/gpt-5.5", getSessionId: () => "session-1" }),
			dbPath,
		);

		const first = await tool.execute("call-1", {
			tool: " search ",
			report: " paths filter ignored; matched files outside src ",
		});
		await tool.execute("call-2", { tool: "read", report: "range selector returned the whole file" });

		expect(first.details).toEqual({ recorded: true, tool: "search" });
		expect(first.content).toEqual([{ type: "text", text: "Recorded. Continue the task." }]);
		const rows = readIssues(dbPath);
		expect(rows.map(row => [row.tool, row.report])).toEqual([
			["search", "paths filter ignored; matched files outside src"],
			["read", "range selector returned the whole file"],
		]);
		expect(rows[0]).toMatchObject({ model: "openai/gpt-5.5", gjc_version: VERSION, session_id: "session-1" });
		expect(rows[0].created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		if (process.platform !== "win32") expect((await fs.stat(dbPath)).mode & 0o777).toBe(0o600);
	});

	test("stores null model and session when the session exposes neither", async () => {
		await new ReportIssueTool(makeSession(), dbPath).execute("call", { tool: "bash", report: "exit code lost" });

		expect(readIssues(dbPath)[0]).toMatchObject({ model: null, session_id: null });
	});

	test("rejects blank tool names and reports without writing", async () => {
		const tool = new ReportIssueTool(makeSession(), dbPath);

		await expect(tool.execute("call", { tool: "  ", report: "x" })).rejects.toBeInstanceOf(ToolError);
		await expect(tool.execute("call", { tool: "read", report: "\n\t" })).rejects.toBeInstanceOf(ToolError);
		expect(await Bun.file(dbPath).exists()).toBe(false);
	});

	test("reports a storage failure to the model instead of throwing", async () => {
		const blocker = path.join(root, "blocker");
		await Bun.write(blocker, "not a directory");

		const result = await new ReportIssueTool(makeSession(), path.join(blocker, "tool-issues.db")).execute("call", {
			tool: "write",
			report: "content dropped",
		});

		expect(result.details).toEqual({ recorded: false, tool: "write" });
		expect(result.content).toEqual([
			{ type: "text", text: "Report could not be stored locally; continue the task." },
		]);
	});

	test("releases its connection after every report, including concurrent first reports", async () => {
		const entry = { tool: "read", report: "r", model: null, sessionId: null };
		await Promise.all([recordToolIssue(dbPath, entry), recordToolIssue(dbPath, entry)]);

		expect(readIssues(dbPath)).toHaveLength(2);
		// Leaving WAL mode needs exclusive access; a leftover connection keeps the database locked.
		const db = new Database(dbPath);
		try {
			expect(db.query("PRAGMA journal_mode=DELETE").get()).toEqual({ journal_mode: "delete" });
		} finally {
			db.close();
		}
	});

	test("records into a fresh database after the user deletes the file", async () => {
		const entry = { tool: "read", report: "r", model: null, sessionId: null };
		await recordToolIssue(dbPath, entry);
		await fs.rm(dbPath);

		await recordToolIssue(dbPath, { ...entry, report: "after delete" });

		expect(readIssues(dbPath).map(issue => issue.report)).toEqual(["after delete"]);
	});
});

describe("normalizeToolIssue", () => {
	test("clamps the tool name to 128 UTF-8 bytes without splitting a code point", () => {
		const { tool } = normalizeToolIssue(`${"a".repeat(127)}가나`, "r");

		expect(tool).toBe("a".repeat(127));
		expect(Buffer.byteLength(tool, "utf8")).toBeLessThanOrEqual(128);
	});

	test("caps the report at 4000 characters with an ellipsis", () => {
		const { report } = normalizeToolIssue("read", "x".repeat(5000));

		expect(report).toHaveLength(4000);
		expect(report.endsWith("…")).toBe(true);
		expect(normalizeToolIssue("read", "y".repeat(4000)).report).toBe("y".repeat(4000));
	});

	test("limits reports by code points below, at, and above 4000", () => {
		// 👍 is one code point but two UTF-16 code units.
		expect(normalizeToolIssue("read", "👍".repeat(3000)).report).toBe("👍".repeat(3000));
		expect(normalizeToolIssue("read", "👍".repeat(4000)).report).toBe("👍".repeat(4000));
		expect(normalizeToolIssue("read", "👍".repeat(4001)).report).toBe(`${"👍".repeat(3999)}…`);
		expect(normalizeToolIssue("read", `${"a".repeat(3999)}😀b`).report).toBe(`${"a".repeat(3999)}…`);
	});

	test("respects 0700 directory and 0600 database permissions on creation", async () => {
		if (process.platform === "win32") return; // Skip on Windows

		const testDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-perms-test-"));
		try {
			const newDbPath = path.join(testDir, "deep", "nested", "tool-issues.db");
			const tool = new ReportIssueTool(makeSession(), newDbPath);

			// Execute a report to trigger database creation
			await tool.execute("call-1", { tool: "test", report: "test report" });

			// Verify directory permissions are 0700
			const dirPath = path.dirname(newDbPath);
			const dirStat = await fs.stat(dirPath);
			expect(dirStat.mode & 0o777).toBe(0o700);

			// Verify database file permissions are 0600
			const dbStat = await fs.stat(newDbPath);
			expect(dbStat.mode & 0o777).toBe(0o600);
		} finally {
			await fs.rm(testDir, { recursive: true, force: true });
		}
	});

	test("keeps an existing parent's mode and creates the database and sidecars private", async () => {
		if (process.platform === "win32") return;

		const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-report-shared-"));
		try {
			await fs.chmod(sharedRoot, 0o755);
			const sharedDbPath = path.join(sharedRoot, "tool-issues.db");

			const tool = new ReportIssueTool(makeSession(), sharedDbPath);
			await tool.execute("call-1", { tool: "test", report: "r" });
			// SQLite removes WAL/SHM when the last connection closes; keep one open so they persist.
			const reader = new Database(sharedDbPath);
			try {
				reader.query("SELECT count(*) FROM tool_issues").get();
				await tool.execute("call-2", { tool: "test", report: "r" });

				expect((await fs.stat(sharedRoot)).mode & 0o777).toBe(0o755);
				for (const file of [sharedDbPath, `${sharedDbPath}-wal`, `${sharedDbPath}-shm`]) {
					expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
				}
			} finally {
				reader.close();
			}
		} finally {
			await fs.rm(sharedRoot, { recursive: true, force: true });
		}
	});
});

describe("report_issue availability", () => {
	test("is offered only when reportIssue.enabled is set", () => {
		const descriptor = BUILTIN_TOOL_DESCRIPTORS.report_issue;

		expect(descriptor.isAvailable(makeSession({ "reportIssue.enabled": true }))).toBe(true);
		expect(descriptor.isAvailable(makeSession({ "reportIssue.enabled": false }))).toBe(false);
		expect(descriptor.isAvailable(makeSession())).toBe(false);
	});

	test("is generated as an essential tool", () => {
		expect(TOOL_CATALOG.report_issue?.loadMode).toBe("essential");
		expect(BUILTIN_TOOL_DESCRIPTORS.report_issue.metadata.loadMode).toBe("essential");
	});
});
