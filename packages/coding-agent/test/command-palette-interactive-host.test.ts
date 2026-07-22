import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { KeybindingsManager } from "@gajae-code/coding-agent/config/keybindings";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import type { LoadedCustomCommand } from "@gajae-code/coding-agent/extensibility/custom-commands";
import {
	ExtensionRunner,
	loadExtensions,
	type RegisteredCommand,
} from "@gajae-code/coding-agent/extensibility/extensions";
import type { Skill } from "@gajae-code/coding-agent/extensibility/skills";
import { CommandPaletteComponent } from "@gajae-code/coding-agent/modes/components/command-palette";
import { InteractiveMode } from "@gajae-code/coding-agent/modes/interactive-mode";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { HistoryStorage } from "@gajae-code/coding-agent/session/history-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import * as titleGenerator from "@gajae-code/coding-agent/utils/title-generator";
import { setKeybindings } from "@gajae-code/tui";
import { TempDir } from "@gajae-code/utils";
import { ModelRegistry } from "../src/config/model-registry";

interface InteractivePaletteHost {
	tempDir: TempDir;
	authStorage: AuthStorage;
	session: AgentSession;
	mode: InteractiveMode;
	focus: Mock<InteractiveMode["ui"]["setFocus"]>;
	titlePushed: boolean;
	disposed?: boolean;
	readonly inputPromise?: Promise<void>;
	resetInputPromise(): void;
	dispatches: {
		builtin: Mock<InteractiveMode["handleChangelogCommand"]>;
		extension: Mock<() => Promise<void>>;
		custom: Mock<() => Promise<undefined>>;
		skill: Mock<AgentSession["promptCustomMessage"]>;
		extensionError: Mock<ExtensionRunner["emitError"]>;
	};
}
interface DispatchMock {
	mock: {
		calls: readonly unknown[][];
	};
}

type PartialInteractivePaletteHost = Partial<InteractivePaletteHost>;

const STARTUP_OVERRIDES = {
	"pet.mode": "off",
	"starReminder.enabled": false,
	"startup.quiet": true,
	"tasksPane.defaultVisible": false,
};

let hosts: InteractivePaletteHost[] = [];
let initializingHost: PartialInteractivePaletteHost | undefined;

beforeAll(() => initTheme());

beforeEach(async () => {
	resetSettingsForTest();
	vi.spyOn(KeybindingsManager, "create").mockImplementation(() => {
		const manager = KeybindingsManager.inMemory();
		setKeybindings(manager);
		return manager;
	});
	vi.spyOn(titleGenerator, "pushTerminalTitle").mockImplementation(() => {
		if (!initializingHost) throw new Error("Terminal title pushed outside an owned palette host");
		initializingHost.titlePushed = true;
	});
	vi.spyOn(titleGenerator, "setSessionTerminalTitle").mockImplementation(() => {});
	vi.spyOn(titleGenerator, "popTerminalTitle").mockImplementation(() => {});
	await Settings.init({ inMemory: true, overrides: STARTUP_OVERRIDES });
});

async function disposeHost(host: PartialInteractivePaletteHost): Promise<void> {
	if (host.disposed) return;
	host.disposed = true;
	const errors: unknown[] = [];
	const cleanUp = async (operation: () => void | Promise<void>): Promise<void> => {
		try {
			await operation();
		} catch (error) {
			errors.push(error);
		}
	};

	if (host.titlePushed) {
		host.titlePushed = false;
		await cleanUp(() => titleGenerator.popTerminalTitle());
	}
	await cleanUp(() => host.mode?.stop());
	await cleanUp(() => host.session?.abort());
	await cleanUp(() => host.session?.dispose());
	await cleanUp(() => host.authStorage?.close());
	await cleanUp(() => host.tempDir?.removeSync());

	if (errors.length > 0) throw new AggregateError(errors, "Failed to dispose palette host");
}

