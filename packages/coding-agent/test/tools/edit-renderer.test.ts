import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentTool } from "@gajae-code/agent-core";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { EDIT_MODE_STRATEGIES } from "@gajae-code/coding-agent/edit";
import { editToolRenderer } from "@gajae-code/coding-agent/edit/renderer";
import { getEditRequestTargetInventory, type PerFileDiffPreview } from "@gajae-code/coding-agent/edit/streaming";
import { ToolExecutionComponent } from "@gajae-code/coding-agent/modes/components/tool-execution";
import * as themeModule from "@gajae-code/coding-agent/modes/theme/theme";
import type { TUI } from "@gajae-code/tui";
import { loadTestTheme } from "../helpers/test-theme";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
});

async function getUiTheme() {
	await themeModule.initTheme(false, undefined, undefined, "red-claw", "blue-crab");
	const theme = await loadTestTheme();
	expect(theme).toBeDefined();
	return theme!;
}

describe("editToolRenderer", () => {
	it("shows the target path from partial JSON while edit args stream", async () => {
		const uiTheme = await getUiTheme();
		const component = editToolRenderer.renderCall(
			{
				edits: [{}],
				__partialJson: '{"edits":[{"path":"packages/coding-agent/src/edit/renderer.ts","old_text":"before',
			},
			{ expanded: false, isPartial: true, spinnerFrame: 0, renderContext: { editMode: "replace" } },
			uiTheme,
		);

		const rendered = Bun.stripANSI(component.render(160).join("\n"));
		expect(rendered).toContain("packages/coding-agent/src/edit/renderer.ts");
	});
	it("keeps all non-Vim live cards header-only while collapsed", async () => {
		const uiTheme = await getUiTheme();
		const cases = [
			["replace", { path: "a.ts", newText: "SECRET_BODY" }],
			["patch", { path: "a.ts", diff: "SECRET_BODY", op: "update" }],
			["apply_patch", { input: "*** Begin Patch\n*** Add File: a.ts\n+SECRET_BODY" }],
		] as const;
		for (const [editMode, args] of cases) {
			const component = editToolRenderer.renderCall(
				args,
				{ expanded: false, isPartial: true, renderContext: { editMode } },
				uiTheme,
			);
			expect(Bun.stripANSI(component.render(160).join("\n"))).not.toContain("SECRET_BODY");
		}
	});
	it("renders exact live target counts collapsed and payload detail expanded for every non-Vim mode", async () => {
		const uiTheme = await getUiTheme();
		const modes = [
			{
				editMode: "replace" as const,
				args: { edits: [{ path: "a.ts" }, { path: "b.ts" }, { path: "a.ts" }], newText: "expanded replace" },
				expectedDetail: "expanded replace",
			},
			{
				editMode: "patch" as const,
				args: { edits: [{ path: "a.ts" }, { path: "b.ts" }], patch: "expanded patch" },
				expectedDetail: "expanded patch",
			},
			{
				editMode: "apply_patch" as const,
				args: { input: "*** Begin Patch\n*** Add File: a.ts\n+expanded patch\n*** Add File: b.ts" },
				expectedDetail: "expanded apply-patch fallback",
				editStreamingFallback: "expanded apply-patch fallback",
			},
		];
		for (const { editMode, args, expectedDetail, editStreamingFallback } of modes) {
			const renderContext = { editMode, editStreamingFallback };
			const collapsed = Bun.stripANSI(
				editToolRenderer
					.renderCall(args, { expanded: false, isPartial: true, renderContext }, uiTheme)
					.render(160)
					.join("\n"),
			);
			const expanded = Bun.stripANSI(
				editToolRenderer
					.renderCall(args, { expanded: true, isPartial: true, renderContext }, uiTheme)
					.render(160)
					.join("\n"),
			);
			expect(collapsed).toContain("a.ts");
			expect(collapsed).toContain("(+1 more)");
			expect(collapsed).not.toContain(expectedDetail);
			expect(expanded).toContain(expectedDetail);
		}
	});

	it("inventories ordered distinct targets including bodyless free-form headers", () => {
		expect(
			getEditRequestTargetInventory(
				{ edits: [{ path: "a" }, { path: "b" }, { path: "a" }, { path: "c" }] },
				"replace",
				{
					isPartial: false,
				},
			).paths,
		).toEqual(["a", "b", "c"]);

		expect(
			getEditRequestTargetInventory(
				{ input: "*** Begin Patch\n*** Update File: a\n@@\n-old\n+new\n*** Update File: b" },
				"apply_patch",
				{ isPartial: true },
			).paths,
		).toEqual(["a", "b"]);
	});
	it("derives the live-card operation from free-form apply_patch envelopes", async () => {
		const uiTheme = await getUiTheme();
		const create = editToolRenderer.renderCall(
			{ input: "*** Begin Patch\n*** Add File: a.ts\n+body\n*** End Patch" },
			{ expanded: false, isPartial: false, renderContext: { editMode: "apply_patch" } },
			uiTheme,
		);
		const del = editToolRenderer.renderCall(
			{ input: "*** Begin Patch\n*** Delete File: a.ts\n*** End Patch" },
			{ expanded: false, isPartial: false, renderContext: { editMode: "apply_patch" } },
			uiTheme,
		);
		expect(Bun.stripANSI(create.render(160).join("\n"))).toContain("Create");
		expect(Bun.stripANSI(del.render(160).join("\n"))).toContain("Delete");
	});

	it("suppresses only the missing end marker while apply_patch arguments are partial", async () => {
		const uiTheme = await getUiTheme();
		const args = { input: "*** Begin Patch\n*** Add File: a.ts\n+preview" };
		const partial = editToolRenderer.renderCall(
			args,
			{ expanded: true, isPartial: true, renderContext: { editMode: "apply_patch" } },
			uiTheme,
		);
		const complete = editToolRenderer.renderCall(
			args,
			{ expanded: true, isPartial: false, renderContext: { editMode: "apply_patch" } },
			uiTheme,
		);

		expect(Bun.stripANSI(partial.render(160).join("\n"))).not.toContain("*** End Patch");
		expect(Bun.stripANSI(complete.render(160).join("\n"))).toContain("*** End Patch");
	});
	it("uses result-owned collapsed receipts and keeps failure detail expanded", async () => {
		const uiTheme = await getUiTheme();
		const success = editToolRenderer.renderResult(
			{ content: [], details: { path: "result.ts", diff: "+line\n-old", op: "create" } },
			{ expanded: false, isPartial: false, renderContext: { editMode: "replace" } },
			uiTheme,
			{ path: "request.ts", newText: "REQUEST_BODY" },
		);
		const failure = editToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "\tfirst cause\nsecond cause" }],
				isError: true,
				details: { path: "result.ts", diff: "+hidden" },
			},
			{ expanded: false, isPartial: false, renderContext: { editMode: "replace" } },
			uiTheme,
			{ path: "request.ts" },
		);
		const successText = Bun.stripANSI(success.render(160).join("\n"));
		const failureText = Bun.stripANSI(failure.render(160).join("\n"));
		expect(successText).toContain("result.ts");
		expect(successText).not.toContain("REQUEST_BODY");
		expect(failureText).toContain("first cause");
		expect(failureText).not.toContain("second cause");
		expect(failureText).not.toContain("+hidden");
	});
	it("reveals the full failure only after expansion", async () => {
		const uiTheme = await getUiTheme();
		const component = editToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "first cause\nfull failure detail" }],
				isError: true,
				details: { path: "a.ts", diff: "" },
			},
			{ expanded: true, isPartial: false, renderContext: { editMode: "replace" } },
			uiTheme,
			{ path: "a.ts" },
		);
		expect(Bun.stripANSI(component.render(160).join("\n"))).toContain("full failure detail");
	});
	it("deduplicates represented paths and keeps mixed per-file receipts independent of a call preview", async () => {
		const uiTheme = await getUiTheme();
		const component = editToolRenderer.renderResult(
			{
				content: [],
				details: {
					diff: "",
					perFileResults: [
						{ path: "a.ts", diff: "+a", firstChangedLine: 3 },
						{ path: "a.ts", diff: "+duplicate", isError: true, errorText: "failed a" },
						{ path: "b.ts", diff: "+b", isError: true, errorText: "failed b" },
					],
				},
			},
			{
				expanded: false,
				isPartial: true,
				renderContext: { editMode: "patch", editDiffPreview: { diff: "", firstChangedLine: 99 } },
			},
			uiTheme,
			{ edits: [{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }], patch: "" },
		);
		const rendered = Bun.stripANSI(component.render(160).join("\n"));
		expect(rendered).toContain("a.ts:3");
		expect(rendered).not.toContain(":99");
		expect(rendered).toContain("failed a");
		expect(rendered).toContain("failed b");
		expect(rendered).toContain("1 more file pending");
	});
	it("uses per-file matching preview and narrowed request metadata fallbacks", async () => {
		const uiTheme = await getUiTheme();
		const component = editToolRenderer.renderResult(
			{ content: [], details: { diff: "", perFileResults: [{ path: "b.ts", diff: "" }] } },
			{
				expanded: false,
				isPartial: true,
				renderContext: {
					editMode: "patch",
					perFileDiffPreview: [
						{ path: "a.ts", diff: "", firstChangedLine: 1 },
						{ path: "b.ts", diff: "", firstChangedLine: 7 },
					],
				},
			},
			uiTheme,
			{
				edits: [
					{ path: "a.ts", op: "create", move: "wrong.ts" },
					{ path: "b.ts", op: "delete", move: "right.ts" },
				],
			},
		);
		const rendered = Bun.stripANSI(component.render(160).join("\n"));
		expect(rendered).toContain("Delete");
		expect(rendered).toContain("b.ts:7");
		expect(rendered).toContain("right.ts");
		expect(rendered).not.toContain("wrong.ts");
	});
	it("uses boxed per-file results without leaking first-file request metadata", async () => {
		await getUiTheme();
		const uiStub = { requestRender() {} } as unknown as TUI;
		const tool = { name: "edit", label: "Edit", mode: "patch" } as unknown as AgentTool;
		const component = new ToolExecutionComponent(
			"edit",
			{
				edits: [
					{ path: "a.ts", op: "create", move: "wrong.ts" },
					{ path: "b.ts", op: "delete", move: "right.ts" },
					{ path: "c.ts", op: "update" },
				],
			},
			{},
			tool,
			uiStub,
		);
		component.updateResult(
			{
				content: [],
				details: {
					diff: "",
					perFileResults: [
						{ path: "a.ts", diff: "+ok", op: "create", firstChangedLine: 2 },
						{ path: "b.ts", diff: "", isError: true, errorText: "b failed" },
					],
				},
			},
			true,
		);
		const rendered = Bun.stripANSI(component.render(160).join("\n"));
		const aLine = rendered.split("\n").find(line => line.includes("a.ts")) ?? "";
		const bLine = rendered.split("\n").find(line => line.includes("b.ts")) ?? "";
		expect(aLine).toContain("Create");
		expect(aLine).toContain("wrong.ts");
		expect(bLine).toContain("Delete");
		expect(bLine).toContain("right.ts");
		expect(bLine).not.toContain("wrong.ts");
		expect(rendered).toContain("b failed");
		expect(rendered).toContain("1 more file pending");
	});
	it("does not render pending rows for completed multi-file results", async () => {
		const uiTheme = await getUiTheme();
		const component = editToolRenderer.renderResult(
			{
				content: [],
				details: {
					diff: "",
					perFileResults: [
						{ path: "a.ts", diff: "+ok", op: "create" },
						{ path: "b.ts", diff: "+ok", op: "update" },
					],
				},
			},
			{ expanded: false, isPartial: false, renderContext: { editMode: "patch" } },
			uiTheme,
			{ edits: [{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }] },
		);

		expect(Bun.stripANSI(component.render(160).join("\n"))).not.toContain("pending");
	});

	it("preserves Vim renderer delegation", async () => {
		const uiTheme = await getUiTheme();
		const component = editToolRenderer.renderCall(
			{ file: "sentinel-vim.ts", steps: [] },
			{ expanded: false, isPartial: true, renderContext: { editMode: "vim" } },
			uiTheme,
		);
		expect(Bun.stripANSI(component.render(160).join("\n"))).toContain("open sentinel-vim.ts");
	});

	it("changes live detail only when expanded", async () => {
		const uiTheme = await getUiTheme();
		const args = { input: "*** Begin Patch\n*** Add File: a.ts\n+stream lifecycle detail" };
		const collapsed = editToolRenderer.renderCall(
			args,
			{
				expanded: false,
				isPartial: true,
				renderContext: { editMode: "apply_patch", editStreamingFallback: "stream lifecycle detail" },
			},
			uiTheme,
		);
		const expanded = editToolRenderer.renderCall(
			args,
			{
				expanded: true,
				isPartial: true,
				renderContext: { editMode: "apply_patch", editStreamingFallback: "stream lifecycle detail" },
			},
			uiTheme,
		);
		expect(Bun.stripANSI(collapsed.render(160).join("\n"))).not.toContain("stream lifecycle detail");
		expect(Bun.stripANSI(expanded.render(160).join("\n"))).toContain("stream lifecycle detail");
	});
	it("reports diagnostics as availability without rendering their content while collapsed", async () => {
		const uiTheme = await getUiTheme();
		const component = editToolRenderer.renderResult(
			{
				content: [],
				details: {
					path: "a.ts",
					diff: "+done",
					diagnostics: { messages: [], summary: "", errored: false },
				},
			},
			{ expanded: false, isPartial: false, renderContext: { editMode: "replace" } },
			uiTheme,
			{ path: "a.ts" },
		);
		const rendered = Bun.stripANSI(component.render(160).join("\n"));
		expect(rendered).toContain("Diagnostics available");
		expect(rendered).not.toContain("0 diagnostics");
	});
	it("keeps trailing partial targets in partial JSON payload", () => {
		expect(
			getEditRequestTargetInventory(
				{
					edits: [{ path: "a.ts" }],
					__partialJson: '{"edits":[{"path":"a.ts"},{"path":"b.ts',
				},
				"replace",
				{ isPartial: true },
			).paths,
		).toEqual(["a.ts", "b.ts"]);
	});

	it("uses details-first identity and keeps rich details expanded", async () => {
		const uiTheme = await getUiTheme();
		const details = {
			path: "result.ts",
			diff: "+visible change\n-hidden change",
			op: "delete" as const,
			move: "moved.ts",
			firstChangedLine: 9,
			diagnostics: { messages: ["diagnostic body"], summary: "1 error", errored: true },
		};
		const collapsed = editToolRenderer.renderResult(
			{ content: [], details },
			{
				expanded: false,
				isPartial: false,
				renderContext: { editMode: "patch", editDiffPreview: { diff: "", firstChangedLine: 1 } },
			},
			uiTheme,
			{ path: "request.ts", op: "create", rename: "request-move.ts", edits: [{ firstChangedLine: 2 }] },
		);
		const expanded = editToolRenderer.renderResult(
			{ content: [], details },
			{ expanded: true, isPartial: false, renderContext: { editMode: "patch" } },
			uiTheme,
			{ path: "request.ts" },
		);
		const collapsedText = Bun.stripANSI(collapsed.render(160).join("\n"));
		const expandedText = Bun.stripANSI(expanded.render(160).join("\n"));
		expect(collapsedText).toContain("Delete");
		expect(collapsedText).toContain("result.ts");
		expect(collapsedText).toContain("moved.ts");
		expect(collapsedText).toContain(":9");
		expect(collapsedText).toContain("+1");
		expect(collapsedText).not.toContain("visible change");
		expect(collapsedText).not.toContain("diagnostic body");
		expect(expandedText).toContain("visible change");
		expect(expandedText).toContain("diagnostic body");
	});

	it("sanitizes paths and parse errors in displayed edit cards", async () => {
		const uiTheme = await getUiTheme();
		const path = "safe.ts\x1b]8;;https://bad\x07\nunsafe.ts";
		const live = editToolRenderer.renderCall(
			{ input: `*** Begin Patch\n*** Add File: ${path}` },
			{ expanded: true, isPartial: true, renderContext: { editMode: "apply_patch" } },
			uiTheme,
		);
		const complete = editToolRenderer.renderResult(
			{ content: [], details: { path, diff: "+ok", move: "move\nunsafe.ts" } },
			{ expanded: false, isPartial: false, renderContext: { editMode: "patch" } },
			uiTheme,
			{ path: "request.ts" },
		);
		const liveRaw = live.render(160).join("\n");
		const completeRaw = complete.render(160).join("\n");
		const completeText = Bun.stripANSI(completeRaw);
		expect(liveRaw).not.toContain("https://bad");
		expect(completeRaw).not.toContain("https://bad");
		expect(completeText).not.toContain("\nunsafe.ts");
	});
	it("sanitizes expanded single-file preview errors", async () => {
		const uiTheme = await getUiTheme();
		const previewError = "failed \x1b]8;;https://bad\x07\nunsafe.ts";
		const component = editToolRenderer.renderResult(
			{ content: [], details: { path: "safe.ts", diff: "" } },
			{
				expanded: true,
				isPartial: true,
				renderContext: { editMode: "replace", editDiffPreview: { error: previewError } },
			},
			uiTheme,
			{ path: "safe.ts" },
		);
		const rendered = component.render(160).join("\n");
		expect(rendered).not.toContain("https://bad");
		expect(rendered).not.toContain("\x1b]8;;");
	});

	it("keeps apply_patch operation and rename metadata on live cards", async () => {
		const uiTheme = await getUiTheme();
		const deleted = editToolRenderer.renderCall(
			{ input: "*** Begin Patch\n*** Delete File: old.ts\n*** End Patch" },
			{ expanded: false, isPartial: false, renderContext: { editMode: "apply_patch" } },
			uiTheme,
		);
		const moved = editToolRenderer.renderCall(
			{ input: "*** Begin Patch\n*** Update File: old.ts\n*** Move to: new.ts\n@@\n-a\n+b\n*** End Patch" },
			{ expanded: true, isPartial: false, renderContext: { editMode: "apply_patch" } },
			uiTheme,
		);
		const deletedText = Bun.stripANSI(deleted.render(160).join("\n"));
		const movedText = Bun.stripANSI(moved.render(160).join("\n"));

		expect(deletedText).toContain("Delete");
		expect(deletedText).toContain("old.ts");
		expect(movedText).toContain("new.ts");
	});

	it("sanitizes single-file preview errors on expanded result cards", async () => {
		const uiTheme = await getUiTheme();
		const error = "File not found: \x1b]8;;https://attacker.invalid\x07evil.ts\x1b]8;;\x07\r\ninjected";
		const component = editToolRenderer.renderResult(
			{ content: [], details: { path: "target.ts", diff: "" } },
			{
				expanded: true,
				isPartial: false,
				renderContext: { editMode: "replace", editDiffPreview: { error } },
			},
			uiTheme,
			{ path: "target.ts" },
		);
		const raw = component.render(160).join("\n");

		expect(raw).toContain("File not found");
		expect(raw).not.toContain("https://attacker.invalid");
		expect(raw).not.toContain("\x1b]8;;");
		expect(raw).not.toContain("\r");
	});
});
