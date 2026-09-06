import { afterAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@gajae-code/ai";
import { Container, Image, ImageProtocol, Spacer, setTerminalImageProtocol, TERMINAL, Text } from "@gajae-code/tui";
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

async function withDeferredImages(run: (conversions: PromiseWithResolvers<string>[]) => Promise<void>): Promise<void> {
	const originalImage = Bun.Image;
	const originalProtocol = TERMINAL.imageProtocol;
	const conversions: PromiseWithResolvers<string>[] = [];
	class DeferredImage {
		png(): { toBase64(): Promise<string> } {
			return {
				toBase64: () => {
					const conversion = Promise.withResolvers<string>();
					conversions.push(conversion);
					return conversion.promise;
				},
			};
		}
	}
	(Bun as unknown as { Image: typeof Bun.Image }).Image = DeferredImage as never;
	setTerminalImageProtocol(ImageProtocol.Kitty);
	try {
		await run(conversions);
	} finally {
		(Bun as unknown as { Image: typeof Bun.Image }).Image = originalImage;
		setTerminalImageProtocol(originalProtocol);
	}
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

	it("does not enable stale-throttle repaint scheduling without an owner callback", () => {
		const staleThrottle = vi.spyOn(Markdown.prototype, "setOnStaleThrottle");
		let component: AssistantMessageComponent | undefined;
		try {
			const content = [
				{ type: "text" as const, text: "text" },
				{ type: "thinking" as const, thinking: "thinking" },
			];
			component = new AssistantMessageComponent(message(content));
			component.updateContent(message(content), { streaming: true });
			expect(staleThrottle.mock.calls.length).toBeGreaterThanOrEqual(4);
			expect(staleThrottle.mock.calls.every(([callback]) => callback === undefined)).toBe(true);
		} finally {
			component?.dispose();
			staleThrottle.mockRestore();
		}
	});

	it.each([
		"text",
		"thinking",
	] as const)("guards captured %s repaint callbacks without expiring finalized assistants", kind => {
		const repaint = vi.fn();
		const visibleMutation = vi.fn();
		const staleThrottle = vi.spyOn(Markdown.prototype, "setOnStaleThrottle");
		const block =
			kind === "text"
				? { type: "text" as const, text: "initial" }
				: { type: "thinking" as const, thinking: "initial" };
		let component: AssistantMessageComponent | undefined;
		try {
			component = new AssistantMessageComponent(message([block]), false, repaint, undefined, visibleMutation);
			const markdown = contentChildren(component).find(child => child instanceof Markdown);
			expect(markdown).toBeDefined();
			if (!markdown) return;
			component.updateContent(message([block]), { streaming: true });
			if (block.type === "text") block.text = "updated";
			else block.thinking = "updated";
			component.updateContent(message([block]), { streaming: true });
			component.updateContent(message([block]), { streaming: false });
			expect(contentChildren(component)).toContain(markdown);
			const callbacks = staleThrottle.mock.calls.map(([callback]) => callback);
			expect(callbacks.length).toBeGreaterThanOrEqual(4);
			expect(callbacks[0]).toBeTypeOf("function");
			expect(new Set(callbacks).size).toBe(1);
			repaint.mockClear();
			callbacks[0]?.();
			expect(repaint).toHaveBeenCalledTimes(1);
			// Detach the cached child before disposal: its captured callback still belongs to the assistant.
			component.updateContent(message([{ type: "text", text: "replacement" }]), { streaming: false });
			component.dispose();
			const disposedChildren = [...component.children];
			repaint.mockClear();
			visibleMutation.mockClear();
			for (const callback of callbacks) callback?.();
			component.setHideThinkingBlock(true);
			component.setUsageInfo(message([]).usage);
			component.setToolResultImages("read-1", [{ type: "image", data: "source", mimeType: "image/png" }]);
			component.updateContent(message([{ type: "text", text: "must not resurrect" }]));
			component.invalidate();
			expect(component.children).toEqual(disposedChildren);
			expect(repaint).not.toHaveBeenCalled();
			expect(visibleMutation).not.toHaveBeenCalled();
		} finally {
			component?.dispose();
			staleThrottle.mockRestore();
		}
	});

	it.each(["success", "failure"] as const)("ignores late image %s after disposal", async outcome => {
		await withDeferredImages(async conversions => {
			const repaint = vi.fn();
			const visibleMutation = vi.fn();
			const component = new AssistantMessageComponent(
				message([{ type: "text", text: "final" }]),
				false,
				repaint,
				undefined,
				visibleMutation,
			);
			component.setToolResultImages("read-1", [{ type: "image", data: "source", mimeType: "image/webp" }]);
			expect(conversions).toHaveLength(1);
			component.dispose();
			repaint.mockClear();
			visibleMutation.mockClear();
			if (outcome === "success") conversions[0].resolve("converted");
			else conversions[0].reject(new Error("conversion failed"));
			await Promise.resolve();
			await Promise.resolve();
			expect(repaint).not.toHaveBeenCalled();
			expect(visibleMutation).not.toHaveBeenCalled();
		});
	});

	it.each([
		"success",
		"failure",
	] as const)("ignores stale generation %s while completing a live finalized image", async outcome => {
		await withDeferredImages(async conversions => {
			const repaint = vi.fn();
			const visibleMutation = vi.fn();
			const block = { type: "text" as const, text: "streaming" };
			const component = new AssistantMessageComponent(message([block]), false, repaint, undefined, visibleMutation);
			try {
				component.updateContent(message([block]), { streaming: true });
				const images = [{ type: "image" as const, data: "source", mimeType: "image/webp" }];
				component.setToolResultImages("read-1", images);
				component.setToolResultImages("read-1", []);
				component.setToolResultImages("read-1", images);
				expect(conversions).toHaveLength(2);
				block.text = "authoritative final";
				component.updateContent(message([block]), { streaming: false });
				const finalChildren = [...contentChildren(component)];
				repaint.mockClear();
				visibleMutation.mockClear();
				if (outcome === "success") conversions[0].resolve("obsolete");
				else conversions[0].reject(new Error("obsolete conversion"));
				await Promise.resolve();
				await Promise.resolve();
				expect(contentChildren(component)).toEqual(finalChildren);
				expect(repaint).not.toHaveBeenCalled();
				expect(visibleMutation).not.toHaveBeenCalled();
				conversions[1].resolve("fresh");
				await Promise.resolve();
				await Promise.resolve();
				expect(contentChildren(component).some(child => child instanceof Image)).toBe(true);
				expect(repaint).toHaveBeenCalledTimes(1);
				expect(visibleMutation).toHaveBeenCalledTimes(1);
				visibleMutation.mockClear();
				component.updateContent(message([block]), { streaming: false });
				expect(visibleMutation).not.toHaveBeenCalled();
			} finally {
				component.dispose();
			}
		});
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

	it("only revises streaming finalization when it can alter rendered Markdown", () => {
		const visibleTextMutation = vi.fn();
		const visibleText = new AssistantMessageComponent(
			message([{ type: "text", text: "visible text" }]),
			false,
			undefined,
			undefined,
			visibleTextMutation,
		);
		visibleText.updateContent(message([{ type: "text", text: "visible text" }]), { streaming: true });
		visibleTextMutation.mockClear();
		visibleText.updateContent(message([{ type: "text", text: "visible text" }]), { streaming: false });
		expect(visibleTextMutation).toHaveBeenCalledTimes(1);

		const visibleThinkingMutation = vi.fn();
		const visibleThinking = new AssistantMessageComponent(
			message([{ type: "thinking", thinking: "visible thinking" }]),
			false,
			undefined,
			undefined,
			visibleThinkingMutation,
		);
		visibleThinking.updateContent(message([{ type: "thinking", thinking: "visible thinking" }]), { streaming: true });
		visibleThinkingMutation.mockClear();
		visibleThinking.updateContent(message([{ type: "thinking", thinking: "visible thinking" }]), {
			streaming: false,
		});
		expect(visibleThinkingMutation).toHaveBeenCalledTimes(1);

		const hiddenThinkingMutation = vi.fn();
		const hiddenThinking = new AssistantMessageComponent(
			message([{ type: "thinking", thinking: "hidden thinking" }]),
			true,
			undefined,
			undefined,
			hiddenThinkingMutation,
		);
		hiddenThinking.updateContent(message([{ type: "thinking", thinking: "hidden thinking" }]), { streaming: true });
		hiddenThinkingMutation.mockClear();
		hiddenThinking.updateContent(message([{ type: "thinking", thinking: "hidden thinking" }]), { streaming: false });
		expect(hiddenThinkingMutation).not.toHaveBeenCalled();
	});
	it("suppresses terminal errors and visible revisions for tool-call assistants", () => {
		let visibleMutations = 0;
		const component = new AssistantMessageComponent(
			message([
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "x" } },
			] as AssistantMessage["content"]),
			false,
			undefined,
			undefined,
			() => visibleMutations++,
		);
		component.updateContent(
			{
				...message(
					[
						{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "x" } },
					] as AssistantMessage["content"],
					"error",
				),
				errorMessage: "tool failed",
			},
			{ streaming: false },
		);

		expect(render(component)).not.toContain("Error:");
		expect(visibleMutations).toBe(0);
	});

	it("does not revise identical tool-result images", () => {
		let visibleMutations = 0;
		const component = new AssistantMessageComponent(
			message([{ type: "text", text: "result" }]),
			false,
			undefined,
			undefined,
			() => visibleMutations++,
		);
		const images = [{ type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" }];
		component.setToolResultImages("read-1", images);
		expect(visibleMutations).toBe(1);
		component.setToolResultImages("read-1", images);
		expect(visibleMutations).toBe(1);
	});
});
