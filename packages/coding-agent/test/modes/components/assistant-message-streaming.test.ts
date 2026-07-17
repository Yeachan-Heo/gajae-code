import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@gajae-code/ai";
import { Container, Spacer, Text } from "@gajae-code/tui";
import {
	__markdownPerfCounters,
	__setMarkdownNowForTest,
	clearRenderCache,
	Markdown,
} from "@gajae-code/tui/components/markdown";
import { resetSettingsForTest, Settings, settings } from "../../../src/config/settings.js";
import { AssistantMessageComponent } from "../../../src/modes/components/assistant-message.js";
import { initTheme } from "../../../src/modes/theme/theme.js";

let now = 1_000_000;

function advance(ms: number): void {
	now += ms;
}

function message(content: AssistantMessage["content"], stopReason?: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: stopReason ?? "stop",
		timestamp: now,
	};
}

function render(component: AssistantMessageComponent): string {
	return Bun.stripANSI(component.render(100).join("\n"));
}

function contentChildren(component: AssistantMessageComponent) {
	const [container] = component.children;
	expect(container).toBeInstanceOf(Container);
	return (container as Container).children;
}

function countChildren(
	component: AssistantMessageComponent,
	type: typeof Markdown | typeof Spacer | typeof Text,
): number {
	return contentChildren(component).filter(child => child instanceof type).length;
}

