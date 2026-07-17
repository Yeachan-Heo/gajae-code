import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AssistantMessage, Usage } from "@gajae-code/ai";
import { Container, ImageProtocol, Markdown, Spacer, setTerminalImageProtocol, TERMINAL, Text } from "@gajae-code/tui";
import { clearRenderCache } from "@gajae-code/tui/components/markdown";
import { resetSettingsForTest, Settings, settings } from "../../../src/config/settings.js";
import { AssistantMessageComponent } from "../../../src/modes/components/assistant-message.js";
import { initTheme } from "../../../src/modes/theme/theme.js";

const originalImageProtocol = TERMINAL.imageProtocol;

function usage(overrides: Partial<Usage> = {}): Usage {
	return {
		input: 10,
		output: 5,
		cacheRead: 2,
		cacheWrite: 3,
		totalTokens: 20,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...overrides,
	};
}

function message(content: AssistantMessage["content"], stopReason?: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: usage(),
		stopReason: stopReason ?? "stop",
		timestamp: 1_000_000,
	};
}

function render(component: AssistantMessageComponent): string {
	return Bun.stripANSI(component.render(120).join("\n"));
}

function renderedTextLines(component: AssistantMessageComponent): string[] {
	return render(component)
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean)
		.filter(line => line !== "gajae");
}

function contentContainer(component: AssistantMessageComponent): Container {
	const [container] = component.children;
	expect(container).toBeInstanceOf(Container);
	return container as Container;
}

function contentChildren(component: AssistantMessageComponent) {
	return contentContainer(component).children;
}

function assertNoDuplicateChildren(component: AssistantMessageComponent): void {
	const children = contentChildren(component);
	expect(new Set(children).size).toBe(children.length);
}

