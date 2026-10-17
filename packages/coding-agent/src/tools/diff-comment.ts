/**
 * Diff Comment Tool - Leave structured comments on specific diff lines.
 *
 * Inspired by JetBrains/thinkrail (Apache-2.0):
 * https://github.com/JetBrains/thinkrail
 *
 * Use this tool to annotate specific lines in the current working-tree diff
 * with comments, then resolve them after you've addressed them.
 */

import { randomUUID } from "node:crypto";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@gajae-code/agent-core";
import { prompt } from "@gajae-code/utils";
import * as z from "zod/v4";
import diffCommentDescription from "../prompts/tools/diff-comment.md" with { type: "text" };
import type { ToolSession } from ".";
import type { OutputMeta } from "./output-meta";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

// =============================================================================
// Types
// =============================================================================

/** A comment anchored to a specific file and line range in the working-tree diff. */
export interface DiffComment {
	id: string;
	/** File path relative to cwd */
	path: string;
	/** Starting line number (1-based) */
	startLine: number;
	/** Ending line number (1-based, inclusive) */
	endLine: number;
	/** Comment text */
	body: string;
	/** Status: draft (not yet sent) or resolved */
	status: "draft" | "resolved";
	/** When the comment was created (ISO 8601) */
	createdAt: string;
	/** Optional note describing what was done about this comment */
	resolvedNote?: string;
}

/** Session-level diff comments store */
export interface DiffCommentStore {
	comments: Map<string, DiffComment>;
}

const diffCommentSchema = z.object({
	op: z.enum(["add", "resolve", "list"]).describe("Operation: add, resolve, or list comments"),
	path: z.string().optional().describe("File path (required for add)"),
	start_line: z.number().int().positive().optional().describe("Starting line number, 1-based (required for add)"),
	end_line: z.number().int().positive().optional().describe("Ending line number, 1-based (required for add)"),
	comment: z.string().optional().describe("Comment text (required for add)"),
	comment_id: z.string().optional().describe("Comment ID to resolve (required for resolve)"),
	note: z.string().optional().describe("Brief note on resolution (optional for resolve)"),
});

type DiffCommentParams = z.infer<typeof diffCommentSchema>;

export interface DiffCommentToolDetails {
	comments?: DiffComment[];
	resolved?: { id: string; note?: string };
	meta?: OutputMeta;
}

// =============================================================================
// Store management
// =============================================================================

const STORES = new Map<string, DiffCommentStore>();

function getStore(session: ToolSession): DiffCommentStore {
	const sessionId = session.getSessionId?.() ?? "default";
	let store = STORES.get(sessionId);
	if (!store) {
		store = { comments: new Map() };
		STORES.set(sessionId, store);
	}
	return store;
}

function validateLineRange(startLine: number, endLine: number): void {
	if (startLine < 1) throw new ToolError("startLine must be >= 1");
	if (endLine < startLine) throw new ToolError("endLine must be >= startLine");
}

// =============================================================================
// Tool implementation
// =============================================================================

export class DiffCommentTool implements AgentTool<typeof diffCommentSchema, DiffCommentToolDetails> {
	readonly name = "diff_comment";
	readonly label = "Diff Comment";
	readonly summary = "Add comments to specific lines in the current diff or resolve them";
	readonly parameters = diffCommentSchema;
	readonly description: string;

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(diffCommentDescription);
	}

	async execute(
		_toolCallId: string,
		params: DiffCommentParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<DiffCommentToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<DiffCommentToolDetails>> {
		const session = this.session;
		const store = getStore(session);

		// Operation: add
		if (params.op === "add") {
			if (!params.path) throw new ToolError('path is required for op: "add"');
			if (params.start_line === undefined) throw new ToolError('start_line is required for op: "add"');
			if (params.end_line === undefined) throw new ToolError('end_line is required for op: "add"');
			if (!params.comment) throw new ToolError('comment is required for op: "add"');

			validateLineRange(params.start_line, params.end_line);

			const comment: DiffComment = {
				id: randomUUID().slice(0, 8),
				path: params.path,
				startLine: params.start_line,
				endLine: params.end_line,
				body: params.comment,
				status: "draft",
				createdAt: new Date().toISOString(),
			};

			store.comments.set(comment.id, comment);

			return toolResult<DiffCommentToolDetails>({ comments: [comment] })
				.text(`Added comment ${comment.id} to ${params.path}:${params.start_line}-${params.end_line}`)
				.done();
		}

		// Operation: resolve
		if (params.op === "resolve") {
			if (!params.comment_id) throw new ToolError('comment_id is required for op: "resolve"');

			const comment = store.comments.get(params.comment_id);
			if (!comment) throw new ToolError(`Comment ${params.comment_id} not found`);
			if (comment.status === "resolved") {
				throw new ToolError(`Comment ${params.comment_id} is already resolved`);
			}

			comment.status = "resolved";
			comment.resolvedNote = params.note;

			return toolResult<DiffCommentToolDetails>({ resolved: { id: params.comment_id, note: params.note } })
				.text(`Resolved comment ${params.comment_id}${params.note ? ` (${params.note})` : ""}`)
				.done();
		}

		// Operation: list
		if (params.op === "list") {
			const comments = Array.from(store.comments.values());
			const draftComments = comments.filter(c => c.status === "draft");
			const resolvedComments = comments.filter(c => c.status === "resolved");

			const lines: string[] = [];
			if (draftComments.length > 0) {
				lines.push(`Unresolved comments (${draftComments.length}):`);
				for (const comment of draftComments) {
					lines.push(`  ${comment.id}: ${comment.path}:${comment.startLine}-${comment.endLine}`);
					lines.push(`     ${comment.body}`);
				}
			} else {
				lines.push("No unresolved comments.");
			}

			if (resolvedComments.length > 0) {
				lines.push("");
				lines.push(`Resolved comments (${resolvedComments.length}):`);
				for (const comment of resolvedComments) {
					lines.push(`  ${comment.id}: ${comment.path}:${comment.startLine}-${comment.endLine}`);
					lines.push(`     ${comment.body}`);
					if (comment.resolvedNote) {
						lines.push(`     → ${comment.resolvedNote}`);
					}
				}
			}

			return toolResult<DiffCommentToolDetails>({ comments }).text(lines.join("\n")).done();
		}

		throw new ToolError(`Unknown operation: ${params.op}`);
	}
}

// =============================================================================
// Exports
// =============================================================================

export function getDiffComments(session: ToolSession): DiffComment[] {
	const store = getStore(session);
	return Array.from(store.comments.values());
}

export function formatDiffCommentsForContext(comments: DiffComment[]): string | null {
	const draftComments = comments.filter(c => c.status === "draft");
	if (draftComments.length === 0) return null;

	const lines: string[] = [];
	lines.push("## Pending diff comments");
	lines.push("");
	lines.push(
		"You have unresolved comments on the current diff. " +
			"Review them and call diff_comment with op: resolve for each one you address.",
	);
	lines.push("");

	for (const comment of draftComments) {
		lines.push(`### Comment ${comment.id}`);
		lines.push(`**File:** \`${comment.path}\`  `);
		lines.push(`**Lines:** ${comment.startLine}–${comment.endLine}`);
		lines.push("");
		lines.push(comment.body);
		lines.push("");
	}

	return lines.join("\n");
}
