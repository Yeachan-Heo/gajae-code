import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentTool } from "@gajae-code/agent-core";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { EDIT_MODE_STRATEGIES } from "@gajae-code/coding-agent/edit";
import { editToolRenderer } from "@gajae-code/coding-agent/edit/renderer";
import { getEditRequestTargetInventory, type PerFileDiffPreview } from "@gajae-code/coding-agent/edit/streaming";
import { ToolExecutionComponent } from "@gajae-code/coding-agent/modes/components/tool-execution";
import * as themeModule from "@gajae-code/coding-agent/modes/theme/theme";
import type { TUI } from "@gajae-code/tui";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
});

async function getUiTheme() {
	await themeModule.initTheme(false, undefined, undefined, "red-claw", "blue-crab");
	const theme = await themeModule.getThemeByName("red-claw");
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
			["hashline", { input: "§a.ts\nSECRET_BODY" }],
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
				editMode: "hashline" as const,
				args: { input: "§a.ts\n§b.ts\nexpanded hashline" },
				expectedDetail: "expanded hashline fallback",
				editStreamingFallback: "expanded hashline fallback",
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
		expect(getEditRequestTargetInventory({ input: "§'a'\n§b\n§a" }, "hashline", { isPartial: true }).paths).toEqual([
			"a",
			"b",
		]);
		expect(
			getEditRequestTargetInventory({ path: "fallback.ts", input: "§actual.ts\n»BOF\n+x" }, "hashline", {
				isPartial: true,
			}).paths,
		).toEqual(["actual.ts"]);
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

	it("uses hashline input headers for streaming call path without apply_patch errors", async () => {
		const uiTheme = await getUiTheme();
		const component = editToolRenderer.renderCall(
			{
				input: "§packages/coding-agent/src/edit/renderer.ts\n»EOF\n// preview",
			},
			{ expanded: false, isPartial: true, spinnerFrame: 0, renderContext: { editMode: "hashline" } },
			uiTheme,
		);

		const rendered = Bun.stripANSI(component.render(160).join("\n"));
		expect(rendered).toContain("packages/coding-agent/src/edit/renderer.ts");
		expect(rendered).not.toContain("The first line of the patch must be");
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

	it("hides hashline envelope input while the live card is collapsed", async () => {
		await getUiTheme();
		const uiStub = { requestRender() {} } as unknown as TUI;
		const hashlineTool = { name: "edit", label: "Edit", mode: "hashline" } as unknown as AgentTool;
		const component = new ToolExecutionComponent(
			"edit",
			{
				input: ["*** Begin Patch", "§crates/pi-natives/src/shell.rs", "»EOF", "pub fn streaming_preview() {"].join(
					"\n",
				),
			},
			{},
			hashlineTool,
			uiStub,
		);

		const rendered = Bun.stripANSI(component.render(160).join("\n"));
		expect(rendered).toContain("crates/pi-natives/src/shell.rs");
		expect(rendered).not.toContain("»EOF");
		expect(rendered).not.toContain("pub fn streaming_preview() {");
		expect(rendered).not.toContain("*** Begin Patch");
	});

	it("recognizes compact and quoted hashline input headers", async () => {
		const uiTheme = await getUiTheme();
		const compactComponent = editToolRenderer.renderCall(
			{
				input: "§foo bar.ts\n»BOF\n// preview",
			},
			{ expanded: true, isPartial: true, spinnerFrame: 0, renderContext: { editMode: "hashline" } },
			uiTheme,
		);

		const quotedComponent = editToolRenderer.renderCall(
			{
				input: "§'baz qux.ts'\n»BOF\n// preview",
			},
			{ expanded: false, isPartial: true, spinnerFrame: 0, renderContext: { editMode: "hashline" } },
			uiTheme,
		);

		const compactRendered = Bun.stripANSI(compactComponent.render(160).join("\n"));
		const quotedRendered = Bun.stripANSI(quotedComponent.render(160).join("\n"));
		expect(compactRendered).toContain("foo bar.ts");
		expect(quotedRendered).toContain("baz qux.ts");
	});

	it("strips canonical `§` and longer `§` runs from hashline input headers", async () => {
		const uiTheme = await getUiTheme();

		// Canonical `§PATH` form — the parser strips the marker and the
		// renderer keeps the title clean.
		const canonical = editToolRenderer.renderCall(
			{
				input: "§packages/coding-agent/src/slash-commands/builtin-registry.ts\n»BOF\n// preview",
			},
			{ expanded: true, isPartial: true, spinnerFrame: 0, renderContext: { editMode: "hashline" } },
			uiTheme,
		);

		// Even longer runs should still produce the clean path.
		const triple = editToolRenderer.renderCall(
			{ input: "§§§a/b/c.ts\n»BOF\n// preview" },
			{ expanded: true, isPartial: true, spinnerFrame: 0, renderContext: { editMode: "hashline" } },
			uiTheme,
		);

		const canonicalRendered = Bun.stripANSI(canonical.render(160).join("\n"));
		const tripleRendered = Bun.stripANSI(triple.render(160).join("\n"));

		expect(canonicalRendered).toContain("packages/coding-agent/src/slash-commands/builtin-registry.ts");
		expect(canonicalRendered).not.toMatch(/§packages\/coding-agent/);
		expect(tripleRendered).toContain("a/b/c.ts");
		expect(tripleRendered).not.toMatch(/§+a\/b\/c\.ts/);
	});

	it("uses hashline input headers for completed single-file result path", async () => {
		const uiTheme = await getUiTheme();
		const component = editToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "Updated packages/coding-agent/src/edit/renderer.ts" }],
				details: {
					diff: "+1|// preview",
					op: "update",
				},
			},
			{ expanded: false, isPartial: false, renderContext: { editMode: "hashline" } },
			uiTheme,
			{
				input: "§packages/coding-agent/src/edit/renderer.ts\n»EOF\n// preview",
			},
		);

		const rendered = Bun.stripANSI(component.render(160).join("\n"));
		expect(rendered).toContain("packages/coding-agent/src/edit/renderer.ts");
		expect(rendered).not.toContain(" …");
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
	it("renders a represented partial file and pending target through the execution component", async () => {
		await getUiTheme();
		const uiStub = { requestRender() {} } as unknown as TUI;
		const tool = { name: "edit", label: "Edit", mode: "hashline" } as unknown as AgentTool;
		const component = new ToolExecutionComponent("edit", { input: "§a.ts\n»EOF\n§b.ts" }, {}, tool, uiStub);
		component.updateResult(
			{ content: [], details: { diff: "", perFileResults: [{ path: "a.ts", diff: "+done" }] } },
			true,
		);
		const rendered = Bun.stripANSI(component.render(160).join("\n"));
		expect(rendered).toContain("a.ts");
		expect(rendered).toContain("1 more file pending");
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
				renderContext: { editMode: "hashline", editDiffPreview: { diff: "", firstChangedLine: 99 } },
			},
			uiTheme,
			{ input: "§a.ts\n§b.ts\n§c.ts" },
		);
		const rendered = Bun.stripANSI(component.render(160).join("\n"));
		expect(rendered).toContain("a.ts:3");
		expect(rendered).not.toContain(":99");
		expect(rendered).toContain("failed a");
		expect(rendered).toContain("failed b");
		expect(rendered).toContain("1 more file pending");
	});
	it("uses separate requested and represented cardinalities for pending files", async () => {
		const uiTheme = await getUiTheme();
		const component = editToolRenderer.renderResult(
			{
				content: [],
				details: {
					perFileResults: [{ path: "a", diff: "+done" }],
					diff: "",
				},
			},
			{ expanded: false, isPartial: true, renderContext: { editMode: "hashline" } },
			uiTheme,
			{ input: "§a\n»EOF\n§a\n»EOF\n§b" },
		);
		const rendered = Bun.stripANSI(component.render(160).join("\n"));
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
		const args = { input: "§a.ts\nstream lifecycle detail" };
		const collapsed = editToolRenderer.renderCall(
			args,
			{
				expanded: false,
				isPartial: true,
				renderContext: { editMode: "hashline", editStreamingFallback: "stream lifecycle detail" },
			},
			uiTheme,
		);
		const expanded = editToolRenderer.renderCall(
			args,
			{
				expanded: true,
				isPartial: true,
				renderContext: { editMode: "hashline", editStreamingFallback: "stream lifecycle detail" },
			},
			uiTheme,
		);
		expect(Bun.stripANSI(collapsed.render(160).join("\n"))).not.toContain("stream lifecycle detail");
		expect(Bun.stripANSI(expanded.render(160).join("\n"))).toContain("stream lifecycle detail");
	});
	it("keeps a single-path preview for a boxed partial result", async () => {
		const uiStub = { requestRender() {} } as unknown as TUI;
		const strategy = EDIT_MODE_STRATEGIES.hashline;
		const originalCompute = strategy.computeDiffPreview;
		const pending = Promise.withResolvers<PerFileDiffPreview[] | null>();
		strategy.computeDiffPreview = () => pending.promise;
		const component = new ToolExecutionComponent(
			"edit",
			{ input: "§a.ts\n§b.ts" },
			{},
			{ name: "edit", label: "Edit", mode: "hashline" } as unknown as AgentTool,
			uiStub,
		);
		try {
			component.updateResult(
				{ content: [], details: { diff: "", perFileResults: [{ path: "a.ts", diff: "" }] } },
				true,
			);
			pending.resolve([{ path: "a.ts", diff: "", firstChangedLine: 7 }]);
			for (let attempt = 0; attempt < 20; attempt++) await Promise.resolve();
			expect(Bun.stripANSI(component.render(160).join("\n"))).toContain("a.ts:7");
		} finally {
			strategy.computeDiffPreview = originalCompute;
			component.dispose();
		}
	});

	it("reports only visible streaming deltas through the transcript mutation handle", () => {
		const uiStub = { requestRender() {} } as unknown as TUI;
		const component = new ToolExecutionComponent(
			"edit",
			{ input: "§a.ts\nhidden one" },
			{},
			{ name: "edit", label: "Edit", mode: "hashline" } as unknown as AgentTool,
			uiStub,
		);
		component.consumeVisibleTranscriptChange();
		component.updateArgs({ input: "§a.ts\nhidden two" });
		expect(component.consumeVisibleTranscriptChange()).toBe(false);
		component.setExpanded(true);
		component.consumeVisibleTranscriptChange();
		component.updateArgs({ input: "§a.ts\nvisible three" });
		expect(component.consumeVisibleTranscriptChange()).toBe(true);
		component.dispose();
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
	it("keeps trailing partial targets and ignores hashline headers after terminators", () => {
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
		expect(
			getEditRequestTargetInventory({ input: "§a.ts\n*** End Patch\n§not-a-target.ts" }, "hashline", {
				isPartial: true,
			}).paths,
		).toEqual(["a.ts"]);
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
});
