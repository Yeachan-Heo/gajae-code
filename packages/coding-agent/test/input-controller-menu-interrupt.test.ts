import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "bun:test";
import { Effort, getBundledModel } from "@gajae-code/ai";
import { KeybindingsManager } from "@gajae-code/coding-agent/config/keybindings";
import type { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { CommandPaletteComponent } from "@gajae-code/coding-agent/modes/components/command-palette";
import { CustomEditor } from "@gajae-code/coding-agent/modes/components/custom-editor";
import { ModelSelectorComponent } from "@gajae-code/coding-agent/modes/components/model-selector";
import { EventController } from "@gajae-code/coding-agent/modes/controllers/event-controller";
import { InputController } from "@gajae-code/coding-agent/modes/controllers/input-controller";
import { SelectorController } from "@gajae-code/coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { type Component, Container, type KeyId, matchesKey, setKeybindings, TUI } from "@gajae-code/tui";
import { defaultEditorTheme } from "../../tui/test/test-themes";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { ThemeSelectorComponent } from "../src/modes/components/theme-selector";
import { MCPCommandController } from "../src/modes/controllers/runtime-mcp-command-controller";
import * as smitheryAuth from "../src/runtime-mcp/smithery-auth";
import * as openUtils from "../src/utils/open";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	await initTheme(false);
});
afterAll(() => {
	resetSettingsForTest();
});
afterEach(() => {
	setKeybindings(KeybindingsManager.inMemory());
	vi.restoreAllMocks();
});

function createHarness(interrupt: KeyId | KeyId[] = "escape", clear: KeyId | KeyId[] = "ctrl+c") {
	const terminal = new VirtualTerminal(100, 40);
	const ui = new TUI(terminal);
	const keybindings = KeybindingsManager.inMemory({ "app.interrupt": interrupt, "app.clear": clear });
	setKeybindings(keybindings);
	const editor = new CustomEditor(defaultEditorTheme);
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	const abortCompaction = vi.fn();
	const abortHandoff = vi.fn();
	const retryNow = vi.fn();
	const abortRetry = vi.fn();
	const abort = vi.fn(async () => {});
	const abortBash = vi.fn();
	const abortEval = vi.fn();
	const handleBtwEscape = vi.fn(() => true);
	const hasActiveBtw = vi.fn(() => false);
	const session = {
		isCompacting: false,
		isGeneratingHandoff: false,
		isRetrying: false,
		isStreaming: false,
		isBashRunning: false,
		isEvalRunning: false,
		drainableQueuedMessageCount: 0,
		hasQueuedSteering: false,
		abortCompaction,
		abortHandoff,
		retryNow,
		abortRetry,
		abort,
		abortBash,
		abortEval,
		modelRegistry: { authStorage: { set: async () => {} } },
	};
	const ctx = {
		ui,
		editor,
		editorContainer,
		keybindings,
		session,
		settings: Settings.isolated(),
		pendingImages: [],
		isInitialized: true,
		chatContainer: new Container(),
		statusContainer: new Container(),
		hasActiveBtw,
		handleBtwEscape,
		cancelPendingSubmission: () => false,
		hasPendingSubmission: () => false,
		updateEditorBorderColor: () => {},
		updateEditorTopBorder: () => {},
		statusLine: { invalidate() {} },
		showStatus: () => {},
		showError: () => {},
		beginOAuthUrlForCopy: () => () => {},
		restoreComposer: () => {
			editorContainer.clear();
			editorContainer.addChild(editor);
			ui.setFocus(editor);
		},
	} as unknown as InteractiveModeContext;
	const input = new InputController(ctx);
	input.setupKeyHandlers();
	const events = new EventController(ctx);
	const selectors = new SelectorController(ctx);
	ui.addChild(editorContainer);
	ui.setFocus(editor);
	ui.start();
	return {
		terminal,
		ui,
		editor,
		ctx,
		session,
		input,
		events,
		selectors,
		spies: {
			abortCompaction,
			abortHandoff,
			retryNow,
			abortRetry,
			abort,
			abortBash,
			abortEval,
			handleBtwEscape,
			hasActiveBtw,
		},
		close: () => {
			events.dispose();
			editor.dispose();
			ui.stop();
		},
	};
}

