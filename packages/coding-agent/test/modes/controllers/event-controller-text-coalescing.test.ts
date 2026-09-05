import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@gajae-code/ai";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import {
	__eventControllerPerfCounters,
	EventController,
} from "@gajae-code/coding-agent/modes/controllers/event-controller";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import {
	associateSessionMessageEntryId,
	getSessionMessageEntryId,
} from "@gajae-code/coding-agent/session/session-manager";
import {
	Container,
	Editor,
	Image,
	ImageProtocol,
	setTerminalImageProtocol,
	TERMINAL,
	Text,
	TUI,
} from "@gajae-code/tui";
import { __setMarkdownNowForTest } from "@gajae-code/tui/components/markdown";
import { defaultEditorTheme } from "../../../../tui/test/test-themes";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal";

function message(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		stopReason: "stop",
		timestamp: 1,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
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

function fixture(real = false) {
	const queued = new Set<() => void>();
	const captured: Array<() => void> = [];
	const terminal = new VirtualTerminal(80, 20);
	const tui = new TUI(terminal);
	const enqueueBeforeRender = vi.fn((callback: () => void) => {
		queued.add(callback);
		captured.push(callback);
		return () => {
			queued.delete(callback);
		};
	});
	const chatContainer = new Container();
	const ctx = {
		isInitialized: true,
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		ui: real ? tui : { requestRender: vi.fn(), enqueueBeforeRender },
		chatContainer,
		pendingTools: new Map(),
		settings: { get: () => true },
		session: {},
		recordVisibleTranscriptMutation: vi.fn(),
	} as unknown as InteractiveModeContext;
	const controller = new EventController(ctx);
	if (real) {
		let revision = 0n;
		tui.setViewportOutputSource({ identity: "test-session", revision });
		vi.spyOn(ctx, "recordVisibleTranscriptMutation").mockImplementation(() => {
			tui.setViewportOutputSource({ identity: "test-session", revision: ++revision });
		});
		tui.addChild(chatContainer);
		tui.setRenderPreparationLifecycleCallbacks({
			invalidate: () => controller.suspendAssistantTextPresentation(),
			beforeStart: () => controller.resumeAssistantTextPresentation(),
		});
	}
	const drain = () => {
		for (const callback of [...queued]) {
			queued.delete(callback);
			callback();
		}
	};
	const update = (value: AssistantMessage, metadata: unknown = { type: "text_delta", contentIndex: 0 }) =>
		controller.handleEvent({ type: "message_update", message: value, assistantMessageEvent: metadata } as never);
	return { ctx, controller, queued, captured, drain, update, enqueueBeforeRender, tui, terminal };
}

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme(false);
});
afterEach(() => {
	__eventControllerPerfCounters.disable();
	__eventControllerPerfCounters.reset();
	vi.restoreAllMocks();
	resetSettingsForTest();
});

