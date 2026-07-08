import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { AgentTool } from "@gajae-code/agent-core";
import type { TUI } from "@gajae-code/tui";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { ToolExecutionComponent } from "../src/modes/components/tool-execution";
import { __eventControllerPerfCounters, EventController } from "../src/modes/controllers/event-controller";
import { initTheme } from "../src/modes/theme/theme";
import { argsWithPartialJson } from "../src/modes/utils/ui-helpers";

const ui = { requestRender() {} } as unknown as TUI;

function rendered(component: { render(width: number): string[] }): string {
	return Bun.stripANSI(component.render(140).join("\n"));
}

function makeArgs(tool: string, i: number, sameLen = false): Record<string, unknown> {
	const payload = `x`.repeat(4096) + String(i).padStart(4, "0");
	switch (tool) {
		case "edit":
			return {
				input: `§tmp/g004-${i}.txt\n»EOF\n${payload}`,
				__partialJson: `{"input":"§tmp/g004-${i}.txt\\n»EOF\\n${payload.slice(0, 100)}`,
			};
		case "bash":
			return {
				command: sameLen ? `echo ${i === 1 ? "aaaa" : "bbbb"}` : `echo ${i}`,
				__partialJson: `{"command":"echo ${i}`,
			};
		case "vim":
			return { path: `tmp/${i}.txt`, command: `normal i${payload}`, __partialJson: `{"path":"tmp/${i}.txt"` };
		case "eval":
			return {
				language: "javascript",
				code: `console.log("${payload}")`,
				__partialJson: `{"language":"javascript","code":"console`,
			};
		case "recipe":
			return { recipe: `build-${i}`, args: { payload }, __partialJson: `{"recipe":"build-${i}` };
		default:
			return { nested: { tool, payload }, __partialJson: `{"nested":{"tool":"${tool}` };
	}
}

function makeCtx(tools: Record<string, AgentTool> = {}) {
	const pendingTools = new Map<string, any>();
	const chatContainer = {
		children: [] as any[],
		addChild(child: any) {
			this.children.push(child);
		},
		removeChild(child: any) {
			this.children = this.children.filter(c => c !== child);
		},
		clear() {
			this.children = [];
		},
	};
	const ctx: any = {
		isInitialized: true,
		isBackgrounded: false,
		pendingTools,
		chatContainer,
		streamingMessage: undefined,
		streamingComponent: { updateContent() {}, setUsageInfo() {}, setToolResultImages() {} },
		toolOutputExpanded: false,
		hideThinkingBlock: false,
		statusLine: { invalidate() {} },
		statusContainer: { clear() {} },
		editor: { onEscape: undefined, addToHistory() {} },
		settings: {
			get(key: string) {
				if (key === "terminal.showImages") return false;
				if (key === "edit.fuzzyMatch") return false;
				if (key === "edit.fuzzyThreshold") return undefined;
				if (key === "edit.hashlineAutoDropPureInsertDuplicates") return false;
				if (key === "read.toolResultPreview") return false;
				return undefined;
			},
		},
		ui: { requestRender() {} },
		sessionManager: {
			getCwd() {
				return process.cwd();
			},
		},
		session: {
			retryAttempt: 0,
			isTtsrAbortPending: false,
			getToolByName(name: string) {
				return tools[name];
			},
		},
		updateEditorTopBorder() {},
		updateEditorBorderColor() {},
		setWorkingMessage(message: string) {
			ctx.workingMessages.push(message);
		},
		workingMessages: [] as string[],
		showError() {},
		showWarning() {},
		showStatus() {},
		addMessageToChat() {},
	};
	return ctx;
}