afterEach(async () => {
	const cleanupErrors: unknown[] = [];
	try {
		for (const host of hosts) {
			try {
				await disposeHost(host);
			} catch (error) {
				cleanupErrors.push(error);
			}
		}
	} finally {
		hosts = [];
		HistoryStorage.resetInstance();
		setKeybindings(KeybindingsManager.inMemory());
		resetSettingsForTest();
		vi.restoreAllMocks();
	}
	if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Failed to clean up palette hosts");
});
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
		await Bun.sleep(1);
	}
}

async function waitForPaletteCommandGuardToClear(host: InteractivePaletteHost): Promise<void> {
	let probe: CommandPaletteComponent | undefined;
	try {
		await waitFor(() => {
			host.mode.editor.handleInput("\u0010");
			const component = host.mode.editorContainer.children[0];
			if (!(component instanceof CommandPaletteComponent)) return false;
			probe = component;
			return true;
		}, "the palette command guard to clear");
	} finally {
		probe?.handleInput("\u001b");
	}
}

async function createHost(): Promise<InteractivePaletteHost> {
	const partialHost: PartialInteractivePaletteHost = {
		tempDir: TempDir.createSync("@gjc-command-palette-host-"),
	};
	try {
		const tempDir = partialHost.tempDir;
		if (!tempDir) throw new Error("Expected a temporary directory");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		partialHost.authStorage = authStorage;
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 in the test model registry");

		const extension = vi.fn(async () => {});
		const extensionCommand = {
			name: "extension:demo",
			description: "Extension command",
			handler: extension,
		} satisfies RegisteredCommand;
		const loadedExtensions = await loadExtensions([], tempDir.path());
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const extensionRunner = new ExtensionRunner(
			loadedExtensions.extensions,
			loadedExtensions.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);
		vi.spyOn(extensionRunner, "getRegisteredCommands").mockReturnValue([extensionCommand]);
		vi.spyOn(extensionRunner, "getCommand").mockImplementation(name =>
			name === extensionCommand.name ? extensionCommand : undefined,
		);
		const extensionError = vi.spyOn(extensionRunner, "emitError").mockImplementation(() => {});

		const custom = vi.fn(async () => undefined);
		const customCommands: LoadedCustomCommand[] = [
			{
				path: "custom-demo.ts",
				resolvedPath: path.join(tempDir.path(), "custom-demo.ts"),
				source: "project",
				command: { name: "custom:demo", description: "Custom command", execute: custom },
			},
			{
				path: "duplicate-extension.ts",
				resolvedPath: path.join(tempDir.path(), "duplicate-extension.ts"),
				source: "project",
				command: { name: "extension:demo", description: "Duplicate command", execute: async () => undefined },
			},
		];
		const skills: Skill[] = [
			{
				name: "demo",
				description: "Demo skill",
				filePath: path.join(tempDir.path(), "SKILL.md"),
				baseDir: tempDir.path(),
				source: "project",
				content: "# Demo",
			},
		];
		const session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager,
			settings: Settings.isolated(STARTUP_OVERRIDES),
			modelRegistry,
			extensionRunner,
			customCommands,
			skills,
		});
		partialHost.session = session;
		HistoryStorage.resetInstance();
		const historyStorage = HistoryStorage.open(path.join(tempDir.path(), "history.db"));
		initializingHost = partialHost;
		const mode = new InteractiveMode(session, "test");
		partialHost.mode = mode;
		const statusRender = vi.spyOn(mode.statusLine, "render").mockReturnValue([]);
		const refreshSlashCommandState = vi.spyOn(mode, "refreshSlashCommandState").mockResolvedValue(undefined);
		try {
			await mode.init();
		} finally {
			if (initializingHost === partialHost) initializingHost = undefined;
		}
		expect(mode.historyStorage).toBe(historyStorage);
		expect(KeybindingsManager.create).toHaveBeenCalledTimes(1);
		expect(mode.keybindings).toBeDefined();
		expect(statusRender).toHaveBeenCalled();
		expect(refreshSlashCommandState).toHaveBeenCalledTimes(1);
		expect(mode.isInitialized).toBe(true);
		expect(mode.keybindings.getKeys("app.commandPalette.open")).toContain("ctrl+p");
		expect(mode.editor.onOpenCommandPalette).toBeDefined();
		expect(mode.editor.onSubmit).toBeDefined();
		const focus = vi.spyOn(mode.ui, "setFocus");
		let inputPromise: Promise<void> | undefined;
		mode.onInputCallback = input => {
			inputPromise = session.prompt(input.text);
		};
		const builtin = vi.spyOn(mode, "handleChangelogCommand").mockResolvedValue(undefined);
		const skill = vi.spyOn(session, "promptCustomMessage").mockResolvedValue(undefined);
		expect(partialHost.titlePushed).toBe(true);
		const host: InteractivePaletteHost = {
			tempDir,
			authStorage,
			session,
			mode,
			focus,
			titlePushed: partialHost.titlePushed === true,
			get inputPromise() {
				return inputPromise;
			},
			resetInputPromise() {
				inputPromise = undefined;
			},
			dispatches: { builtin, extension, custom, skill, extensionError },
		};
		hosts.push(host);
		return host;
	} catch (error) {
		try {
			await disposeHost(partialHost);
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "Failed to create palette host");
		}
		throw error;
	}
}

