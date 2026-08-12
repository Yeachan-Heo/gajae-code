import { beforeAll, describe, expect, it, vi } from "bun:test";
import { ExecutionPresetStore } from "../src/config/execution-preset";
import { ExecutionPresetSelectorComponent } from "../src/modes/components/execution-preset-selector";
import { SelectorController } from "../src/modes/controllers/selector-controller";
import { initTheme } from "../src/modes/theme/theme";
import type { InteractiveModeContext } from "../src/modes/types";
import {
	BUILTIN_SLASH_COMMAND_DEFS,
	BUILTIN_SLASH_COMMANDS_INTERNAL,
	executeBuiltinSlashCommand,
} from "../src/slash-commands/builtin-registry";
import { TaskExecutionPolicyController } from "../src/task/execution-policy";

interface HostHarness {
	readonly controller: TaskExecutionPolicyController | undefined;
	readonly store: ExecutionPresetStore;
	readonly showExecutionPresetSelector: () => void;
	readonly mounted: () => unknown;
	readonly restoreComposer: ReturnType<typeof vi.fn>;
	readonly showStatus: ReturnType<typeof vi.fn>;
	readonly setText: ReturnType<typeof vi.fn>;
}

function createHost(controller: TaskExecutionPolicyController | undefined): HostHarness {
	const store = new ExecutionPresetStore({ scope: "session" });
	const restoreComposer = vi.fn();
	const showStatus = vi.fn();
	const setText = vi.fn();
	const editor = { setText };
	let child: unknown;
	const editorContainer = {
		clear: vi.fn(() => {
			child = undefined;
		}),
		addChild: vi.fn((next: unknown) => {
			child = next;
		}),
	};
	restoreComposer.mockImplementation(() => {
		child = editor;
	});
	const ctx = {
		session: {},
		editor,
		editorContainer,
		restoreComposer,
		showStatus,
		ui: { setFocus: vi.fn(), requestRender: vi.fn() },
		keybindings: { getDisplayString: vi.fn(() => "") },
	} as unknown as InteractiveModeContext;
	const selectorController = new SelectorController(ctx);
	const showExecutionPresetSelector = (): void => {
		if (!controller) {
			showStatus("Execution presets are unavailable in this session");
			return;
		}
		selectorController.showExecutionPresetSelector({
			store,
			controller,
			scope: "session",
			scopes: ["session"],
		});
	};
	return {
		controller,
		store,
		showExecutionPresetSelector,
		mounted: () => child,
		restoreComposer,
		showStatus,
		setText,
	};
}

async function settle(): Promise<void> {
	await Bun.sleep(0);
	await Bun.sleep(0);
}

beforeAll(async () => {
	await initTheme(false, undefined, undefined, "red-claw", "blue-crab");
});

describe("execution preset production host", () => {
	it("registers a UI-only zero-argument slash command", async () => {
		const command = BUILTIN_SLASH_COMMANDS_INTERNAL.find(candidate => candidate.name === "execution-presets");
		expect(command).toBeDefined();
		expect(command?.handleTui).toBeTypeOf("function");
		expect(command?.handle).toBeUndefined();
		expect(command?.allowArgs).not.toBe(true);
		expect(BUILTIN_SLASH_COMMAND_DEFS.find(candidate => candidate.name === "execution-presets")).toEqual({
			name: "execution-presets",
			description: "Select an execution preset for this session",
		});

		const host = createHost(new TaskExecutionPolicyController());
		const runtime = {
			ctx: {
				showExecutionPresetSelector: host.showExecutionPresetSelector,
				editor: { setText: host.setText },
			},
			handleBackgroundCommand: () => undefined,
		} as unknown as Parameters<typeof executeBuiltinSlashCommand>[1];
		expect(await executeBuiltinSlashCommand("/execution-presets", runtime)).toBe(true);
		expect(host.setText).toHaveBeenCalledWith("");
		expect(host.mounted()).toBeInstanceOf(ExecutionPresetSelectorComponent);
		expect(await executeBuiltinSlashCommand("/execution-presets extra", runtime)).toBe(false);
	});

	it("mounts the real selector, applies to the bound controller, and restores the editor on Escape", async () => {
		const controller = new TaskExecutionPolicyController();
		const host = createHost(controller);
		host.showExecutionPresetSelector();
		const selector = host.mounted();
		expect(selector).toBeInstanceOf(ExecutionPresetSelectorComponent);
		if (!(selector instanceof ExecutionPresetSelectorComponent))
			throw new Error("Execution preset selector was not mounted");

		selector.handleInput("\n");
		selector.handleInput("\n");
		await settle();
		const secureReview = host.store.get("secure-review");
		if (!secureReview) throw new Error("Secure review preset was not listed");
		expect(controller.getSnapshot().policy).toEqual(secureReview.policy);

		expect(controller.getSnapshot().revision).toBeGreaterThan(0);
		expect(selector.getScope()).toBe("session");
		selector.handleInput("\x1b");
		selector.handleInput("\x1b");
		expect(host.restoreComposer).toHaveBeenCalledTimes(1);
	});

	it("fails safely without a controller and isolates session stores and controllers", async () => {
		const missing = createHost(undefined);
		missing.showExecutionPresetSelector();
		expect(missing.showStatus).toHaveBeenCalledWith("Execution presets are unavailable in this session");
		expect(missing.mounted()).toBeUndefined();

		const first = createHost(new TaskExecutionPolicyController());
		const second = createHost(new TaskExecutionPolicyController());
		first.showExecutionPresetSelector();
		const firstSelector = first.mounted();
		if (!(firstSelector instanceof ExecutionPresetSelectorComponent))
			throw new Error("First selector was not mounted");
		firstSelector.handleInput("\n");
		firstSelector.handleInput("\n");
		await settle();
		const firstSecureReview = first.store.get("secure-review");
		const secondSecureReview = second.store.get("secure-review");
		if (!firstSecureReview || !secondSecureReview) throw new Error("Secure review preset was not listed");
		expect(first.controller?.getSnapshot().policy).toEqual(firstSecureReview.policy);
		expect(second.controller?.getSnapshot().policy).not.toEqual(secondSecureReview.policy);
	});
});
