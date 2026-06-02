import { describe, expect, it } from "bun:test";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { getThemeByName } from "@gajae-code/coding-agent/modes/theme/theme";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { ResolveTool, resolveToolRenderer } from "@gajae-code/coding-agent/tools/resolve";
import { sanitizeText } from "@gajae-code/utils";
import * as z from "zod/v4";

function createSession(handler?: (input: unknown) => Promise<unknown>): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		peekQueueInvoker: handler ? () => handler : () => undefined,
	};
}

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

describe("ResolveTool", () => {
	it("requires action and reason in schema", () => {
		const tool = new ResolveTool(createSession());
		const wire = z.toJSONSchema(tool.parameters, { target: "draft-2020-12" }) as { required?: string[] };
		expect(wire.required).toEqual(["action", "reason"]);
	});

	it("errors when there is no pending action", async () => {
		const tool = new ResolveTool(createSession());
		await expect(tool.execute("call-none", { action: "apply", reason: "looks correct" })).rejects.toThrow(
			"No pending action to resolve. Nothing to apply or discard.",
		);
	});

	it("discards pending action and clears store", async () => {
		let discardedReason: string | undefined;
		const handler = async (input: unknown) => {
			const p = input as { action: string; reason: string };
			if (p.action === "discard") {
				discardedReason = p.reason;
			}
			return {
				content: [{ type: "text", text: "Rejected pending preview." }],
				details: {
					action: p.action,
					reason: p.reason,
					sourceToolName: "ast_edit",
					label: "AST Edit: 2 replacements in 1 file",
				},
			};
		};
		const session = createSession(handler);
		const tool = new ResolveTool(session);
		const result = await tool.execute("call-discard", {
			action: "discard",
			reason: "Preview changed wrong callsites",
		});

		expect(getText(result)).toContain("Rejected pending preview.");
		expect(discardedReason).toBe("Preview changed wrong callsites");
		expect(result.details).toEqual({
			action: "discard",
			reason: "Preview changed wrong callsites",
			sourceToolName: "ast_edit",
			label: "AST Edit: 2 replacements in 1 file",
		});
	});

	it("applies pending action and clears store", async () => {
		let appliedReason: string | undefined;
		const handler = async (input: unknown) => {
			const p = input as { action: string; reason: string };
			if (p.action === "apply") {
				appliedReason = p.reason;
			}
			return {
				content: [{ type: "text", text: "Applied 1 replacement in 1 file." }],
				details: {
					action: p.action,
					reason: p.reason,
					sourceToolName: "ast_edit",
					label: "AST Edit: 1 replacement in 1 file",
				},
			};
		};
		const session = createSession(handler);
		const tool = new ResolveTool(session);
		const result = await tool.execute("call-apply", {
			action: "apply",
			reason: "Preview is correct",
		});

		expect(appliedReason).toBe("Preview is correct");
		expect(getText(result)).toContain("Applied 1 replacement in 1 file.");
		expect(result.details).toEqual({
			action: "apply",
			reason: "Preview is correct",
			sourceToolName: "ast_edit",
			label: "AST Edit: 1 replacement in 1 file",
		});
	});
});

it("renders a highlighted apply summary", async () => {
	const theme = await getThemeByName("red-claw");
	expect(theme).toBeDefined();
	const uiTheme = theme!;

	const component = resolveToolRenderer.renderResult(
		{
			content: [{ type: "text", text: "Applied 2 replacements in 1 file." }],
			details: {
				action: "apply",
				reason: "All replacements are correct",
				sourceToolName: "ast_edit",
				label: "AST Edit: 2 replacements in 1 file",
			},
		},
		{ expanded: false, isPartial: false },
		uiTheme,
	);

	const rendered = sanitizeText(component.render(90).join("\n"));
	expect(rendered).toContain("Accept: 2 replacements in 1 file");
	expect(rendered).toContain("AST Edit");
	expect(rendered).toContain("All replacements are correct");
	expect(rendered).not.toContain("Applied 2 replacements in 1 file.");
	expect(rendered).not.toContain("Decision");
	expect(rendered).not.toContain("┌");
});