async function openPalette(host: InteractivePaletteHost): Promise<CommandPaletteComponent> {
	host.mode.editor.handleInput("\u0010");
	let palette: CommandPaletteComponent | undefined;
	await waitFor(() => {
		const component = host.mode.editorContainer.children[0];
		if (!(component instanceof CommandPaletteComponent)) return false;
		palette = component;
		return true;
	}, "the command palette through the initialized editor key handler");
	if (!palette) throw new Error("Expected command palette in the real editor host");
	expect(host.focus).toHaveBeenLastCalledWith(palette);
	return palette;
}

function select(palette: CommandPaletteComponent, query: string): void {
	for (const character of query) palette.handleInput(character);
	palette.handleInput("\r");
}

async function dispatchAndWait(host: InteractivePaletteHost, query: string, dispatchMock: DispatchMock): Promise<void> {
	host.resetInputPromise();
	const palette = await openPalette(host);
	for (const character of query) palette.handleInput(character);
	const entry = palette.getEntries()[0];
	if (!entry?.handler) throw new Error(`Expected a selectable palette entry for ${query}`);
	const handler = entry.handler;
	const dispatchCount = dispatchMock.mock.calls.length;
	let handlerPromise: Promise<void> | undefined;
	entry.handler = () => {
		handlerPromise = Promise.resolve(handler());
		return handlerPromise;
	};
	palette.handleInput("\r");
	await waitFor(
		() => handlerPromise !== undefined && dispatchMock.mock.calls.length === dispatchCount + 1,
		`${query} to dispatch`,
	);
	const capturedHandlerPromise = handlerPromise;
	if (!capturedHandlerPromise) throw new Error(`Expected ${query} handler to start`);
	await capturedHandlerPromise;
	const inputPromise = host.inputPromise;
	if (inputPromise) await inputPromise;
	await waitForPaletteCommandGuardToClear(host);
}