describe("assistant text frame preparation", () => {
	it("prepares latest text with a real Bun.Image WebP-to-PNG conversion", async () => {
		// Native decoding is real here; only frame scheduling uses the controlled fixture.
		const seed = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
			"base64",
		);
		const webp = await new Bun.Image(seed).webp({ quality: 90 }).toBase64();
		const originalProtocol = TERMINAL.imageProtocol;
		const f = fixture();
		setTerminalImageProtocol(ImageProtocol.Kitty);
		try {
			await f.controller.handleEvent({ type: "message_start", message: message("old text") });
			const component = f.ctx.streamingComponent!;
			const converted = Promise.withResolvers<Image>();
			vi.spyOn(f.ctx.ui, "requestRender").mockImplementation(() => {
				const image = (component.children[0] as Container).children.find(child => child instanceof Image);
				if (image instanceof Image) converted.resolve(image);
			});
			component.setToolResultImages("read-1", [{ type: "image", data: webp, mimeType: "image/webp" }]);
			const latest = message("latest text with native converted image");
			await f.update(latest);
			const image = await converted.promise;
			const png = Buffer.from(image.retainedBase64DataForTest!, "base64");
			expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
			const metadata = await new Bun.Image(png).metadata();
			expect(metadata.width).toBe(1);
			expect(metadata.height).toBe(1);
			const projection = vi.spyOn(component, "updateContent");
			expect(f.queued.size).toBe(1);
			f.drain();
			expect(projection).toHaveBeenCalledTimes(1);
			expect(projection).toHaveBeenLastCalledWith(latest, { streaming: true });
			expect(Bun.stripANSI(component.render(80).join("\n"))).toContain("latest text with native converted image");
			expect((component.children[0] as Container).children).toContain(image);
		} finally {
			f.controller.dispose();
			setTerminalImageProtocol(originalProtocol);
		}
	});

	for (const mode of ["normal", "forced", "input"] as const) {
		it(`prepares replacement text and deferred image double together in the first ${mode} frame`, async () => {
			await withDeferredImages(async conversions => {
				const f = fixture(true);
				let markdownNow = 1_000_000;
				__setMarkdownNowForTest(() => markdownNow);
				const editor = new Editor(defaultEditorTheme);
				f.tui.addChild(editor);
				f.tui.setFocus(editor);
				try {
					f.tui.start();
					await f.terminal.waitForRender();
					await f.controller.handleEvent({ type: "message_start", message: message("old text") });
					const component = f.ctx.streamingComponent!;
					component.setToolResultImages("read-1", [{ type: "image", data: "source", mimeType: "image/webp" }]);
					expect(conversions).toHaveLength(1);
					await f.tui.waitForRenderCommit(f.tui.requestRenderWithGeneration(true));
					const latest = message("replacement text wins over image replay");
					await f.update(latest);
					conversions[0]!.resolve("converted");
					await Promise.resolve();
					await Promise.resolve();
					markdownNow += 100;
					const frames: Array<{ text: string; image: boolean }> = [];
					const render = component.render.bind(component);
					vi.spyOn(component, "render").mockImplementation(width => {
						const image = (component.children[0] as Container).children.some(
							child => child instanceof Image && child.retainedBase64DataForTest === "converted",
						);
						const lines = render(width);
						frames.push({ text: Bun.stripANSI(lines.join("\n")), image });
						return lines;
					});
					const generation = f.tui.requestRenderWithGeneration(mode === "forced");
					if (mode === "input") f.terminal.sendInput("x");
					expect(await f.tui.waitForRenderCommit(generation)).toBe(true);
					expect(frames.length).toBeGreaterThan(0);
					expect(frames[0]!.text).toContain("replacement text wins over image replay");
					expect(frames[0]!.image).toBe(true);
					expect(f.ctx.streamingMessage).toBe(latest);
				} finally {
					f.tui.setRenderPreparationLifecycleCallbacks(undefined);
					f.controller.dispose();
					f.tui.stop();
					__setMarkdownNowForTest(undefined);
				}
			});
		});
	}

	for (const lifetime of ["historical", "restart", "reset", "dispose"] as const) {
		it(`deferred image double completion obeys ${lifetime} lifetime after a new assistant starts`, async () => {
			await withDeferredImages(async conversions => {
				const f = fixture(true);
				try {
					f.tui.start();
					await f.terminal.waitForRender();
					await f.controller.handleEvent({ type: "message_start", message: message("historical final") });
					const historical = f.ctx.streamingComponent!;
					historical.setToolResultImages("read-1", [{ type: "image", data: "source", mimeType: "image/webp" }]);
					await f.controller.handleEvent({ type: "message_end", message: message("historical final") });
					await f.controller.handleEvent({ type: "message_start", message: message("new live assistant") });
					await f.tui.waitForRenderCommit(f.tui.requestRenderWithGeneration(true));
					if (lifetime === "restart") {
						f.tui.stop();
						f.tui.start();
						await f.tui.waitForRenderCommit(f.tui.requestRenderWithGeneration(true));
					}
					if (lifetime === "reset") f.controller.resetAssistantTextPresentation();
					if (lifetime === "dispose") f.controller.dispose();
					const revision = vi.spyOn(f.ctx, "recordVisibleTranscriptMutation");
					// Publication requests a render itself; keep that origin separate from
					// the assistant image-completion repaint without suppressing either.
					let publishing = false;
					const publish = f.tui.setViewportOutputSource.bind(f.tui);
					vi.spyOn(f.tui, "setViewportOutputSource").mockImplementation(source => {
						publishing = true;
						try {
							publish(source);
						} finally {
							publishing = false;
						}
					});
					const repaintOrigins: string[] = [];
					const requestRender = f.tui.requestRender.bind(f.tui);
					const repaint = vi.spyOn(f.tui, "requestRender").mockImplementation((...args) => {
						repaintOrigins.push(publishing ? "publication" : "image");
						requestRender(...args);
					});
					revision.mockClear();
					repaint.mockClear();
					expect(conversions).toHaveLength(1);
					conversions[0]!.resolve("converted");
					await Promise.resolve();
					await Promise.resolve();
					if (lifetime === "reset" || lifetime === "dispose") {
						expect(revision).not.toHaveBeenCalled();
						expect(repaint).not.toHaveBeenCalled();
					} else {
						expect(revision).toHaveBeenCalledTimes(1);
						expect(repaintOrigins).toEqual(["publication", "image"]);
						expect((historical.children[0] as Container).children.some(child => child instanceof Image)).toBe(
							true,
						);
						await f.tui.waitForRenderCommit(f.tui.requestRenderWithGeneration(true));
					}
				} finally {
					f.tui.setRenderPreparationLifecycleCallbacks(undefined);
					f.controller.dispose();
					f.tui.stop();
				}
			});
		});
	}

	it("retains a manually scrolled viewport through pending text and resize", async () => {
		const f = fixture(true);
		try {
			for (let i = 0; i < 80; i++) f.ctx.chatContainer.addChild(new Text(`history-row-${i}`, 0, 0));
			f.tui.start();
			await f.terminal.waitForRender();
			await f.controller.handleEvent({ type: "message_start", message: message("") });
			await f.tui.waitForRenderCommit(f.tui.requestRenderWithGeneration(true));
			expect(f.tui.scrollViewportBy(-30, { pin: "stable" })).toBe(true);
			await f.tui.waitForRenderCommit(f.tui.requestRenderWithGeneration(true));
			await f.terminal.flush();
			const before = f.terminal.getViewport().map(line => Bun.stripANSI(line).trim());
			const retained = before.find(line => line.startsWith("history-row-"));
			expect(retained).toBeDefined();
			const publication = vi.spyOn(f.tui, "setViewportOutputSource");
			const component = f.ctx.streamingComponent!;
			// Resize invalidation reprojects cached content with the same streaming
			// option as deferred text, so distinguish the synchronous call origin.
			let invalidating = false;
			const invalidate = component.invalidate.bind(component);
			vi.spyOn(component, "invalidate").mockImplementation(() => {
				invalidating = true;
				try {
					invalidate();
				} finally {
					invalidating = false;
				}
			});
			const deferredProjection = vi.fn();
			const updateContent = component.updateContent.bind(component);
			vi.spyOn(component, "updateContent").mockImplementation((value, options) => {
				if (!invalidating) deferredProjection(value, options);
				updateContent(value, options);
			});
			const latest = message("new assistant output below manual viewport");
			await f.update(latest);
			expect(deferredProjection).not.toHaveBeenCalled();
			expect(publication).not.toHaveBeenCalled();
			f.terminal.resize(60, 20);
			await f.tui.waitForRenderCommit(f.tui.requestRenderWithGeneration(true));
			await f.terminal.flush();
			expect(publication).toHaveBeenCalledTimes(1);
			expect(deferredProjection).toHaveBeenCalledTimes(1);
			expect(deferredProjection).toHaveBeenCalledWith(latest, { streaming: true });
			const after = f.terminal.getViewport().map(line => Bun.stripANSI(line).trim());
			expect(f.tui.manualViewportActive).toBe(true);
			expect(after).toContain(retained!);
			expect(after.join("\n")).not.toContain("new assistant output below manual viewport");
			expect(Bun.stripANSI(f.ctx.streamingComponent!.render(60).join("\n"))).toContain(
				"new assistant output below manual viewport",
			);
		} finally {
			f.tui.setRenderPreparationLifecycleCallbacks(undefined);
			f.controller.dispose();
			f.tui.stop();
		}
	});

	for (const role of ["custom", "toolResult"] as const) {
		it(`preserves pending latest text across ${role} message_end until its frame`, async () => {
			const f = fixture();
			try {
				await f.controller.handleEvent({ type: "message_start", message: message("") });
				const component = f.ctx.streamingComponent!;
				const projection = vi.spyOn(component, "updateContent");
				const latest = message("latest");
				await f.update(latest);
				await f.controller.handleEvent({
					type: "message_end",
					message:
						role === "custom"
							? { role, customType: "hook", content: "hook output", display: true, timestamp: 2 }
							: { role, toolCallId: "read-1", toolName: "read", content: [], isError: false, timestamp: 2 },
				} as never);
				expect(f.ctx.streamingMessage).toBe(latest);
				expect(f.ctx.streamingComponent).toBe(component);
				expect(projection).not.toHaveBeenCalled();
				expect(f.queued.size).toBe(1);
				f.drain();
				expect(projection).toHaveBeenCalledTimes(1);
				expect(projection).toHaveBeenLastCalledWith(latest, { streaming: true });
				expect(Bun.stripANSI(component.render(80).join("\n"))).toContain("latest");
				f.captured[0]!();
				f.drain();
				expect(projection).toHaveBeenCalledTimes(1);
			} finally {
				f.controller.dispose();
			}
		});
	}

	for (const mutable of [false, true]) {
		it(`keeps 100 semantic visits but one latest projection (${mutable ? "mutable" : "replacement"})`, async () => {
			const f = fixture();
			let current = message("");
			associateSessionMessageEntryId(current, "stream-identity");
			await f.controller.handleEvent({ type: "message_start", message: current });
			const component = f.ctx.streamingComponent!;
			const projection = vi.spyOn(component, "updateContent");
			__eventControllerPerfCounters.enable();
			for (let burst = 0; burst < 2; burst++) {
				for (let i = 1; i <= 100; i++) {
					const text = `burst ${burst}: ${i}`;
					if (mutable) current.content = [{ type: "text", text }];
					else current = message(text);
					await f.update(current);
					expect(f.ctx.streamingMessage).toBe(current);
					expect(getSessionMessageEntryId(current)).toBe("stream-identity");
				}
				expect(projection).toHaveBeenCalledTimes(burst);
				expect(f.queued.size).toBe(1);
				f.drain();
				expect(projection).toHaveBeenLastCalledWith(current, { streaming: true });
				expect(__eventControllerPerfCounters.messageUpdateContentVisits).toBe((burst + 1) * 100);
			}
			expect(projection).toHaveBeenCalledTimes(2);
		});
	}

	for (const metadata of [
		undefined,
		{},
		{ type: "unknown", contentIndex: 0 },
		{ type: "text_start", contentIndex: 0 },
		{ type: "text_end", contentIndex: 0 },
		...[undefined, -1, 0.5, 1, NaN, Infinity, "0"].map(contentIndex => ({ type: "text_delta", contentIndex })),
		{ type: "thinking_delta", contentIndex: 0 },
		{ type: "toolcall_delta", contentIndex: 0 },
	]) {
		it(`supersedes pending projection immediately for ${JSON.stringify(metadata)}`, async () => {
			const f = fixture();
			await f.controller.handleEvent({ type: "message_start", message: message("") });
			const projection = vi.spyOn(f.ctx.streamingComponent!, "updateContent");
			await f.update(message("queued"));
			const boundary = message("boundary");
			await f.controller.handleEvent({
				type: "message_update",
				message: boundary,
				assistantMessageEvent: metadata,
			} as never);
			expect(projection).toHaveBeenCalledTimes(1);
			expect(projection).toHaveBeenLastCalledWith(boundary, { streaming: true });
			f.captured[0]!();
			expect(projection).toHaveBeenCalledTimes(1);
		});
	}

	it("rejects indexed thinking content even when metadata says text_delta", async () => {
		const f = fixture();
		await f.controller.handleEvent({ type: "message_start", message: message("") });
		const projection = vi.spyOn(f.ctx.streamingComponent!, "updateContent");
		const thinking = message("");
		thinking.content = [{ type: "thinking", thinking: "reasoning" }];
		await f.update(thinking);
		expect(projection).toHaveBeenCalledTimes(1);
		expect(f.queued.size).toBe(0);
	});

	it("flushes valid orphan text before agent_end removes the live component", async () => {
		const f = fixture();
		await f.controller.handleEvent({ type: "message_start", message: message("") });
		const component = f.ctx.streamingComponent!;
		const order: string[] = [];
		const update = component.updateContent.bind(component);
		vi.spyOn(component, "updateContent").mockImplementation((value, options) => {
			expect(f.ctx.chatContainer.hasLiveChild(component)).toBe(true);
			order.push("project");
			update(value, options);
		});
		const dispose = component.dispose.bind(component);
		vi.spyOn(component, "dispose").mockImplementation(() => {
			order.push("remove");
			dispose();
		});
		f.ctx.setWorkingMessage = vi.fn();
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		f.ctx.planModeController = {
			flushPendingModelSwitch: () => {
				entered.resolve();
				return gate.promise;
			},
		} as never;
		let stopped = false;
		f.ctx.isStopped = () => stopped;
		await f.update(message("orphan latest"));
		const pending = f.controller.handleEvent({ type: "agent_end", messages: [] } as never);
		await entered.promise;
		expect(order).toEqual(["project", "remove"]);
		expect(f.ctx.streamingMessage).toBeUndefined();
		expect(f.ctx.streamingComponent).toBeUndefined();
		f.captured[0]!();
		expect(order).toEqual(["project", "remove"]);
		stopped = true;
		gate.resolve();
		await pending;
	});

	it("processes interleaved read arguments immediately and never replays superseded text", async () => {
		const f = fixture();
		await f.controller.handleEvent({ type: "message_start", message: message("") });
		const projection = vi.spyOn(f.ctx.streamingComponent!, "updateContent");
		const argsSeen: unknown[] = [];
		f.ctx.pendingTools.set("read-1", {
			updateArgs: args => {
				argsSeen.push(args);
			},
			updateResult: vi.fn(),
			setArgsComplete: vi.fn(),
			setExpanded: vi.fn(),
			consumeVisibleTranscriptChange: () => true,
		});
		await f.update(message("queued text"));
		const read = message("text at read boundary");
		const args = { path: "/tmp/source.ts" };
		read.content.push({ type: "toolCall", id: "read-1", name: "read", arguments: args });
		await f.update(read, { type: "toolcall_delta", contentIndex: 1 });
		expect(argsSeen).toEqual([args]);
		expect(projection).toHaveBeenCalledTimes(1);
		expect(f.queued.size).toBe(0);
		const latest = message("latest after read");
		latest.content.push(read.content[1]!);
		await f.update(latest);
		expect(argsSeen).toEqual([args]);
		f.drain();
		expect(projection).toHaveBeenCalledTimes(2);
		expect(projection).toHaveBeenLastCalledWith(latest, { streaming: true });
	});

	it("a stale captured callback cannot consume newly rearmed work", async () => {
		const f = fixture();
		await f.controller.handleEvent({ type: "message_start", message: message("") });
		const projection = vi.spyOn(f.ctx.streamingComponent!, "updateContent");
		await f.update(message("old"));
		const stale = f.captured[0]!;
		f.controller.suspendAssistantTextPresentation();
		expect(f.queued.size).toBe(0);
		await f.update(message("stopped latest"));
		expect(f.queued.size).toBe(0);
		f.controller.resumeAssistantTextPresentation();
		const latest = message("newest");
		await f.update(latest);
		expect(f.queued.size).toBe(1);
		stale();
		expect(f.queued.size).toBe(1);
		f.drain();
		expect(projection).toHaveBeenCalledTimes(1);
		expect(projection).toHaveBeenLastCalledWith(latest, { streaming: true });
	});

	for (const invalidation of ["reset", "dispose", "session", "remove"] as const) {
		it(`rejects stale captured work after ${invalidation}`, async () => {
			const f = fixture();
			await f.controller.handleEvent({ type: "message_start", message: message("") });
			const component = f.ctx.streamingComponent!;
			const projection = vi.spyOn(component, "updateContent");
			await f.update(message("stale"));
			if (invalidation === "reset") f.controller.resetAssistantTextPresentation();
			if (invalidation === "dispose") f.controller.dispose();
			if (invalidation === "session") f.ctx.session = {} as never;
			if (invalidation === "remove") f.ctx.chatContainer.removeChild(component);
			f.captured[0]!();
			f.controller.resumeAssistantTextPresentation();
			f.drain();
			expect(projection).not.toHaveBeenCalled();
			if (invalidation !== "dispose") {
				await f.controller.handleEvent({ type: "message_start", message: message("") });
				const fresh = vi.spyOn(f.ctx.streamingComponent!, "updateContent");
				await f.update(message("fresh"));
				f.drain();
				expect(fresh).toHaveBeenCalledTimes(1);
			}
		});
	}

	for (const duringStop of ["none", "delta", "final", "reset", "dispose"] as const) {
		it(`real TUI restart reconstructs current text: ${duringStop}`, async () => {
			const f = fixture(true);
			try {
				f.tui.start();
				await f.terminal.waitForRender();
				await f.controller.handleEvent({ type: "message_start", message: message("") });
				const projection = vi.spyOn(f.ctx.streamingComponent!, "updateContent");
				await f.update(message("queued before stop"));
				f.tui.stop();
				expect(projection).not.toHaveBeenCalled();
				if (duringStop === "delta") await f.update(message("latest during stop"));
				if (duringStop === "final")
					await f.controller.handleEvent({ type: "message_end", message: message("authoritative final") });
				if (duringStop === "reset") f.controller.resetAssistantTextPresentation();
				if (duringStop === "dispose") f.controller.dispose();
				projection.mockClear();
				f.tui.start();
				await f.tui.waitForRenderCommit(f.tui.requestRenderWithGeneration(true));
				if (duringStop === "none" || duringStop === "delta") {
					expect(projection).toHaveBeenCalledTimes(1);
					expect(f.terminal.getWriteLog().join("")).toContain(
						duringStop === "none" ? "queued before stop" : "latest during stop",
					);
				} else expect(projection).not.toHaveBeenCalled();
			} finally {
				f.tui.setRenderPreparationLifecycleCallbacks(undefined);
				f.controller.dispose();
				f.tui.stop();
			}
		});
	}
});
