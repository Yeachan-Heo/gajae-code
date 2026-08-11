import { afterEach, beforeAll, describe, expect, test, vi } from "bun:test";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { addChatChild, CollapsedChatHistoryComponent } from "@gajae-code/coding-agent/modes/utils/ui-helpers";
import { type Component, Container } from "@gajae-code/tui";

beforeAll(async () => {
	await initTheme();
});

function component(label: string): Component {
	return {
		render: () => [label],
		invalidate: () => {},
	};
}

function createCtx(): InteractiveModeContext {
	return {
		chatContainer: new Container(),
		pendingTools: new Map(),
		pendingBashComponents: [],
		pendingPythonComponents: [],
		bashComponent: undefined,
		pythonComponent: undefined,
		streamingComponent: undefined,
	} as unknown as InteractiveModeContext;
}

function addAt(ctx: InteractiveModeContext, child: Component, isoTime: string): void {
	vi.spyOn(Date, "now").mockReturnValue(new Date(isoTime).getTime());
	addChatChild(ctx, child);
}

describe("interactive chat container cap", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("collapses oldest completed children to a single placeholder when over cap", () => {
		const ctx = createCtx();

		for (let i = 0; i < 401; i++) {
			addAt(ctx, component(`message ${i}`), `2026-07-06T09:${String(i % 60).padStart(2, "0")}:00`);
		}

		expect(ctx.chatContainer.children.length).toBeLessThanOrEqual(401);
		expect(ctx.chatContainer.children).toHaveLength(102);
		const placeholder = ctx.chatContainer.children[0];
		expect(placeholder).toBeInstanceOf(CollapsedChatHistoryComponent);
		expect((placeholder as CollapsedChatHistoryComponent).count).toBe(300);
		expect(placeholder.render(120).join("\n")).toContain("[300 earlier messages collapsed");
	});

	test("does not collapse active pending components in the oldest batch", () => {
		const ctx = createCtx();
		const active = component("active tool");
		ctx.pendingTools.set("tool-1", active as never);

		for (let i = 0; i < 100; i++) {
			addAt(ctx, component(`before ${i}`), `2026-07-06T09:${String(i % 60).padStart(2, "0")}:00`);
		}
		addAt(ctx, active, "2026-07-06T10:00:00Z");
		for (let i = 0; i < 300; i++) {
			addAt(ctx, component(`after ${i}`), `2026-07-06T10:${String(i % 60).padStart(2, "0")}:00`);
		}

		expect(ctx.chatContainer.children[0]).toBeInstanceOf(CollapsedChatHistoryComponent);
		expect((ctx.chatContainer.children[0] as CollapsedChatHistoryComponent).count).toBe(100);
		expect(ctx.chatContainer.children).toContain(active);
		expect(ctx.chatContainer.children.indexOf(active)).toBe(1);
	});

	test("second overflow merges into existing placeholder", () => {
		const ctx = createCtx();

		for (let i = 0; i < 401; i++) {
			addAt(ctx, component(`first ${i}`), `2026-07-06T09:${String(i % 60).padStart(2, "0")}:00`);
		}
		const placeholder = ctx.chatContainer.children[0] as CollapsedChatHistoryComponent;
		expect(placeholder.count).toBe(300);

		for (let i = 0; i < 300; i++) {
			addAt(ctx, component(`second ${i}`), `2026-07-06T11:${String(i % 60).padStart(2, "0")}:00`);
		}

		expect(ctx.chatContainer.children[0]).toBe(placeholder);
		expect(ctx.chatContainer.children.filter(child => child instanceof CollapsedChatHistoryComponent)).toHaveLength(
			1,
		);
		expect(placeholder.count).toBe(600);
		expect(ctx.chatContainer.children.length).toBeLessThanOrEqual(401);
	});

	test("placeholder metadata includes count and collapsed time range", () => {
		const ctx = createCtx();

		for (let i = 0; i < 401; i++) {
			addAt(ctx, component(`message ${i}`), `2026-07-06T09:${String(i % 60).padStart(2, "0")}:00`);
		}

		const placeholder = ctx.chatContainer.children[0] as CollapsedChatHistoryComponent;
		expect(placeholder.count).toBe(300);
		expect(placeholder.startTime).toBe(new Date("2026-07-06T09:00:00").getTime());
		expect(placeholder.endTime).toBe(new Date("2026-07-06T09:59:00").getTime());
		const rendered = placeholder.render(120).join("\n");
		expect(rendered).toContain("300 earlier messages collapsed");
		expect(rendered).toContain("09:00");
		expect(rendered).toContain("09:59");
	});
	test("enforces cap by collapsing completed children even when the oldest child is active", () => {
		const ctx = createCtx();
		const active = component("active tool");
		ctx.pendingTools.set("tool-1", active as never);

		addAt(ctx, active, "2026-07-06T09:00:00Z");
		for (let i = 0; i < 450; i++) {
			addAt(ctx, component(`after ${i}`), `2026-07-06T10:${String(i % 60).padStart(2, "0")}:00`);
		}

		expect(ctx.chatContainer.children.length).toBeLessThanOrEqual(401);
		// Active child is never collapsed and stays at the front.
		expect(ctx.chatContainer.children).toContain(active);
		expect(ctx.chatContainer.children.indexOf(active)).toBe(0);
		// A placeholder for collapsed completed children sits right after the active child.
		const placeholder = ctx.chatContainer.children[1];
		expect(placeholder).toBeInstanceOf(CollapsedChatHistoryComponent);
		expect((placeholder as CollapsedChatHistoryComponent).count).toBeGreaterThan(0);
	});

	test("soak: placeholder residual stays constant under sustained message growth (AC12)", () => {
		const ctx = createCtx();

		// Simulate a long-running interactive session: 10 batches of 1,000 completed
		// chat children each. The approved cap is 400 children; the render-cache
		// residual is the number of retained collapsed placeholder components.
		const residuals: number[] = [];
		const placeholderCounts: number[] = [];
		for (let batch = 0; batch < 10; batch++) {
			for (let i = 0; i < 1000; i++) {
				addAt(
					ctx,
					component(`batch ${batch} message ${i}`),
					`2026-07-06T${String(batch).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00`,
				);
			}
			residuals.push(ctx.chatContainer.children.length);
			placeholderCounts.push(
				ctx.chatContainer.children.filter(child => child instanceof CollapsedChatHistoryComponent).length,
			);
		}

		// The cap holds at every checkpoint: never more than CHAT_CHILD_CAP + the
		// single merged placeholder window.
		for (const residual of residuals) {
			expect(residual).toBeLessThanOrEqual(401);
		}
		// Exactly one merged placeholder is retained — residual is constant, not
		// linear in the number of messages, so the render cache cannot grow.
		expect(placeholderCounts.every(count => count === 1)).toBe(true);
		expect(placeholderCounts).toHaveLength(10);
		// The placeholder accumulates the full collapsed count (10 batches × ~400
		// collapsed each), proving retention is aggregated, not accumulated.
		const placeholder = ctx.chatContainer.children[0] as CollapsedChatHistoryComponent;
		expect(placeholder.count).toBeGreaterThan(3000);
		expect(residuals.at(-1)).toBe(residuals[0]);
	});
});
