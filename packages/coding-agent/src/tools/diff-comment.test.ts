import { describe, expect, it } from "vitest";
import type { ToolSession } from ".";
import { DiffCommentTool, formatDiffCommentsForContext, getDiffComments } from "./diff-comment";

// Mock ToolSession
class MockToolSession implements ToolSession {
	private runtimeValues = new Map<string, unknown>();

	getRuntimeValue<T>(key: string): T | undefined {
		return this.runtimeValues.get(key) as T | undefined;
	}

	setRuntimeValue(key: string, value: unknown): void {
		this.runtimeValues.set(key, value);
	}

	getSessionId(): string {
		return "test-session";
	}

	getSessionFile(): string {
		return "/tmp/test-session.json";
	}
}

function createMockContext(session: ToolSession) {
	return {
		session,
		settings: {} as any,
		cwd: "/tmp/test",
		signal: new AbortSignal(),
	};
}

describe("DiffCommentTool", () => {
	it("should add a comment to a file and line range", async () => {
		const session = new MockToolSession();
		const tool = new DiffCommentTool();
		const ctx = createMockContext(session);

		const result = await tool.execute(
			"call-1",
			{
				op: "add",
				path: "src/main.ts",
				start_line: 10,
				end_line: 15,
				comment: "This logic looks wrong",
			} as any,
			undefined,
			undefined,
			ctx as any,
		);

		expect(result.content).toBeDefined();
		expect(result.content[0].type).toBe("text");
		expect((result.content[0] as any).text).toContain("Added comment");
		expect(result.details?.comments?.length).toBe(1);
		expect(result.details?.comments?.[0].path).toBe("src/main.ts");
		expect(result.details?.comments?.[0].startLine).toBe(10);
		expect(result.details?.comments?.[0].endLine).toBe(15);
		expect(result.details?.comments?.[0].body).toBe("This logic looks wrong");
		expect(result.details?.comments?.[0].status).toBe("draft");
	});

	it("should resolve a comment", async () => {
		const session = new MockToolSession();
		const tool = new DiffCommentTool();
		const ctx = createMockContext(session);

		// Add a comment first
		const addResult = await tool.execute(
			"call-1",
			{
				op: "add",
				path: "src/main.ts",
				start_line: 10,
				end_line: 15,
				comment: "This logic looks wrong",
			} as any,
			undefined,
			undefined,
			ctx as any,
		);

		const commentId = addResult.details?.comments?.[0].id;
		expect(commentId).toBeDefined();

		// Resolve it
		const resolveResult = await tool.execute(
			"call-2",
			{
				op: "resolve",
				comment_id: commentId,
				note: "Fixed the logic",
			} as any,
			undefined,
			undefined,
			ctx as any,
		);

		expect((resolveResult.content[0] as any).text).toContain("Resolved comment");
		expect((resolveResult.content[0] as any).text).toContain("Fixed the logic");
	});

	it("should list comments", async () => {
		const session = new MockToolSession();
		const tool = new DiffCommentTool();
		const ctx = createMockContext(session);

		// Add two comments
		await tool.execute(
			"call-1",
			{
				op: "add",
				path: "src/main.ts",
				start_line: 10,
				end_line: 15,
				comment: "First comment",
			} as any,
			undefined,
			undefined,
			ctx as any,
		);

		await tool.execute(
			"call-2",
			{
				op: "add",
				path: "src/utils.ts",
				start_line: 5,
				end_line: 8,
				comment: "Second comment",
			} as any,
			undefined,
			undefined,
			ctx as any,
		);

		// Resolve the first one
		const comments = getDiffComments(session);
		const firstId = comments[0].id;
		await tool.execute(
			"call-3",
			{
				op: "resolve",
				comment_id: firstId,
			} as any,
			undefined,
			undefined,
			ctx as any,
		);

		// List them
		const listResult = await tool.execute(
			"call-4",
			{
				op: "list",
			} as any,
			undefined,
			undefined,
			ctx as any,
		);

		const text = (listResult.content[0] as any).text;
		expect(text).toContain("Unresolved comments");
		expect(text).toContain("Resolved comments");
		expect(text).toContain("Second comment");
		expect(listResult.details?.comments?.length).toBe(2);
	});

	it("should validate line ranges", async () => {
		const session = new MockToolSession();
		const tool = new DiffCommentTool();
		const ctx = createMockContext(session);

		// startLine < 1 should fail
		try {
			await tool.execute(
				"call-1",
				{
					op: "add",
					path: "src/main.ts",
					start_line: 0,
					end_line: 5,
					comment: "Invalid range",
				} as any,
				undefined,
				undefined,
				ctx as any,
			);
			expect.fail("Should have thrown");
		} catch (error: any) {
			expect(error.message).toContain("startLine must be >= 1");
		}

		// endLine < startLine should fail
		try {
			await tool.execute(
				"call-2",
				{
					op: "add",
					path: "src/main.ts",
					start_line: 10,
					end_line: 5,
					comment: "Invalid range",
				} as any,
				undefined,
				undefined,
				ctx as any,
			);
			expect.fail("Should have thrown");
		} catch (error: any) {
			expect(error.message).toContain("endLine must be >= startLine");
		}
	});

	it("should require operation-specific fields", async () => {
		const session = new MockToolSession();
		const tool = new DiffCommentTool();
		const ctx = createMockContext(session);

		// Missing path for add
		try {
			await tool.execute(
				"call-1",
				{
					op: "add",
					start_line: 10,
					end_line: 15,
					comment: "Test",
				} as any,
				undefined,
				undefined,
				ctx as any,
			);
			expect.fail("Should have thrown");
		} catch (error: any) {
			expect(error.message).toContain("path is required");
		}

		// Missing comment_id for resolve
		try {
			await tool.execute(
				"call-2",
				{
					op: "resolve",
					note: "Test note",
				} as any,
				undefined,
				undefined,
				ctx as any,
			);
			expect.fail("Should have thrown");
		} catch (error: any) {
			expect(error.message).toContain("comment_id is required");
		}
	});

	it("should format comments for context", () => {
		const comments = [
			{
				id: "abc123",
				path: "src/main.ts",
				startLine: 10,
				endLine: 15,
				body: "This looks wrong",
				status: "draft" as const,
				createdAt: "2026-01-01T00:00:00Z",
			},
			{
				id: "def456",
				path: "src/main.ts",
				startLine: 20,
				endLine: 25,
				body: "Fix this too",
				status: "draft" as const,
				createdAt: "2026-01-01T00:00:00Z",
			},
		];

		const formatted = formatDiffCommentsForContext(comments);
		expect(formatted).toBeDefined();
		expect(formatted).toContain("Pending diff comments");
		expect(formatted).toContain("abc123");
		expect(formatted).toContain("def456");
		expect(formatted).toContain("src/main.ts");
		expect(formatted).toContain("This looks wrong");
		expect(formatted).toContain("Fix this too");
	});

	it("should return null when formatting resolved comments", () => {
		const comments = [
			{
				id: "abc123",
				path: "src/main.ts",
				startLine: 10,
				endLine: 15,
				body: "Already resolved",
				status: "resolved" as const,
				createdAt: "2026-01-01T00:00:00Z",
				resolvedNote: "Fixed",
			},
		];

		const formatted = formatDiffCommentsForContext(comments);
		expect(formatted).toBeNull();
	});
});