describe("AssistantMessageComponent streaming markdown", () => {
	beforeEach(async () => {
		clearRenderCache();
		__markdownPerfCounters.reset();
		now = 1_000_000;
		__setMarkdownNowForTest(() => now);
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme(false);
	});
	afterAll(() => {
		__setMarkdownNowForTest(undefined);
	});

	it("only re-lexes the active block while earlier blocks are unchanged", () => {
		const completed = { type: "text" as const, text: "## completed\n\nStable [link](https://example.com)" };
		const active = { type: "text" as const, text: "active 0" };
		const component = new AssistantMessageComponent(message([completed, active]));
		component.updateContent(message([completed, active]), { streaming: true });
		render(component);
		expect(__markdownPerfCounters.lexerInvocations).toBe(2);

		for (let i = 1; i <= 40; i++) {
			active.text += ` token-${i}`;
			component.updateContent(message([completed, active]), { streaming: true });
			render(component);
		}

		expect(__markdownPerfCounters.lexerInvocations).toBe(2);

		advance(70);
		active.text += " after-window";
		component.updateContent(message([completed, active]), { streaming: true });
		render(component);
		expect(__markdownPerfCounters.lexerInvocations).toBe(3);
	});

	it("reconciles streaming updates without recreating completed child components", () => {
		const completed = { type: "text" as const, text: "completed" };
		const active = { type: "text" as const, text: "active" };
		const component = new AssistantMessageComponent(message([completed, active]));
		component.updateContent(message([completed, active]), { streaming: true });

		const initialChildren = contentChildren(component);
		const completedComponent = initialChildren.find(
			child => child instanceof Markdown && child !== initialChildren.at(-1),
		);
		expect(completedComponent).toBeDefined();
		if (!completedComponent) return;
		const initialSpacerCount = countChildren(component, Spacer);
		const initialTextCount = countChildren(component, Text);
		let completedDisposed = 0;
		const originalDispose = completedComponent?.dispose?.bind(completedComponent);
		if (completedComponent) {
			completedComponent.dispose = () => {
				completedDisposed++;
				originalDispose?.();
			};
		}

		for (let i = 0; i < 25; i++) {
			active.text += ` delta-${i}`;
			component.updateContent(message([completed, active]), { streaming: true });
			expect(contentChildren(component)).toContain(completedComponent);
		}

		expect(completedDisposed).toBe(0);
		expect(countChildren(component, Spacer)).toBe(initialSpacerCount);
		expect(countChildren(component, Text)).toBe(initialTextCount);
	});

	it("does not grant semantic eligibility without an occurrence ID", () => {
		const component = new AssistantMessageComponent(message([{ type: "text", text: "unscoped" }]));
		expect(component.renderWithViewportAnchors(40).anchors.every(anchor => anchor === null)).toBe(true);
	});

	it("excludes tool-only and empty error assistants from semantic rows", () => {
		const toolOnly = message([
			{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "x" } },
		] as AssistantMessage["content"]);
		const toolComponent = new AssistantMessageComponent(toolOnly, false, undefined, "assistant:test:tool-only");
		expect(toolComponent.renderWithViewportAnchors(40).anchors.every(anchor => anchor === null)).toBe(true);
		const errorOnly = { ...message([]), stopReason: "error" as const, errorMessage: "transport failed" };
		const errorComponent = new AssistantMessageComponent(errorOnly, false, undefined, "assistant:test:error-only");
		expect(errorComponent.renderWithViewportAnchors(40).anchors.every(anchor => anchor === null)).toBe(true);
	});

	it("keeps semantic anchor identity stable from streaming through final content", () => {
		const active = { type: "text" as const, text: "가나다라마바사🙂" };
		const initial = message([active]);
		const component = new AssistantMessageComponent(initial, false, undefined, "assistant:test:stream");
		component.updateContent(initial, { streaming: true });
		const streamingIds = new Set(
			component.renderWithViewportAnchors(12).anchors.flatMap(anchor => (anchor === null ? [] : [anchor.id])),
		);
		const finalBlock = { type: "text" as const, text: `${active.text}카타파하끝` };
		component.updateContent(message([finalBlock], "stop"), { streaming: false });
		const finalRender = component.renderWithViewportAnchors(12);
		const finalIds = new Set(finalRender.anchors.flatMap(anchor => (anchor === null ? [] : [anchor.id])));
		expect(streamingIds.size).toBe(1);
		expect(finalIds).toEqual(streamingIds);
		const targetRow = finalRender.lines.findIndex(line => Bun.stripANSI(line).includes("끝"));
		expect(targetRow).toBeGreaterThanOrEqual(0);
		expect(finalRender.anchors[targetRow]).not.toBeNull();
	});

	it("keeps duplicate assistant blocks distinct across replacement objects", () => {
		const initial = message([
			{ type: "text", text: "duplicate block" },
			{ type: "text", text: "duplicate block" },
		] as AssistantMessage["content"]);
		const component = new AssistantMessageComponent(initial, false, undefined, "assistant:test:duplicates");
		const initialIds = new Set(
			component.renderWithViewportAnchors(40).anchors.flatMap(anchor => (anchor === null ? [] : [anchor.id])),
		);
		expect(initialIds.size).toBe(2);
		component.updateContent(
			message(
				[
					{ type: "text", text: "duplicate block" },
					{ type: "text", text: "duplicate block" },
				] as AssistantMessage["content"],
				"stop",
			),
			{ streaming: false },
		);
		const replacementIds = new Set(
			component.renderWithViewportAnchors(12).anchors.flatMap(anchor => (anchor === null ? [] : [anchor.id])),
		);
		expect(replacementIds).toEqual(initialIds);
	});

	it("keeps Markdown decoration rows authoritative without leaking marker bytes", () => {
		const component = new AssistantMessageComponent(
			message([{ type: "text", text: "**repeat repeat** [🙂](https://example.com)  e\u0301\n\n> 가가" }]),
			false,
			undefined,
			"assistant:test:markdown",
		);
		const rendered = component.renderWithViewportAnchors(14);
		const anchors = rendered.anchors.flatMap(anchor => (anchor === null ? [] : [anchor]));
		expect(rendered.lines.join("")).not.toContain("GJC_ANCHOR");
		expect(anchors.length).toBeGreaterThan(1);
		expect(new Set(anchors.map(anchor => anchor.id)).size).toBe(1);
		expect(anchors[0]?.graphemeStart).toBe(0);
		for (let index = 0; index < anchors.length; index++) {
			const anchor = anchors[index];
			expect(anchor.graphemeEnd).toBeGreaterThan(anchor.graphemeStart);
			expect(anchor.cellEnd).toBeGreaterThan(anchor.cellStart);
			if (index > 0) {
				expect(anchor.graphemeStart).toBeGreaterThanOrEqual(anchors[index - 1].graphemeEnd);
				expect(anchor.cellStart).toBeGreaterThanOrEqual(anchors[index - 1].cellEnd);
			}
		}
	});

	it("remaps cached Markdown spans to each source occurrence ID", () => {
		const content = [{ type: "text" as const, text: "cached **가가🙂** provenance" }];
		const first = new AssistantMessageComponent(message(content), false, undefined, "assistant:test:cache:first");
		const firstRender = first.renderWithViewportAnchors(18);
		const second = new AssistantMessageComponent(
			message([{ type: "text", text: content[0].text }]),
			false,
			undefined,
			"assistant:test:cache:second",
		);
		const secondRender = second.renderWithViewportAnchors(18);
		expect(secondRender.lines).toEqual(firstRender.lines);
		expect(new Set(firstRender.anchors.flatMap(anchor => (anchor === null ? [] : [anchor.id])))).toEqual(
			new Set(["assistant:test:cache:first:content:0:text"]),
		);
		expect(new Set(secondRender.anchors.flatMap(anchor => (anchor === null ? [] : [anchor.id])))).toEqual(
			new Set(["assistant:test:cache:second:content:0:text"]),
		);
	});

	it("keeps multi-block ordering byte-identical to a fresh full render", () => {
		const text = { type: "text" as const, text: "First text" };
		const thinking = { type: "thinking" as const, thinking: "private reasoning" };
		const toolCall = { type: "toolCall" as const, toolCallId: "tool-1", toolName: "read", args: { path: "x" } };
		const after = { type: "text" as const, text: "Second text" };
		const component = new AssistantMessageComponent(
			message([text, thinking, toolCall, after] as AssistantMessage["content"]),
		);
		component.updateContent(message([text, thinking, toolCall, after] as AssistantMessage["content"]), {
			streaming: true,
		});
		thinking.thinking += " updated";
		after.text += " updated";
		component.updateContent(message([text, thinking, toolCall, after] as AssistantMessage["content"], "stop"), {
			streaming: false,
		});

		const fresh = new AssistantMessageComponent(
			message(
				[
					{ type: "text", text: text.text },
					{ type: "thinking", thinking: thinking.thinking },
					toolCall,
					{ type: "text", text: after.text },
				] as AssistantMessage["content"],
				"stop",
			),
		);
		expect(render(component)).toBe(render(fresh));
	});

	it("renders abort, error, and usage trailers only on terminal updates", () => {
		settings.set("display.showTokenUsage", true);
		const block = { type: "text" as const, text: "hello" };

		const aborted = new AssistantMessageComponent(message([block]));
		aborted.setUsageInfo({
			input: 10,
			output: 5,
			cacheRead: 2,
			cacheWrite: 3,
			totalTokens: 20,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		aborted.updateContent(
			{
				...message([block]),
				stopReason: undefined,
				errorMessage: "Request was aborted",
			} as unknown as AssistantMessage,
			{ streaming: true },
		);
		expect(render(aborted)).not.toContain("Operation aborted");
		expect(render(aborted)).not.toContain("cache: 2");
		aborted.updateContent(
			{ ...message([block], "aborted"), errorMessage: "Request was aborted" },
			{ streaming: false },
		);
		expect((render(aborted).match(/Operation aborted/g) ?? []).length).toBe(1);
		expect((render(aborted).match(/cache: 2/g) ?? []).length).toBe(1);

		const errored = new AssistantMessageComponent(message([block]));
		errored.updateContent(
			{ ...message([block]), stopReason: undefined, errorMessage: "boom" } as unknown as AssistantMessage,
			{
				streaming: true,
			},
		);
		expect(render(errored)).not.toContain("Error: boom");
		errored.updateContent({ ...message([block], "error"), errorMessage: "boom" }, { streaming: false });
		expect((render(errored).match(/Error: boom/g) ?? []).length).toBe(1);
	});

	it.each([
		"stop",
		"aborted",
		"error",
	] as const)("final %s update disables throttling and renders fresh output", stopReason => {
		const block = { type: "text" as const, text: "A [late][ref]" };
		const component = new AssistantMessageComponent(message([block]));
		component.updateContent(message([block]), { streaming: true });
		render(component);
		const afterInitial = __markdownPerfCounters.lexerInvocations;

		block.text = "A [late][ref]\n\n[ref]: https://example.com";
		component.updateContent(message([block]), { streaming: true });
		render(component);
		expect(__markdownPerfCounters.lexerInvocations).toBe(afterInitial);

		component.updateContent(message([block], stopReason), { streaming: false });
		const finalized = render(component);
		expect(__markdownPerfCounters.lexerInvocations).toBe(afterInitial + 1);

		clearRenderCache();
		const fresh = new AssistantMessageComponent(message([{ type: "text", text: block.text }], stopReason));
		expect(finalized).toContain("late");
		expect(finalized).toBe(render(fresh));
	});
});