describe("command palette InteractiveMode host", () => {
	it("merges builtin, extension, custom, and skill entries while rejecting duplicate command names", async () => {
		const host = await createHost();
		const palette = await openPalette(host);
		const labels = palette.getEntries().map(entry => entry.label);

		expect(labels).toEqual(expect.arrayContaining(["/changelog", "/extension:demo", "/custom:demo", "/skill:demo"]));
		expect(labels.filter(label => label === "/extension:demo")).toHaveLength(1);
	});
	it("runs every host cleanup step and retains abort and dispose failures", async () => {
		const host = await createHost();
		const abortFailure = new Error("abort failed");
		const disposeFailure = new Error("dispose failed");
		const stop = vi.spyOn(host.mode, "stop");
		const abort = vi.spyOn(host.session, "abort").mockRejectedValue(abortFailure);
		const dispose = vi.spyOn(host.session, "dispose").mockRejectedValue(disposeFailure);
		const close = vi.spyOn(host.authStorage, "close");
		const remove = vi.spyOn(host.tempDir, "removeSync");

		let cleanupError: unknown;
		try {
			await disposeHost(host);
		} catch (error) {
			cleanupError = error;
		}

		expect(cleanupError).toBeInstanceOf(AggregateError);
		if (!(cleanupError instanceof AggregateError)) throw new Error("Expected aggregate cleanup failure");
		expect(cleanupError.errors).toEqual([abortFailure, disposeFailure]);
		expect(stop).toHaveBeenCalledTimes(1);
		expect(abort).toHaveBeenCalledTimes(1);
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(close).toHaveBeenCalledTimes(1);
		expect(remove).toHaveBeenCalledTimes(1);
		expect(titleGenerator.popTerminalTitle).toHaveBeenCalledTimes(1);
		expect(host.titlePushed).toBe(false);
		await disposeHost(host);
		expect(titleGenerator.popTerminalTitle).toHaveBeenCalledTimes(1);
	});

	it("retains setup and cleanup diagnostics when host creation fails after auth setup", async () => {
		const setupFailure = new Error("model registry setup failed");
		const cleanupFailure = new Error("auth cleanup failed");
		vi.spyOn(ModelRegistry.prototype, "find").mockImplementation(() => {
			throw setupFailure;
		});
		vi.spyOn(AuthStorage.prototype, "close").mockImplementation(() => {
			throw cleanupFailure;
		});

		let creationError: unknown;
		try {
			await createHost();
		} catch (error) {
			creationError = error;
		}

		expect(creationError).toBeInstanceOf(AggregateError);
		if (!(creationError instanceof AggregateError)) throw new Error("Expected aggregate setup failure");
		expect(creationError.errors).toContain(setupFailure);
		const cleanupError = creationError.errors.find(error => error instanceof AggregateError);
		expect(cleanupError).toBeInstanceOf(AggregateError);
		if (!(cleanupError instanceof AggregateError)) throw new Error("Expected aggregate cleanup failure");
		expect(cleanupError.errors).toContain(cleanupFailure);
	});
	it("releases an acquired title when initialization rejects after the title push", async () => {
		const initFailure = new Error("hook initialization failed");
		vi.spyOn(InteractiveMode.prototype, "initHooksAndCustomTools").mockRejectedValue(initFailure);

		await expect(createHost()).rejects.toBe(initFailure);

		expect(titleGenerator.pushTerminalTitle).toHaveBeenCalledTimes(1);
		expect(KeybindingsManager.create).toHaveBeenCalledTimes(1);
		expect(titleGenerator.popTerminalTitle).toHaveBeenCalledTimes(1);
		expect(hosts).toEqual([]);
	});

	it("dispatches every command source exactly once through the initialized editor key path", async () => {
		const host = await createHost();

		await dispatchAndWait(host, "/changelog", host.dispatches.builtin);
		await dispatchAndWait(host, "/extension:demo", host.dispatches.extension);
		await dispatchAndWait(host, "/custom:demo", host.dispatches.custom);
		await dispatchAndWait(host, "/skill:demo", host.dispatches.skill);

		expect(host.dispatches.builtin).toHaveBeenCalledTimes(1);
		expect(host.dispatches.extension).toHaveBeenCalledTimes(1);
		expect(host.dispatches.custom).toHaveBeenCalledTimes(1);
		expect(host.dispatches.skill).toHaveBeenCalledTimes(1);
		expect(host.dispatches.extensionError).not.toHaveBeenCalled();
	});

	it("keeps a draft when the palette action is unavailable and does not leak palette components", async () => {
		const host = await createHost();
		host.mode.editor.setText("keep this draft");

		host.mode.editor.handleInput("\u0010");

		expect(host.mode.editorContainer.children).toEqual([host.mode.editor]);
		expect(host.mode.editor.getText()).toBe("keep this draft");

		host.mode.editor.setText("");
		await Promise.resolve();
		for (let index = 0; index < 12; index += 1) {
			const palette = await openPalette(host);
			palette.handleInput("\u001b");
			expect(host.mode.editorContainer.children).toEqual([host.mode.editor]);
		}
	});

	it("blocks the palette while a draft or palette command is active without leaking a modal", async () => {
		const host = await createHost();
		const status = vi.spyOn(host.mode, "showStatus");
		host.mode.editor.setText("unsent draft");

		host.mode.editor.handleInput("\u0010");

		expect(host.dispatches.builtin).toHaveBeenCalledTimes(0);
		expect(host.mode.editor.getText()).toBe("unsent draft");
		expect(host.mode.editorContainer.children).toEqual([host.mode.editor]);
		host.mode.editor.setText("");
		await Promise.resolve();
		const pending = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		host.dispatches.builtin.mockImplementation(() => {
			started.resolve();
			return pending.promise;
		});
		host.resetInputPromise();
		select(await openPalette(host), "/changelog");
		const inputPromise = host.inputPromise;
		await started.promise;
		host.mode.editor.handleInput("\u0010");

		expect(host.dispatches.builtin).toHaveBeenCalledTimes(1);
		expect(host.mode.editorContainer.children).toEqual([host.mode.editor]);
		expect(status).toHaveBeenCalledWith("A palette command is still running.");
		pending.resolve();
		await pending.promise;
		if (inputPromise) await expect(inputPromise).resolves.toBeUndefined();
		await waitForPaletteCommandGuardToClear(host);
		await dispatchAndWait(host, "/changelog", host.dispatches.builtin);
		expect(host.dispatches.builtin).toHaveBeenCalledTimes(2);
		expect(host.mode.editorContainer.children).toEqual([host.mode.editor]);
	});

	it("reports rejected extension commands, clears the modal, and recovers for later dispatch", async () => {
		const host = await createHost();
		const rejected = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		let emittedError: Parameters<ExtensionRunner["emitError"]>[0] | undefined;
		host.dispatches.extension.mockImplementation(() => {
			started.resolve();
			return rejected.promise;
		});
		host.dispatches.extensionError.mockImplementation(error => {
			emittedError = error;
		});

		host.resetInputPromise();
		select(await openPalette(host), "/extension:demo");
		await started.promise;
		expect(host.mode.editorContainer.children).toEqual([host.mode.editor]);

		const inputPromise = host.inputPromise;
		if (!inputPromise) throw new Error("Expected the extension command to submit session input");
		const extensionFailure = new Error("extension failed");
		rejected.reject(extensionFailure);
		await expect(rejected.promise).rejects.toBe(extensionFailure);
		await expect(inputPromise).resolves.toBeUndefined();
		await waitFor(() => emittedError !== undefined, "the rejected extension lifecycle");
		expect(emittedError).toMatchObject({
			extensionPath: "command:extension:demo",
			event: "command",
			error: "extension failed",
		});
		expect(host.dispatches.extensionError).toHaveBeenCalledTimes(1);
		await waitFor(
			() =>
				host.mode.editorContainer.children.length === 1 &&
				host.mode.editorContainer.children[0] === host.mode.editor,
			"the rejected command palette modal to close",
		);
		await waitForPaletteCommandGuardToClear(host);
		host.resetInputPromise();
		host.dispatches.extension.mockImplementation(async () => {});

		await dispatchAndWait(host, "/extension:demo", host.dispatches.extension);
		expect(host.dispatches.extension).toHaveBeenCalledTimes(2);
		expect(host.mode.editorContainer.children).toEqual([host.mode.editor]);
	});
});
