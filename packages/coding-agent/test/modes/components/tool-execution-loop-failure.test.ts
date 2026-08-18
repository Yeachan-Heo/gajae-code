import { beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { ToolExecutionComponent } from "@gajae-code/coding-agent/modes/components/tool-execution";
import * as themeModule from "@gajae-code/coding-agent/modes/theme/theme";
import type { TUI } from "@gajae-code/tui";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	await themeModule.initTheme(false, undefined, undefined, "red-claw", "blue-crab");
});

const uiStub = { requestRender() {} } as unknown as TUI;

// The exact text the loop reports when it rejects a call before dispatch.
const REJECTION =
	'Tool call "task" spelled non-ASCII text as \\uXXXX escapes instead of literal UTF-8. Re-issue it writing every non-ASCII character literally.';

function renderLoopFailure(toolName: string, args: Record<string, unknown>): string {
	const component = new ToolExecutionComponent(toolName, args, {}, undefined, uiStub);
	component.updateResult(
		{
			content: [{ type: "text", text: REJECTION }],
			details: { failureKind: "argument_validation" },
			isError: true,
		},
		false,
	);
	return Bun.stripANSI(component.render(80).join("\n"));
}

describe("ToolExecutionComponent loop-failure results", () => {
	// Every refused call reports the same two things: that it failed, and why.
	function expectReportedFailure(output: string): void {
		expect(output).not.toContain("render error");
		expect(output).toContain(Bun.stripANSI(themeModule.theme.status.error));
		expect(output).not.toContain(Bun.stripANSI(themeModule.theme.status.success));
		expect(output).toContain("non-ASCII");
	}

	// task's renderer dereferenced `details.results` and threw from the returned
	// closure, escaping the call-site catch and leaving the TUI's `[render error]`
	// line; the throw was traded for a placeholder that dropped the reason.
	it("keeps the rejection reason for a task call the loop refused", () => {
		const output = renderLoopFailure("task", { agent: "architect" });
		expectReportedFailure(output);
		expect(output).not.toContain("Task result details unavailable");
	});

	// search_tool_bm25 dereferences `details.tools` behind an existence-only guard.
	it("keeps the rejection reason for a search_tool_bm25 call the loop refused", () => {
		expectReportedFailure(renderLoopFailure("search_tool_bm25", { query: "browser" }));
	});

	// write's renderer hardcodes the success glyph and never reads `isError`.
	it("does not mark a refused write call as successful", () => {
		expectReportedFailure(renderLoopFailure("write", { file_path: "/tmp/a.txt", content: "x" }));
	});

	it("reports the reason when execute throws after dispatch", () => {
		const component = new ToolExecutionComponent("task", { agent: "critic" }, {}, undefined, uiStub);
		component.updateResult(
			{
				content: [{ type: "text", text: "Task execution failed: boom" }],
				details: { failureKind: "execution" },
				isError: true,
			},
			false,
		);
		expect(Bun.stripANSI(component.render(80).join("\n"))).toContain("Task execution failed: boom");
	});

	// todo_write reports its own failureKind alongside its own details, and its
	// renderer already reads isError. That result still belongs to it: the renderer
	// titles the card "Todo Write", where the generic fallback would title it with the
	// raw tool name.
	it("leaves a tool-owned failure result with its own renderer", () => {
		const component = new ToolExecutionComponent("todo_write", { phases: [] }, {}, undefined, uiStub);
		component.updateResult(
			{
				content: [{ type: "text", text: "rejected" }],
				details: {
					phases: [{ name: "Phase", tasks: [] }],
					storage: "session",
					failureKind: "payload_rejected",
				},
				isError: true,
			},
			false,
		);
		const output = Bun.stripANSI(component.render(80).join("\n"));
		expect(output).toContain("Todo Write");
		expect(output).not.toContain("todo_write");
	});

	it("leaves a successful task result with its own renderer", () => {
		const component = new ToolExecutionComponent("task", { agent: "architect" }, {}, undefined, uiStub);
		component.updateResult(
			{
				content: [{ type: "text", text: "done" }],
				details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
				isError: false,
			},
			false,
		);
		expect(Bun.stripANSI(component.render(80).join("\n"))).not.toContain("render error");
	});
});