function assistantMessage(content: any[]) {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "qa",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("G004 streamed tool args QA", () => {
	let originalStructuredClone: typeof globalThis.structuredClone;
	let originalJsonStringify: typeof JSON.stringify;
	let cloneCount = 0;
	let stringifyCount = 0;

	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		await initTheme(false);
		originalStructuredClone = globalThis.structuredClone;
		originalJsonStringify = JSON.stringify;
		globalThis.structuredClone = ((value: unknown, options?: unknown) => {
			cloneCount += 1;
			return originalStructuredClone(value, options as never);
		}) as typeof globalThis.structuredClone;
		JSON.stringify = ((value: unknown, replacer?: unknown, space?: unknown) => {
			stringifyCount += 1;
			return originalJsonStringify(value, replacer as never, space as never);
		}) as typeof JSON.stringify;
	});

	afterAll(() => {
		globalThis.structuredClone = originalStructuredClone;
		JSON.stringify = originalJsonStringify;
	});

	it("CLONE-ELISION-COUNT records built-in readonly renderer clone/stringify counts across 32 large deltas", () => {
		const observed: Record<string, { cloneCount: number; stringifyCount: number }> = {};
		for (const tool of ["edit", "bash", "eval", "recipe"] as const) {
			cloneCount = 0;
			stringifyCount = 0;
			const component = new ToolExecutionComponent(tool, makeArgs(tool, 0), {}, undefined, ui);
			for (let i = 1; i <= 32; i++) component.updateArgs(makeArgs(tool, i));
			rendered(component);
			observed[tool] = { cloneCount, stringifyCount };
			expect(cloneCount, `${tool} structuredClone count`).toBe(0);
			component.dispose();
		}
		expect(observed.edit.stringifyCount).toBeLessThanOrEqual(1);
		expect(observed.bash.stringifyCount).toBeLessThanOrEqual(1);
		expect(observed.recipe.stringifyCount).toBeLessThanOrEqual(1);
		expect(observed.eval.stringifyCount).toBeLessThanOrEqual(1);
	});

	it("CUSTOM-RENDERER-ISOLATION clones args before custom renderers can mutate them", () => {
		const sourceArgs = { nested: { keep: "original" }, list: ["a"] };
		const customTool = {
			name: "custom",
			label: "Custom",
			renderCall(args: any) {
				args.nested.keep = "mutated";
				args.list.push("b");
				return { render: () => ["custom"], invalidate() {} };
			},
		} as unknown as AgentTool;
		const component = new ToolExecutionComponent("custom", sourceArgs, {}, customTool, ui);
		rendered(component);
		expect(sourceArgs).toEqual({ nested: { keep: "original" }, list: ["a"] });
		component.dispose();
	});

	it("PARTIALJSON-LEAK keeps streaming partial JSON out of serialized and executable message content", async () => {
		const originalArgs = { command: "echo done" };
		const content = {
			type: "toolCall",
			id: "leak",
			name: "bash",
			arguments: originalArgs,
			partialJson: '{"command":"echo part',
		};
		const message = assistantMessage([content]);
		const ctx = makeCtx();
		const controller = new EventController(ctx);
		ctx.streamingMessage = message;
		await controller.handleEvent({
			type: "message_update",
			message,
			assistantMessageEvent: { contentIndex: 0 },
		} as any);
		expect(message.content[0].arguments).toBe(originalArgs);
		expect(message.content[0].arguments).toEqual({ command: "echo done" });
		expect((message.content[0].arguments as any).__partialJson).toBeUndefined();
		expect(JSON.stringify(message.content)).not.toContain("__partialJson");
		await controller.handleEvent({ type: "message_end", message } as any);
		expect(message.content[0].arguments).toBe(originalArgs);
		expect(message.content[0].arguments).toEqual({ command: "echo done" });
		expect((message.content[0].arguments as any).__partialJson).toBeUndefined();
		expect(JSON.stringify(message.content)).not.toContain("__partialJson");
		ctx.pendingTools.forEach((component: any) => {
			component.dispose?.();
		});
	});

	it("EXECUTION-ARGS-SNAPSHOT preserves streamed final args for validation after UI rendering", async () => {
		for (const [toolName, args, partialJson] of [
			["bash", { command: "printf hi", timeout: 5 }, '{"command":"printf hi"'],
			["edit", { input: "§tmp/issue-1870.txt\n»EOF\nhello" }, '{"input":"§tmp/issue-1870.txt'],
			["find", { paths: ["packages/coding-agent/src/**/*.ts"], limit: 3 }, '{"paths":["packages/coding-agent'],
		] as const) {
			const content = {
				type: "toolCall",
				id: `preserve-${toolName}`,
				name: toolName,
				arguments: args,
				partialJson,
			};
			const message = assistantMessage([content]);
			const ctx = makeCtx();
			ctx.streamingMessage = message;
			await new EventController(ctx).handleEvent({
				type: "message_update",
				message,
				assistantMessageEvent: { contentIndex: 0 },
			} as any);
			const beforeEnd = structuredClone(message.content[0].arguments);
			await new EventController(ctx).handleEvent({ type: "message_end", message } as any);
			expect(message.content[0].arguments).toBe(args);
			expect(message.content[0].arguments).toEqual(beforeEnd);
			expect(message.content[0].arguments).not.toEqual({});
			expect((message.content[0].arguments as any).__partialJson).toBeUndefined();
			expect(JSON.stringify(message.content[0].arguments)).not.toContain("__partialJson");
			ctx.pendingTools.forEach((component: any) => {
				component.dispose?.();
			});
		}
	});

	it("COALESCE-SKIP recomputes edit preview for same-length changed content via args identity version", async () => {
		let previewRuns = 0;
		const editModule = await import("../src/edit/index");
		const strategy = (editModule.EDIT_MODE_STRATEGIES as any).hashline;
		const originalCompute = strategy.computeDiffPreview;
		strategy.computeDiffPreview = async (...args: any[]) => {
			previewRuns += 1;
			return originalCompute.apply(strategy, args);
		};
		const component = new ToolExecutionComponent(
			"edit",
			makeArgs("edit", 1, true),
			{},
			{ name: "edit", label: "Edit", mode: "hashline" } as any,
			ui,
		);
		try {
			await new Promise(resolve => setTimeout(resolve, 20));
			const before = previewRuns;
			component.updateArgs(makeArgs("edit", 2, true));
			await new Promise(resolve => setTimeout(resolve, 50));
			expect(previewRuns).toBeGreaterThan(before);
		} finally {
			strategy.computeDiffPreview = originalCompute;
			component.dispose();
		}
	});

	it("RESTORE-PARITY renders restored partial tool calls the same as live-path state", () => {
		const args = { command: "echo restored", __partialJson: '{"command":"echo restored' };
		const live = new ToolExecutionComponent("bash", args, {}, undefined, ui);
		const restoredContent = {
			type: "toolCall",
			id: "r",
			name: "bash",
			arguments: { command: "echo restored" },
			partialJson: '{"command":"echo restored',
		} as any;
		// Restore path must use the shared non-enumerable helper so persisted content stays clean.
		const renderArgs = argsWithPartialJson(restoredContent.arguments, restoredContent.partialJson);
		expect(JSON.stringify(restoredContent)).not.toContain("__partialJson");
		expect((restoredContent.arguments as any).__partialJson).toBeUndefined();
		expect((renderArgs as any).__partialJson).toBe(restoredContent.partialJson);
		const restore = new ToolExecutionComponent("bash", renderArgs, {}, undefined, ui);
		expect(rendered(restore)).toBe(rendered(live));
		live.dispose();
		restore.dispose();
	});

	it("FALLBACK routes message_update without contentIndex to all changed tool calls", async () => {
		__eventControllerPerfCounters.reset();
		const message = assistantMessage([
			{
				type: "toolCall",
				id: "a",
				name: "bash",
				arguments: { command: "echo a" },
				partialJson: '{"command":"echo a',
			},
			{
				type: "toolCall",
				id: "b",
				name: "eval",
				arguments: { language: "javascript", code: "1+1" },
				partialJson: '{"language":"javascript"',
			},
		]);
		const ctx = makeCtx();
		ctx.streamingMessage = message;
		await new EventController(ctx).handleEvent({ type: "message_update", message } as any);
		expect(ctx.pendingTools.has("a")).toBe(true);
		expect(ctx.pendingTools.has("b")).toBe(true);
		expect(__eventControllerPerfCounters.messageUpdateContentVisits).toBe(2);
		ctx.pendingTools.forEach((component: any) => {
			component.dispose?.();
		});
	});

	it("INTENT-CACHE recomputes only for changed tool args and preserves cached intent", async () => {
		let aCalls = 0;
		let bCalls = 0;
		const tools: Record<string, AgentTool> = {
			bash: {
				name: "bash",
				label: "Bash",
				intent(args: any) {
					aCalls += 1;
					return `run ${args.command}`;
				},
			} as any,
			eval: {
				name: "eval",
				label: "Eval",
				intent(args: any) {
					bCalls += 1;
					return `eval ${args.code}`;
				},
			} as any,
		};
		const aArgs = { command: "echo one" };
		const bArgs = { code: "1" };
		let message = assistantMessage([
			{ type: "toolCall", id: "a", name: "bash", arguments: aArgs },
			{ type: "toolCall", id: "b", name: "eval", arguments: bArgs },
		]);
		const ctx = makeCtx(tools);
		ctx.streamingMessage = message;
		const controller = new EventController(ctx);
		await controller.handleEvent({ type: "message_update", message } as any);
		expect(aCalls).toBe(1);
		expect(bCalls).toBe(1);
		message = assistantMessage([
			{ type: "toolCall", id: "a", name: "bash", arguments: { command: "echo two" } },
			{ type: "toolCall", id: "b", name: "eval", arguments: bArgs },
		]);
		ctx.streamingMessage = message;
		await controller.handleEvent({
			type: "message_update",
			message,
			assistantMessageEvent: { contentIndex: 0 },
		} as any);
		expect(aCalls).toBe(2);
		expect(bCalls).toBe(1);
		expect(ctx.workingMessages.at(-1)).toContain("run echo two");
		ctx.pendingTools.forEach((component: any) => {
			component.dispose?.();
		});
	});
});
