/**
 * `report_issue` — local auto-QA for tool behavior.
 *
 * The model records a tool whose output contradicts that tool's own
 * description. Reports are appended to a local SQLite database
 * (`~/.gjc/tool-issues.db`); nothing leaves the machine. Inspect them with the
 * read tool's SQLite support, e.g.
 * `gjc read '~/.gjc/tool-issues.db?q=SELECT tool, count(*) FROM tool_issues GROUP BY tool'`.
 *
 * Inspired by oh-my-pi's `xd://report_issue` auto-QA device; collector push
 * and consent prompts are intentionally not part of this local-only port.
 */
import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool, AgentToolResult } from "@gajae-code/agent-core";
import { getToolIssuesDbPath, logger, prompt, VERSION } from "@gajae-code/utils";
import * as z from "zod/v4";
import reportIssueDescription from "../prompts/tools/report-issue.md" with { type: "text" };
import type { ToolSession } from "./index";
import { ToolError } from "./tool-errors";

/** Upper bound on the stored tool name, in UTF-8 bytes. */
const MAX_TOOL_BYTES = 128;
/** Upper bound on the stored report body, in characters. */
const MAX_REPORT_CHARS = 4_000;

const reportIssueSchema = z.object({
	tool: z.string().describe("name of the tool that misbehaved"),
	report: z.string().describe("what was called, what was expected, what happened"),
});

export type ReportIssueToolInput = z.infer<typeof reportIssueSchema>;

export interface ReportIssueToolDetails {
	recorded: boolean;
	tool: string;
}

export interface ToolIssueEntry {
	tool: string;
	report: string;
	model: string | null;
	sessionId: string | null;
}

/**
 * Open the database for a single report. Reports are rare, so no connection is cached: a file the
 * user deleted is recreated on the next report, and no handle keeps the file locked between reports.
 */
async function openToolIssueDb(dbPath: string): Promise<Database> {
	// Only a directory created here gets 0700; an existing shared config/data root keeps its mode.
	await fs.mkdir(path.dirname(dbPath), { recursive: true, mode: 0o700 });
	// Create (or tighten) the database file before SQLite opens it. SQLite's unix VFS creates the
	// WAL/SHM sidecars with the main file's permissions, so they are private from their first byte.
	const handle = await fs.open(dbPath, "a", 0o600);
	try {
		if (process.platform !== "win32") await handle.chmod(0o600);
	} finally {
		await handle.close();
	}
	const db = new Database(dbPath);
	try {
		db.run(`
			PRAGMA busy_timeout=5000;
			PRAGMA journal_mode=WAL;
			CREATE TABLE IF NOT EXISTS tool_issues (
				id          INTEGER PRIMARY KEY AUTOINCREMENT,
				created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
				tool        TEXT    NOT NULL,
				report      TEXT    NOT NULL,
				model       TEXT,
				gjc_version TEXT    NOT NULL,
				session_id  TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_tool_issues_tool_created ON tool_issues(tool, created_at);
		`);
	} catch (error) {
		db.close();
		throw error;
	}
	return db;
}

function truncateUtf8(text: string, maxBytes: number): string {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= maxBytes) return text;
	// Decoding a cut multi-byte sequence yields U+FFFD; drop it.
	return bytes
		.subarray(0, maxBytes)
		.toString("utf8")
		.replace(/\uFFFD+$/u, "");
}

/**
 * Truncate text by complete Unicode code points, avoiding incomplete surrogate pairs.
 * JavaScript strings use UTF-16 encoding, where astral characters use two code units
 * (high surrogate + low surrogate). We must count actual code points, not UTF-16 code units.
 */
function truncateByCodePoint(text: string, maxChars: number): string {
	let codePointCount = 0;
	let result = "";
	// Iterate through actual code points using for-of, which handles surrogate pairs correctly
	for (const codePoint of text) {
		if (codePointCount >= maxChars) break;
		result += codePoint;
		codePointCount++;
	}
	return result;
}

function codePointLength(text: string): number {
	let count = 0;
	for (const _ of text) count++;
	return count;
}

/** Normalize and clamp a report to the stored field limits. */
export function normalizeToolIssue(tool: string, report: string): { tool: string; report: string } {
	const normalizedTool = truncateUtf8(tool.trim(), MAX_TOOL_BYTES);
	const trimmedReport = report.trim();
	const normalizedReport =
		codePointLength(trimmedReport) > MAX_REPORT_CHARS
			? `${truncateByCodePoint(trimmedReport, MAX_REPORT_CHARS - 1)}…`
			: trimmedReport;
	return { tool: normalizedTool, report: normalizedReport };
}

/** Append one report to the tool-issue database at `dbPath`. */
export async function recordToolIssue(dbPath: string, entry: ToolIssueEntry): Promise<void> {
	const db = await openToolIssueDb(dbPath);
	try {
		db.run("INSERT INTO tool_issues (tool, report, model, gjc_version, session_id) VALUES (?, ?, ?, ?, ?)", [
			entry.tool,
			entry.report,
			entry.model,
			VERSION,
			entry.sessionId,
		]);
	} finally {
		db.close();
	}
}

export class ReportIssueTool implements AgentTool<typeof reportIssueSchema, ReportIssueToolDetails> {
	readonly name = "report_issue";
	readonly label = "Report Issue";
	readonly loadMode = "essential" as const;
	readonly description = prompt.render(reportIssueDescription);
	readonly parameters = reportIssueSchema;
	readonly strict = true;
	readonly intent = "omit" as const;
	readonly #session: ToolSession;
	readonly #dbPath: string;

	constructor(session: ToolSession, dbPath: string = getToolIssuesDbPath()) {
		this.#session = session;
		this.#dbPath = dbPath;
	}

	async execute(_toolCallId: string, params: ReportIssueToolInput): Promise<AgentToolResult<ReportIssueToolDetails>> {
		const { tool, report } = normalizeToolIssue(params.tool, params.report);
		if (!tool) throw new ToolError("tool must name the tool that misbehaved.");
		if (!report) throw new ToolError("report must describe the unexpected behavior.");
		try {
			await recordToolIssue(this.#dbPath, {
				tool,
				report,
				model: this.#session.getActiveModelString?.() ?? null,
				sessionId: this.#session.getSessionId?.() ?? null,
			});
		} catch (error) {
			logger.warn("report_issue: failed to record tool issue", { error: String(error), dbPath: this.#dbPath });
			return {
				content: [{ type: "text", text: "Report could not be stored locally; continue the task." }],
				details: { recorded: false, tool },
			};
		}
		return {
			content: [{ type: "text", text: "Recorded. Continue the task." }],
			details: { recorded: true, tool },
		};
	}
}