function count(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

function expectRenderedSequence(component: AssistantMessageComponent, sequence: string[]): void {
	const lines = renderedTextLines(component);
	let cursor = 0;
	for (const line of lines) {
		if (line === sequence[cursor]) cursor++;
	}
	expect(cursor).toBe(sequence.length);
}

function parity(
	content: AssistantMessage["content"],
	streamMutate?: (content: AssistantMessage["content"]) => void,
	hideThinking = false,
): void {
	const streamedContent = content;
	const component = new AssistantMessageComponent(message(streamedContent), hideThinking);
	component.updateContent({ ...message(streamedContent), stopReason: undefined } as unknown as AssistantMessage, {
		streaming: true,
	});
	streamMutate?.(streamedContent);
	component.updateContent(message(streamedContent, "stop"), { streaming: false });

	const freshContent = structuredClone(streamedContent) as AssistantMessage["content"];
	const fresh = new AssistantMessageComponent(message(freshContent, "stop"), hideThinking);
	expect(render(component)).toBe(render(fresh));
	assertNoDuplicateChildren(component);
}

describe("AssistantMessageComponent G009 reconciliation red-team", () => {
	beforeEach(async () => {
		clearRenderCache();
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme(false);
		setTerminalImageProtocol(null);
	});

	afterEach(() => {
		resetSettingsForTest();
		setTerminalImageProtocol(originalImageProtocol);
	});

	it("NO-DISPOSE streams 50 deltas without recreating or disposing completed block components", () => {
		const completedA = { type: "text" as const, text: "Completed **A**" };
		const completedThinking = { type: "thinking" as const, thinking: "stable thought" };
		const completedB = { type: "text" as const, text: "Completed B" };
		const active = { type: "text" as const, text: "active" };
		const component = new AssistantMessageComponent(message([completedA, completedThinking, completedB, active]));
		component.updateContent(message([completedA, completedThinking, completedB, active]), { streaming: true });

		const completedComponents = contentChildren(component)
			.filter(child => child instanceof Markdown)
			.slice(0, 3);
		expect(completedComponents).toHaveLength(3);
		const disposed = new Map<object, number>();
		for (const child of completedComponents) {
			disposed.set(child, 0);
			const originalDispose = child.dispose?.bind(child);
			child.dispose = () => {
				disposed.set(child, (disposed.get(child) ?? 0) + 1);
				originalDispose?.();
			};
		}
		const baselineSpacerCount = contentChildren(component).filter(child => child instanceof Spacer).length;
		const baselineTextCount = contentChildren(component).filter(child => child instanceof Text).length;

		for (let i = 1; i <= 50; i++) {
			active.text += ` delta-${i}`;
			component.updateContent(message([completedA, completedThinking, completedB, active]), { streaming: true });
			const nextMarkdown = contentChildren(component)
				.filter(child => child instanceof Markdown)
				.slice(0, 3);
			expect(nextMarkdown).toEqual(completedComponents);
			expect(contentChildren(component).filter(child => child instanceof Spacer).length).toBe(baselineSpacerCount);
			expect(contentChildren(component).filter(child => child instanceof Text).length).toBe(baselineTextCount);
			assertNoDuplicateChildren(component);
		}
		expect([...disposed.values()]).toEqual([0, 0, 0]);
	});

	it("ORDER-PARITY matches fresh full renders for text/thinking/tool/image-shaped/hidden-thinking cases", () => {
		parity([{ type: "text", text: "text only" }]);
		parity(
			[
				{ type: "text", text: "intro" },
				{ type: "thinking", thinking: "think" },
			],
			content => {
				(content[1] as { type: "thinking"; thinking: string }).thinking += " more";
			},
		);
		parity([
			{ type: "thinking", thinking: "plan" },
			{ type: "text", text: "answer" },
			{ type: "toolCall", toolCallId: "tool-1", toolName: "read", args: { path: "x" } },
		] as AssistantMessage["content"]);
		parity([
			{ type: "text", text: "before image" },
			{ type: "image", data: "Zm9v", mimeType: "image/png" } as unknown as AssistantMessage["content"][number],
			{ type: "text", text: "after image" },
		] as AssistantMessage["content"]);
		parity(
			[
				{ type: "thinking", thinking: "secret" },
				{ type: "text", text: "visible" },
			],
			undefined,
			true,
		);
	});

	it("BLOCK-INSERT/REMOVE reconciles inserted middle blocks and removed empty blocks without stale or duplicate children", () => {
		const a = { type: "text" as const, text: "A" };
		const b = { type: "text" as const, text: "B" };
		const c = { type: "text" as const, text: "C" };
		const component = new AssistantMessageComponent(message([a, c]));
		component.updateContent(message([a, c]), { streaming: true });
		component.updateContent(message([a, b, c]), { streaming: true });
		expectRenderedSequence(component, ["A", "B", "C"]);
		assertNoDuplicateChildren(component);
		const withB = contentChildren(component).filter(child => child instanceof Markdown);
		expect(withB).toHaveLength(3);

		b.text = "   ";
		component.updateContent(message([a, b, c]), { streaming: true });
		expectRenderedSequence(component, ["A", "C"]);
		expect(render(component)).not.toContain("B");
		expect(contentChildren(component)).not.toContain(withB[1]);
		expect(contentChildren(component).filter(child => child instanceof Markdown)).toHaveLength(2);
		assertNoDuplicateChildren(component);
	});

	it("TRAILER-TIMING keeps abort/error/usage trailers off partial updates and adds each once on terminal updates", () => {
		settings.set("display.showTokenUsage", true);
		const block = { type: "text" as const, text: "hello" };
		for (const stopReason of ["aborted", "error", "stop"] as const) {
			const component = new AssistantMessageComponent(message([block]));
			component.setUsageInfo(usage());
			const partial = {
				...message([block]),
				stopReason: undefined,
				errorMessage:
					stopReason === "error" ? "boom" : stopReason === "aborted" ? "Request was aborted" : undefined,
			} as unknown as AssistantMessage;
			component.updateContent(partial, { streaming: true });
			const mid = render(component);
			expect(mid).not.toContain("Operation aborted");
			expect(mid).not.toContain("Error: boom");
			expect(mid).not.toContain("cache: 2");

			const terminal = {
				...message([block], stopReason),
				errorMessage:
					stopReason === "error" ? "boom" : stopReason === "aborted" ? "Request was aborted" : undefined,
			} as AssistantMessage;
			component.updateContent(terminal, { streaming: false });
			component.updateContent(terminal, { streaming: false });
			const done = render(component);
			expect(count(done, "cache: 2")).toBe(1);
			if (stopReason === "aborted") expect(count(done, "Operation aborted")).toBe(1);
			else expect(done).not.toContain("Operation aborted");
			if (stopReason === "error") expect(count(done, "Error: boom")).toBe(1);
			else expect(done).not.toContain("Error: boom");
			assertNoDuplicateChildren(component);
		}
	});

	it("IMAGE-RERENDER survives kitty conversion callback re-render without image child leaks", async () => {
		const webpBase64 = Buffer.from(
			await Bun.file(path.join(import.meta.dir, "../../../../../assets/tool-image-fixture.webp")).arrayBuffer(),
		).toBase64();
		setTerminalImageProtocol(ImageProtocol.Kitty);
		const converted = Promise.withResolvers<void>();
		let callbacks = 0;
		const component = new AssistantMessageComponent(message([{ type: "text", text: "done" }]), false, () => {
			callbacks++;
			converted.resolve();
		});
		component.setToolResultImages("read-1", [{ type: "image", data: webpBase64, mimeType: "image/webp" }]);
		await converted.promise;
		component.updateContent(message([{ type: "text", text: "done" }]), { streaming: false });
		const rendered = component.render(80).join("\n");
		expect(callbacks).toBe(1);
		expect(rendered).toContain("\x1b_G");
		expect(rendered).not.toContain("[Image: image/webp]");
		assertNoDuplicateChildren(component);
		const imageish = contentChildren(component).filter(child => child.constructor.name === "Image");
		expect(imageish).toHaveLength(1);
	});

	it("HIDDEN-THINKING preserves Thinking label and spacer parity against fresh render", () => {
		const thinking = { type: "thinking" as const, thinking: "private" };
		const answer = { type: "text" as const, text: "answer" };
		const component = new AssistantMessageComponent(message([thinking, answer]), true);
		component.updateContent(message([thinking, answer]), { streaming: true });
		thinking.thinking += " updated";
		component.updateContent(message([thinking, answer], "stop"), { streaming: false });
		const output = render(component);
		expect(count(output, "Thinking...")).toBe(1);
		expectRenderedSequence(component, ["Thinking...", "answer"]);
		expect(render(component)).toBe(
			render(
				new AssistantMessageComponent(
					message(
						[
							{ type: "thinking", thinking: thinking.thinking },
							{ type: "text", text: answer.text },
						],
						"stop",
					),
					true,
				),
			),
		);
		assertNoDuplicateChildren(component);
	});

	it("REORDER-STRESS alternates block types across updates with no duplicate children and final render parity", () => {
		const a = { type: "text" as const, text: "A" };
		const b = { type: "thinking" as const, thinking: "B" };
		const c = { type: "text" as const, text: "C" };
		const d = { type: "thinking" as const, thinking: "D" };
		const component = new AssistantMessageComponent(message([a, b, c]));
		const shapes: AssistantMessage["content"][] = [
			[a, b, c],
			[b, a, d, c],
			[c, d, a],
			[d, { type: "text", text: "" }, b, a, c],
			[a, c, d],
		];
		for (const shape of shapes) {
			component.updateContent(message(shape), { streaming: true });
			assertNoDuplicateChildren(component);
		}
		component.updateContent(message(shapes.at(-1)!, "stop"), { streaming: false });
		const fresh = new AssistantMessageComponent(
			message(structuredClone(shapes.at(-1)!) as AssistantMessage["content"], "stop"),
		);
		expect(render(component)).toBe(render(fresh));
		assertNoDuplicateChildren(component);
	});
});
