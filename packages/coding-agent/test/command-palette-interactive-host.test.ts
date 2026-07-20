import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import type { LoadedCustomCommand } from "@gajae-code/coding-agent/extensibility/custom-commands";
import {
	ExtensionRunner,
	loadExtensions,
	type RegisteredCommand,
} from "@gajae-code/coding-agent/extensibility/extensions";
import type { Skill } from "@gajae-code/coding-agent/extensibility/skills";
import { CommandPaletteComponent } from "@gajae-code/coding-agent/modes/components/command-palette";
import { InputController } from "@gajae-code/coding-agent/modes/controllers/input-controller";
import { InteractiveMode } from "@gajae-code/coding-agent/modes/interactive-mode";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";
import { ModelRegistry } from "../src/config/model-registry";

interface InteractivePaletteHost {
	tempDir: TempDir;
	authStorage: AuthStorage;
	session: AgentSession;
	mode: InteractiveMode;
	controller: InputController;
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

let hosts: InteractivePaletteHost[] = [];

beforeAll(() => initTheme());

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

async function disposeHost(host: PartialInteractivePaletteHost): Promise<void> {
	const errors: unknown[] = [];
	const cleanUp = async (operation: () => void | Promise<void>): Promise<void> => {
		try {
			await operation();
		} catch (error) {
			errors.push(error);
		}
	};

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
		vi.restoreAllMocks();
		for (const host of hosts) {
			try {
				await disposeHost(host);
			} catch (error) {
				cleanupErrors.push(error);
			}
		}
	} finally {
		hosts = [];
		resetSettingsForTest();
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
			host.controller.openCommandPalette();
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
			settings: Settings.isolated(),
			modelRegistry,
			extensionRunner,
			customCommands,
			skills,
		});
		partialHost.session = session;
		const mode = new InteractiveMode(session, "test");
		partialHost.mode = mode;
		let inputPromise: Promise<void> | undefined;
		mode.onInputCallback = input => {
			inputPromise = session.prompt(input.text);
		};
		const controller = new InputController(mode);
		const builtin = vi.spyOn(mode, "handleChangelogCommand").mockResolvedValue(undefined);
		const skill = vi.spyOn(session, "promptCustomMessage").mockResolvedValue(undefined);
		const host: InteractivePaletteHost = {
			tempDir,
			authStorage,
			session,
			mode,
			controller,
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

function openPalette(host: InteractivePaletteHost): CommandPaletteComponent {
	host.controller.openCommandPalette();
	const component = host.mode.editorContainer.children[0];
	if (!(component instanceof CommandPaletteComponent))
		throw new Error("Expected command palette in the real editor host");
	return component;
}

function select(palette: CommandPaletteComponent, query: string): void {
	for (const character of query) palette.handleInput(character);
	palette.handleInput("\r");
}

async function dispatchAndWait(host: InteractivePaletteHost, query: string, dispatchMock: DispatchMock): Promise<void> {
	host.resetInputPromise();
	const palette = openPalette(host);
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
		const palette = openPalette(host);
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

	it("dispatches every command source exactly once through the real InputController path", async () => {
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

	it("preserves the draft on Escape/back and does not leak palette components", () =>
		createHost().then(host => {
			host.mode.editor.setText("keep this draft");

			for (let index = 0; index < 12; index += 1) {
				const palette = openPalette(host);
				palette.handleInput("\u001b");
				expect(host.mode.editorContainer.children).toEqual([host.mode.editor]);
			}

			expect(host.mode.editor.getText()).toBe("keep this draft");
		}));

	it("rejects draft-owned and overlapping dispatch without leaking a modal", async () => {
		const host = await createHost();
		const status = vi.spyOn(host.mode, "showStatus");
		host.mode.editor.setText("unsent draft");
		select(openPalette(host), "/changelog");
		expect(host.dispatches.builtin).not.toHaveBeenCalled();
		expect(host.mode.editor.getText()).toBe("unsent draft");
		await waitFor(
			() =>
				status.mock.calls.some(
					([message]) => message === "Send or clear the draft before running a palette command.",
				),
			"the draft status",
		);
		expect(status).toHaveBeenCalledWith("Send or clear the draft before running a palette command.");

		host.mode.editor.setText("");
		const pending = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		host.dispatches.builtin.mockImplementation(() => {
			started.resolve();
			return pending.promise;
		});
		host.resetInputPromise();
		select(openPalette(host), "/changelog");
		const inputPromise = host.inputPromise;
		await started.promise;
		host.controller.openCommandPalette();

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
		select(openPalette(host), "/extension:demo");
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