function mountMenu(
	h: { ui: TUI; ctx: InteractiveModeContext; selectors: SelectorController },
	overlay = false,
	cancelKey: KeyId = "escape",
) {
	const cancel = vi.fn();
	let depth = 0;
	let close = () => {};
	const menu: Component = {
		invalidate() {},
		render: () => [depth ? "Nested menu" : "Menu"],
		handleInput: data => {
			if (matchesKey(data, "enter")) depth++;
			else if (matchesKey(data, cancelKey)) {
				if (depth > 0) depth--;
				else {
					cancel();
					close();
				}
			}
		},
	};
	if (overlay) {
		const handle = h.ui.showOverlay(menu);
		close = () => handle.hide();
	} else {
		h.selectors.showSelector(done => {
			close = done;
			return { component: menu, focus: menu };
		});
	}
	return { menu, cancel, depth: () => depth };
}

const maintenanceCases = ["manual compact", "manual handoff", "retry", "loader cleanup", "handler cleanup"] as const;
describe("focused menus own interrupt before background work", () => {
	for (const overlay of [false, true]) {
		for (const state of maintenanceCases) {
			test(`${overlay ? "overlay" : "selector"}: ${state}`, () => {
				const h = createHarness();
				try {
					if (state === "manual compact") h.session.isCompacting = true;
					if (state === "manual handoff") h.session.isGeneratingHandoff = true;
					if (state === "retry") h.session.isRetrying = true;
					if (state === "loader cleanup")
						h.ctx.autoCompactionLoader = { stop() {} } as InteractiveModeContext["autoCompactionLoader"];
					if (state === "handler cleanup") h.ctx.autoCompactionEscapeHandler = () => {};
					const m = mountMenu(h, overlay);
					h.terminal.sendInput("\x1b");
					expect(m.cancel).toHaveBeenCalledTimes(1);
					expect(h.spies.abortCompaction).not.toHaveBeenCalled();
					expect(h.spies.abortHandoff).not.toHaveBeenCalled();
					expect(h.spies.retryNow).not.toHaveBeenCalled();
					h.terminal.sendInput("\x1b");
					if (state === "manual handoff") expect(h.spies.abortHandoff).toHaveBeenCalledTimes(1);
					else if (state === "retry") {
						expect(h.spies.retryNow).toHaveBeenCalledTimes(1);
						h.terminal.sendInput("\x1b");
						expect(h.spies.abortRetry).toHaveBeenCalledTimes(1);
					} else expect(h.spies.abortCompaction).toHaveBeenCalledTimes(1);
				} finally {
					h.close();
				}
			});
		}
	}

	for (const reason of ["threshold", "overflow", "idle"] as const) {
		for (const menuFirst of [false, true]) {
			test(`auto compact ${reason}, menu ${menuFirst ? "before" : "after"} start event`, async () => {
				const h = createHarness();
				try {
					const m = menuFirst ? mountMenu(h) : undefined;
					h.session.isCompacting = true;
					await h.events.handleEvent({ type: "auto_compaction_start", reason, action: "context-full" });
					const active = m ?? mountMenu(h);
					h.terminal.sendInput("\x1b");
					expect(active.cancel).toHaveBeenCalledTimes(1);
					expect(h.spies.abortCompaction).not.toHaveBeenCalled();
					h.terminal.sendInput("\x1b");
					expect(h.spies.abortCompaction).toHaveBeenCalledTimes(1);
				} finally {
					h.close();
				}
			});
		}
	}

	test("auto handoff event keeps menu cancellation local", async () => {
		const h = createHarness();
		try {
			h.session.isCompacting = true;
			h.session.isGeneratingHandoff = true;
			await h.events.handleEvent({ type: "auto_compaction_start", reason: "threshold", action: "handoff" });
			const m = mountMenu(h);
			h.terminal.sendInput("\x1b");
			expect(m.cancel).toHaveBeenCalledTimes(1);
			expect(h.spies.abortCompaction).not.toHaveBeenCalled();
			h.terminal.sendInput("\x1b");
			expect(h.spies.abortCompaction).toHaveBeenCalledTimes(1);
		} finally {
			h.close();
		}
	});

	test("retry event does not skip backoff or prime cancellation behind a menu", async () => {
		const h = createHarness();
		try {
			await h.events.handleEvent({
				type: "auto_retry_start",
				attempt: 1,
				maxAttempts: 3,
				delayMs: 10_000,
				errorMessage: "rate limit",
			});
			const m = mountMenu(h);
			h.terminal.sendInput("\x1b");
			expect(m.cancel).toHaveBeenCalledTimes(1);
			expect(h.spies.retryNow).not.toHaveBeenCalled();
			expect(h.ctx.retryEscapePrimed).toBe(false);
			h.terminal.sendInput("\x1b");
			expect(h.spies.retryNow).toHaveBeenCalledTimes(1);
			h.terminal.sendInput("\x1b");
			expect(h.spies.abortRetry).toHaveBeenCalledTimes(1);
		} finally {
			h.close();
		}
	});

	test("nested back action and stacked overlays are handled one level at a time", () => {
		const h = createHarness();
		try {
			h.session.isCompacting = true;
			const lower = mountMenu(h, true);
			h.terminal.sendInput("\r");
			const upper = mountMenu(h, true);
			h.terminal.sendInput("\x1b");
			expect(upper.cancel).toHaveBeenCalledTimes(1);
			expect(h.ui.getFocusedComponent()).toBe(lower.menu);
			h.terminal.sendInput("\x1b");
			expect(lower.depth()).toBe(0);
			expect(lower.cancel).not.toHaveBeenCalled();
			h.terminal.sendInput("\x1b");
			expect(lower.cancel).toHaveBeenCalledTimes(1);
			expect(h.spies.abortCompaction).not.toHaveBeenCalled();
			h.terminal.sendInput("\x1b");
			expect(h.spies.abortCompaction).toHaveBeenCalledTimes(1);
		} finally {
			h.close();
		}
	});

	test("a focused menu wins over BTW and stale hook flags", () => {
		const h = createHarness();
		try {
			h.spies.hasActiveBtw.mockReturnValue(true);
			h.session.isCompacting = true;
			h.ctx.hookSelector = {} as InteractiveModeContext["hookSelector"];
			const m = mountMenu(h);
			h.terminal.sendInput("\x1b");
			expect(m.cancel).toHaveBeenCalledTimes(1);
			expect(h.spies.handleBtwEscape).not.toHaveBeenCalled();
			expect(h.spies.abortCompaction).not.toHaveBeenCalled();
			h.terminal.sendInput("\x1b");
			expect(h.spies.handleBtwEscape).toHaveBeenCalledTimes(1);
		} finally {
			h.close();
		}
	});

	test("remapped interrupt belongs to the focused menu; raw Esc still closes an Esc menu", () => {
		const h = createHarness("ctrl+x");
		try {
			h.session.isCompacting = true;
			const remapped = mountMenu(h, false, "ctrl+x");
			h.terminal.sendInput("\x18");
			expect(remapped.cancel).toHaveBeenCalledTimes(1);
			expect(h.spies.abortCompaction).not.toHaveBeenCalled();
			const raw = mountMenu(h);
			h.terminal.sendInput("\x1b");
			expect(raw.cancel).toHaveBeenCalledTimes(1);
			h.terminal.sendInput("\x18");
			expect(h.spies.abortCompaction).toHaveBeenCalledTimes(1);
		} finally {
			h.close();
		}
	});

	for (const binding of [
		{ interrupt: ["escape", "ctrl+c"] as KeyId[], clear: "ctrl+c" as KeyId, key: "ctrl+c" as KeyId, data: "\x03" },
		{
			interrupt: ["escape", "ctrl+x"] as KeyId[],
			clear: ["ctrl+c", "ctrl+x"] as KeyId[],
			key: "ctrl+x" as KeyId,
			data: "\x18",
		},
	]) {
		for (const state of ["compaction", "handoff", "retry"] as const) {
			test(`overlapping ${binding.key} remains global clear during ${state}`, () => {
				const h = createHarness(binding.interrupt, binding.clear);
				try {
					h.session.isCompacting = state === "compaction";
					h.session.isGeneratingHandoff = state === "handoff";
					h.session.isRetrying = state === "retry";
					const m = mountMenu(h, true, binding.key);
					h.terminal.sendInput(binding.data);
					expect(m.cancel).not.toHaveBeenCalled();
					if (state === "compaction") expect(h.spies.abortCompaction).toHaveBeenCalledTimes(1);
					else if (state === "handoff") expect(h.spies.abortHandoff).toHaveBeenCalledTimes(1);
					else {
						expect(h.spies.abortRetry).toHaveBeenCalledTimes(1);
						expect(h.spies.retryNow).not.toHaveBeenCalled();
					}
				} finally {
					h.close();
				}
			});
		}
	}

	test("hidden overlay restores work interrupt ownership", () => {
		const h = createHarness();
		try {
			h.session.isCompacting = true;
			const local = vi.fn();
			const handle = h.ui.showOverlay({ invalidate() {}, render: () => ["Hidden menu"], handleInput: local });
			handle.setHidden(true);
			expect(h.ui.getFocusedComponent()).toBe(h.editor);
			h.terminal.sendInput("\x1b");
			expect(local).not.toHaveBeenCalled();
			expect(h.spies.abortCompaction).toHaveBeenCalledTimes(1);
		} finally {
			h.close();
		}
	});

	test("a menu does not clear or consume an already-primed retry gesture", () => {
		const h = createHarness();
		try {
			h.session.isRetrying = true;
			h.terminal.sendInput("\x1b");
			expect(h.spies.retryNow).toHaveBeenCalledTimes(1);
			const m = mountMenu(h, true);
			h.terminal.sendInput("\x1b");
			expect(m.cancel).toHaveBeenCalledTimes(1);
			expect(h.ctx.retryEscapePrimed).toBe(true);
			expect(h.spies.abortRetry).not.toHaveBeenCalled();
			h.terminal.sendInput("\x1b");
			expect(h.spies.abortRetry).toHaveBeenCalledTimes(1);
		} finally {
			h.close();
		}
	});

	test("Ctrl+C retains global abort semantics while a menu is focused", () => {
		const h = createHarness();
		try {
			h.session.isCompacting = true;
			const m = mountMenu(h);
			h.terminal.sendInput("\x03");
			expect(h.spies.abortCompaction).toHaveBeenCalledTimes(1);
			expect(m.cancel).not.toHaveBeenCalled();
		} finally {
			h.close();
		}
	});

	test("focused hook option list still interrupts workflow, inline input stays local", () => {
		const h = createHarness();
		try {
			let inline = false;
			const local = vi.fn();
			const hook = {
				invalidate() {},
				render: () => ["Hook"],
				handleInput: local,
				hasActiveInlineInput: () => inline,
			};
			h.ctx.hookSelector = hook as unknown as InteractiveModeContext["hookSelector"];
			h.ui.setFocus(hook);
			h.session.isStreaming = true;
			h.terminal.sendInput("\x1b");
			expect(h.spies.abort).toHaveBeenCalledTimes(1);
			expect(local).not.toHaveBeenCalled();
			inline = true;
			h.session.isCompacting = true;
			h.terminal.sendInput("\x1b");
			expect(local).toHaveBeenCalledTimes(1);
			expect(h.spies.abortCompaction).not.toHaveBeenCalled();
		} finally {
			h.close();
		}
	});

	test("ordinary streaming, bash and eval menus cancel locally", () => {
		const h = createHarness();
		try {
			for (const state of ["isStreaming", "isBashRunning", "isEvalRunning"] as const) {
				h.session[state] = true;
				const m = mountMenu(h);
				h.terminal.sendInput("\x1b");
				expect(m.cancel).toHaveBeenCalledTimes(1);
				h.session[state] = false;
			}
			expect(h.spies.abort).not.toHaveBeenCalled();
			expect(h.spies.abortBash).not.toHaveBeenCalled();
			expect(h.spies.abortEval).not.toHaveBeenCalled();
		} finally {
			h.close();
		}
	});

	test("real model selector and palette cancel callbacks receive TUI input during compaction", async () => {
		const h = createHarness();
		try {
			const model = {
				...getBundledModel("anthropic", "claude-sonnet-4-5"),
				reasoning: true,
				thinking: { minLevel: Effort.Low, maxLevel: Effort.XHigh, mode: "anthropic-adaptive" as const },
			};
			const registry = {
				getAll: () => [model],
				hasConfiguredProviderAuth: () => false,
				getDiscoverableProviders: () => [],
				getCanonicalModels: () => [],
				getCanonicalModelSelections: () => [],
				resolveCanonicalModel: () => undefined,
			} as unknown as ModelRegistry;
			h.session.isCompacting = true;
			const cancelled = vi.fn();
			h.selectors.showSelector(done => {
				const selector = new ModelSelectorComponent(
					h.ui,
					model,
					Settings.isolated(),
					registry,
					[{ model, thinkingLevel: "off" }],
					() => {},
					() => {
						cancelled();
						done();
					},
				);
				return { component: selector, focus: selector };
			});
			await Bun.sleep(0);
			const focused = h.ui.getFocusedComponent();
			if (!(focused instanceof ModelSelectorComponent)) throw new Error("Expected focused model selector");
			h.terminal.sendInput("\r");
			expect(focused.render(100).join("\n")).toContain("Action for:");
			h.terminal.sendInput("\r");
			expect(focused.render(100).join("\n")).toContain("Reasoning for Default");
			h.terminal.sendInput("\x1b");
			expect(focused.render(100).join("\n")).toContain("Action for:");
			h.terminal.sendInput("\x1b");
			expect(cancelled).not.toHaveBeenCalled();
			h.terminal.sendInput("\x1b");
			expect(cancelled).toHaveBeenCalledTimes(1);
			const paletteCancelled = vi.fn();
			h.selectors.showSelector(done => {
				const palette = new CommandPaletteComponent(
					[],
					() => {},
					() => {
						paletteCancelled();
						done();
					},
				);
				return { component: palette, focus: palette };
			});
			h.terminal.sendInput("\x1b");
			expect(paletteCancelled).toHaveBeenCalledTimes(1);
			expect(h.spies.abortCompaction).not.toHaveBeenCalled();
		} finally {
			h.close();
		}
	});

	test("focused inner SelectList runs theme preview rollback instead of cancelling compaction", () => {
		const h = createHarness();
		let preview = "original";
		try {
			h.session.isCompacting = true;
			h.selectors.showSelector(done => {
				const selector = new ThemeSelectorComponent(
					"original",
					["original", "preview"],
					() => {},
					() => {
						preview = "original";
						done();
					},
					name => {
						preview = name;
					},
				);
				return { component: selector, focus: selector.getSelectList() };
			});
			h.terminal.sendInput("\x1b[B");
			expect(preview).toBe("preview");
			h.terminal.sendInput("\x1b");
			expect(preview).toBe("original");
			expect(h.ui.getFocusedComponent()).toBe(h.editor);
			expect(h.spies.abortCompaction).not.toHaveBeenCalled();
		} finally {
			h.close();
		}
	});

	test("auto compaction cleanup while a menu is open preserves local cancellation", async () => {
		const h = createHarness();
		try {
			h.ctx.flushCompactionQueue = async () => {};
			h.session.isCompacting = true;
			await h.events.handleEvent({ type: "auto_compaction_start", reason: "overflow", action: "context-full" });
			const m = mountMenu(h);
			h.session.isCompacting = false;
			await h.events.handleEvent({
				type: "auto_compaction_end",
				action: "context-full",
				result: undefined,
				aborted: true,
				willRetry: false,
			});
			h.terminal.sendInput("\x1b");
			expect(m.cancel).toHaveBeenCalledTimes(1);
			expect(h.spies.abortCompaction).not.toHaveBeenCalled();
		} finally {
			h.close();
		}
	});

	for (const kind of ["hookInput", "hookEditor"] as const) {
		test(`focused ${kind} retains workflow interrupt rather than ordinary menu priority`, () => {
			const h = createHarness();
			try {
				const local = vi.fn();
				const hook = { invalidate() {}, render: () => ["Workflow input"], handleInput: local };
				Object.assign(h.ctx, { [kind]: hook });
				h.ui.setFocus(hook);
				h.session.isStreaming = true;
				h.terminal.sendInput("\x1b");
				expect(h.spies.abort).toHaveBeenCalledTimes(1);
				expect(local).not.toHaveBeenCalled();
			} finally {
				h.close();
			}
		});
	}

	test("finished work does not change local menu cancellation or clear the draft", () => {
		const h = createHarness();
		try {
			h.editor.setText("preserved draft");
			h.session.isCompacting = true;
			const m = mountMenu(h);
			h.session.isCompacting = false;
			h.terminal.sendInput("\x1b");
			expect(m.cancel).toHaveBeenCalledTimes(1);
			expect(h.editor.getText()).toBe("preserved draft");
			expect(h.spies.abortCompaction).not.toHaveBeenCalled();
		} finally {
			h.close();
		}
	});

	for (const clearOverlap of [false, true]) {
		test(`Smithery authorization respects menu Esc and ${clearOverlap ? "overlapping clear" : "composer interrupt"}`, async () => {
			const h = clearOverlap ? createHarness(["escape", "ctrl+x"], ["ctrl+c", "ctrl+x"]) : createHarness();
			const started = Promise.withResolvers<AbortSignal>();
			vi.spyOn(openUtils, "openPath").mockImplementation(() => {});
			vi.spyOn(smitheryAuth, "createSmitheryCliAuthSession").mockResolvedValue({
				sessionId: "test-session",
				authUrl: "https://smithery.example.test/login",
			});
			vi.spyOn(smitheryAuth, "pollSmitheryCliAuthSession").mockImplementation(async (_id, signal) => {
				if (!signal) throw new Error("missing signal");
				const pending = Promise.withResolvers<{ status: "pending" }>();
				signal.addEventListener("abort", () => pending.reject(signal.reason), { once: true });
				started.resolve(signal);
				return pending.promise;
			});
			const fallback = vi.fn(async () => undefined);
			h.ctx.showHookInput = fallback;
			let warning = "";
			h.ctx.showWarning = text => {
				warning = text;
			};
			const operation = new MCPCommandController(h.ctx).handle("/mcp smithery-login");
			try {
				const signal = await Promise.race([
					started.promise,
					operation.then(() => {
						throw new Error(`Authorization never started: ${warning}`);
					}),
				]);
				const m = mountMenu(h, true);
				h.terminal.sendInput("\x1b");
				expect(m.cancel).toHaveBeenCalledTimes(1);
				expect(signal.aborted).toBe(false);
				if (clearOverlap) {
					const secondMenu = mountMenu(h, true, "ctrl+x");
					h.terminal.sendInput("\x18");
					expect(secondMenu.cancel).not.toHaveBeenCalled();
				} else h.terminal.sendInput("\x1b");
				expect(signal.aborted).toBe(true);
				await operation;
				expect(fallback).toHaveBeenCalledTimes(1);
			} finally {
				h.terminal.sendInput("\x03");
				await operation;
				h.close();
			}
		});
	}

	for (const clearOverlap of [false, true]) {
		test(`non-wizard OAuth respects menu interrupt and ${clearOverlap ? "overlapping remapped clear" : "composer interrupt"}`, async () => {
			const h = clearOverlap ? createHarness(["escape", "ctrl+x"], ["ctrl+c", "ctrl+x"]) : createHarness();
			const controller = new MCPCommandController(h.ctx);
			const started = Promise.withResolvers<AbortSignal>();
			const operation = controller.handleOAuthFlow(
				"https://mcp.example.test",
				"https://auth.example.test/authorize",
				"https://auth.example.test/token",
				"test-client",
				"",
				"",
				undefined,
				undefined,
				undefined,
				undefined,
				(config, callbacks) => ({
					resolvedClientId: config.clientId,
					registeredClientSecret: undefined,
					login: async () => {
						const signal = callbacks.signal;
						if (!signal) throw new Error("missing signal");
						const pending = Promise.withResolvers<never>();
						signal.addEventListener("abort", () => pending.reject(signal.reason), { once: true });
						started.resolve(signal);
						return pending.promise;
					},
				}),
				() => {},
			);
			const outcome = operation.then(
				() => "unexpected success",
				error => String(error),
			);
			try {
				const signal = await started.promise;
				const m = mountMenu(h, true);
				h.terminal.sendInput("\x1b");
				expect(m.cancel).toHaveBeenCalledTimes(1);
				expect(signal.aborted).toBe(false);
				if (clearOverlap) {
					const secondMenu = mountMenu(h, true, "ctrl+x");
					h.terminal.sendInput("\x18");
					expect(secondMenu.cancel).not.toHaveBeenCalled();
				} else h.terminal.sendInput("\x1b");
				expect(signal.aborted).toBe(true);
			} finally {
				h.terminal.sendInput("\x03");
				expect(await outcome).toContain("OAuth flow cancelled");
				h.close();
			}
		});
	}
});
