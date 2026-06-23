import { describe, expect, it, type Mock, vi } from "bun:test";
import { EventController } from "@gajae-code/coding-agent/modes/controllers/event-controller";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import type { AgentSessionEvent } from "@gajae-code/coding-agent/session/agent-session";

type AutoCompactionEndEvent = Extract<AgentSessionEvent, { type: "auto_compaction_end" }>;

type AutoCompactionFixture = {
	controller: EventController;
	ctx: InteractiveModeContext;
	order: string[];
	showStatus: Mock<(message: string) => void>;
	showWarning: Mock<(message: string) => void>;
	flushCompactionQueue: Mock<(options: { willRetry: boolean }) => Promise<void>>;
	loaderStop: Mock<() => void>;
	statusContainerClear: Mock<() => void>;
	rebuildChatFromMessages: Mock<() => void>;
};

function createFixture(): AutoCompactionFixture {
	const order: string[] = [];
	const loaderStop = vi.fn(() => {
		order.push("loader.stop");
	});
	const statusContainerClear = vi.fn(() => {
		order.push("statusContainer.clear");
	});
	const showStatus = vi.fn(() => {
		order.push("showStatus");
	});
	const showWarning = vi.fn(() => {
		order.push("showWarning");
	});
	const flushCompactionQueue = vi.fn(async () => {
		order.push("flushCompactionQueue");
	});
	const rebuildChatFromMessages = vi.fn(() => {
		order.push("rebuildChatFromMessages");
	});

	const ctx = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		autoCompactionEscapeHandler: () => order.push("originalEscape"),
		autoCompactionLoader: { stop: loaderStop },
		editor: { onEscape: () => order.push("temporaryEscape") },
		statusContainer: { clear: statusContainerClear },
		statusLine: {
			invalidate: vi.fn(() => {
				order.push("statusLine.invalidate");
			}),
		},
		updateEditorTopBorder: vi.fn(() => {
			order.push("updateEditorTopBorder");
		}),
		updateEditorBorderColor: vi.fn(() => {
			order.push("updateEditorBorderColor");
		}),
		ui: {
			requestRender: vi.fn(() => {
				order.push("ui.requestRender");
			}),
		},
		showStatus,
		showWarning,
		rebuildChatFromMessages,
		flushCompactionQueue,
		reloadTodos: vi.fn(async () => {
			order.push("reloadTodos");
		}),
	} as unknown as InteractiveModeContext;

	return {
		controller: new EventController(ctx),
		ctx,
		order,
		showStatus,
		showWarning,
		flushCompactionQueue,
		loaderStop,
		statusContainerClear,
		rebuildChatFromMessages,
	};
}

function compactionResult(): NonNullable<AutoCompactionEndEvent["result"]> {
	return {
		summary: "summary",
		firstKeptEntryId: "entry-1",
		tokensBefore: 100,
	};
}

async function runEndEvent(event: AutoCompactionEndEvent): Promise<AutoCompactionFixture> {
	const fixture = createFixture();
	await fixture.controller.handleEvent(event);
	return fixture;
}

describe("EventController auto-compaction overflow status", () => {
	it("clears the loader before showing overflow completion status", async () => {
		const fixture = await runEndEvent({
			type: "auto_compaction_end",
			action: "context-full",
			result: compactionResult(),
			aborted: false,
			willRetry: true,
		});

		expect(fixture.loaderStop).toHaveBeenCalledTimes(1);
		expect(fixture.statusContainerClear).toHaveBeenCalledTimes(1);
		expect(fixture.ctx.autoCompactionLoader).toBeUndefined();
		expect(fixture.showStatus).toHaveBeenCalledWith("Context overflow maintenance completed");
		expect(fixture.showWarning).not.toHaveBeenCalled();
		expect(fixture.order.indexOf("loader.stop")).toBeLessThan(fixture.order.indexOf("showStatus"));
		expect(fixture.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: true });
	});

	it("clears the loader before showing overflow skipped status", async () => {
		const fixture = await runEndEvent({
			type: "auto_compaction_end",
			action: "context-full",
			result: undefined,
			aborted: false,
			willRetry: true,
			skipped: true,
		});

		expect(fixture.loaderStop).toHaveBeenCalledTimes(1);
		expect(fixture.ctx.autoCompactionLoader).toBeUndefined();
		expect(fixture.showStatus).toHaveBeenCalledWith("Context overflow maintenance skipped");
		expect(fixture.showWarning).not.toHaveBeenCalled();
		expect(fixture.order.indexOf("statusContainer.clear")).toBeLessThan(fixture.order.indexOf("showStatus"));
		expect(fixture.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: true });
	});

	it("clears the loader before showing disabled non-resumable overflow recovery status", async () => {
		const fixture = await runEndEvent({
			type: "auto_compaction_end",
			action: "context-full",
			result: compactionResult(),
			aborted: false,
			willRetry: false,
			continuationSkipReason: "auto_continue_disabled_non_resumable_tail",
		});

		expect(fixture.loaderStop).toHaveBeenCalledTimes(1);
		expect(fixture.ctx.autoCompactionLoader).toBeUndefined();
		expect(fixture.rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		expect(fixture.showStatus).toHaveBeenCalledWith(
			"Context overflow recovery skipped: auto_continue_disabled_non_resumable_tail",
		);
		expect(fixture.showWarning).not.toHaveBeenCalled();
		expect(fixture.order.indexOf("loader.stop")).toBeLessThan(fixture.order.indexOf("showStatus"));
		expect(fixture.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: false });
	});
});
