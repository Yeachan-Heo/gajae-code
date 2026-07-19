import { describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { postmortem, TempDir } from "@gajae-code/utils";
import { type Args, parseArgs } from "../src/cli/args";
import { Settings } from "../src/config/settings";
import { SETTINGS_SCHEMA } from "../src/config/settings-schema";
import {
	classifyStartupUpdateRoute,
	initializeInteractiveModeWithStartupUpdate,
	runRootCommand,
	StartupUpdateOrchestrator,
	type StartupUpdateRoute,
} from "../src/main";
import type { InteractiveMode } from "../src/modes/interactive-mode";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "../src/sdk";
import type { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { EventBus } from "../src/utils/event-bus";

const alternateRoutes: Array<{
	name: StartupUpdateRoute;
	parsed: { print?: boolean; mode?: "text" | "json" | "acp" };
	autoPrint: boolean;
}> = [
	{ name: "print", parsed: { print: true }, autoPrint: false },
	{ name: "text", parsed: { mode: "text" }, autoPrint: false },
	{ name: "text", parsed: { mode: "json" }, autoPrint: false },
	{ name: "acp", parsed: { mode: "acp" }, autoPrint: false },
	{ name: "text", parsed: {}, autoPrint: true },
];

const testModel = getBundledModel("anthropic", "claude-sonnet-4-5");
if (!testModel) throw new Error("Expected bundled test model");

function rootArgs(overrides: Partial<Args> = {}): Args {
	return {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		noSession: true,
		noSkills: true,
		noRules: true,
		noTools: true,
		noLsp: true,
		...overrides,
	};
}

function fakeSessionResult(): CreateAgentSessionResult {
	const session = {
		model: testModel,
		extensionRunner: undefined,
		dispose: async () => {},
	} as unknown as AgentSession;
	return {
		session,
		extensionsResult: {},
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	} as unknown as CreateAgentSessionResult;
}

describe("startup update contract", () => {
	it("keeps the concise startup-check metadata accurate", () => {
		const setting = SETTINGS_SCHEMA["startup.checkUpdate"];

		expect(setting.default).toBe(true);
		expect(setting.ui.description).toContain("At interactive startup, notify");
		expect(setting.ui.description).toContain("never install");
		expect(setting.ui.description).toContain("Use `gjc update` only");
		expect(setting.ui.description).toContain("source, linked, and unrecognized installs use their original method");
	});

	it("classifies every noninteractive launch route and starts no checker for them", () => {
		for (const { name, parsed, autoPrint } of alternateRoutes) {
			let checks = 0;
			let notifications = 0;
			expect(classifyStartupUpdateRoute(parsed, autoPrint)).toBe(name);

			const startupUpdate = new StartupUpdateOrchestrator(
				classifyStartupUpdateRoute(parsed, autoPrint),
				() => true,
				async () => {
					checks++;
					return "999.0.0";
				},
			);
			startupUpdate.startBeforeInteractiveInitialization();
			startupUpdate.attachAfterInteractiveInitialization(() => notifications++);

			expect(checks).toBe(0);
			expect(notifications).toBe(0);
		}
	});

	it("does not check or notify when interactive startup checking is disabled", () => {
		let checks = 0;
		let notifications = 0;
		const startupUpdate = new StartupUpdateOrchestrator(
			"interactive",
			() => false,
			async () => {
				checks++;
				return "999.0.0";
			},
		);

		startupUpdate.startBeforeInteractiveInitialization();
		startupUpdate.attachAfterInteractiveInitialization(() => notifications++);

		expect(checks).toBe(0);
		expect(notifications).toBe(0);
	});

	it("reaches real mode initialization while the interactive check remains pending", async () => {
		expect(classifyStartupUpdateRoute({}, false)).toBe("interactive");
		const versionCheck = Promise.withResolvers<string | undefined>();
		const initReached = Promise.withResolvers<void>();
		const releaseInit = Promise.withResolvers<void>();
		const events: string[] = [];
		const startupUpdate = new StartupUpdateOrchestrator(
			"interactive",
			() => true,
			async () => {
				events.push("check-start");
				return await versionCheck.promise;
			},
		);
		const mode = {
			init: async () => {
				events.push("mode-init");
				initReached.resolve();
				await releaseInit.promise;
			},
			showNewVersionNotification: (version: string) => {
				events.push(`notify:${version}`);
			},
		};

		startupUpdate.startBeforeInteractiveInitialization();
		const initialized = initializeInteractiveModeWithStartupUpdate(mode, startupUpdate);
		await initReached.promise;
		expect(events).toEqual(["check-start", "mode-init"]);

		releaseInit.resolve();
		await initialized;
		expect(events).toEqual(["check-start", "mode-init"]);

		const notified = Promise.withResolvers<void>();
		mode.showNewVersionNotification = version => {
			events.push(`notify:${version}`);
			notified.resolve();
		};
		versionCheck.resolve("999.0.0");
		await notified.promise;
		expect(events).toEqual(["check-start", "mode-init", "notify:999.0.0"]);
	});

	it("does not attach notification delivery until real mode initialization completes", async () => {
		const versionCheck = Promise.withResolvers<string | undefined>();
		const releaseInit = Promise.withResolvers<void>();
		const notified = Promise.withResolvers<void>();
		const events: string[] = [];
		const startupUpdate = new StartupUpdateOrchestrator(
			"interactive",
			() => true,
			() => versionCheck.promise,
		);
		const mode = {
			init: async () => {
				events.push("mode-init");
				await releaseInit.promise;
			},
			showNewVersionNotification: (version: string) => {
				events.push(`notify:${version}`);
				notified.resolve();
			},
		};

		startupUpdate.startBeforeInteractiveInitialization();
		const initialized = initializeInteractiveModeWithStartupUpdate(mode, startupUpdate);
		versionCheck.resolve("999.0.0");
		await Promise.resolve();
		expect(events).toEqual(["mode-init"]);

		releaseInit.resolve();
		await initialized;
		await notified.promise;
		expect(events).toEqual(["mode-init", "notify:999.0.0"]);
	});

	it("consumes rejected checks without blocking real initialization or notifying", async () => {
		const deferred = Promise.withResolvers<string | undefined>();
		let initialized = false;
		let notifications = 0;
		const startupUpdate = new StartupUpdateOrchestrator(
			"interactive",
			() => true,
			async () => await deferred.promise,
		);
		const mode = {
			init: async () => {
				initialized = true;
			},
			showNewVersionNotification: () => {
				notifications += 1;
			},
		};

		startupUpdate.startBeforeInteractiveInitialization();
		await initializeInteractiveModeWithStartupUpdate(mode, startupUpdate);
		expect(initialized).toBe(true);

		deferred.reject(new Error("registry unavailable"));
		await Bun.sleep(0);
		expect(notifications).toBe(0);
	});

	it("routes every noninteractive launch through runRootCommand without starting the checker", async () => {
		const cases: Array<{
			name: string;
			args: Partial<Args>;
			pipedInput?: string;
			expectedRunner: "acp" | "print";
			expectedInitialMessage?: string;
		}> = [
			{ name: "print", args: { print: true }, expectedRunner: "print" },
			{ name: "text", args: { mode: "text" }, expectedRunner: "print" },
			{ name: "json", args: { mode: "json" }, expectedRunner: "print" },
			{ name: "acp", args: { mode: "acp" }, expectedRunner: "acp" },
			{
				name: "auto-print",
				args: {},
				pipedInput: "piped prompt",
				expectedRunner: "print",
				expectedInitialMessage: "piped prompt",
			},
			{
				name: "positional-auto-print",
				args: { messages: ["hello"] },
				pipedInput: "pipe context",
				expectedRunner: "print",
				expectedInitialMessage: "pipe context\nhello",
			},
		];

		for (const testCase of cases) {
			using tempDir = TempDir.createSync("@gjc-startup-route-");
			const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
			const originalNoTitle = Bun.env.PI_NO_TITLE;
			let checks = 0;
			const runners: string[] = [];
			let pipedInputReads = 0;
			let sessionOptions: CreateAgentSessionOptions | undefined;
			let initialMessage: string | undefined;
			try {
				const parsed =
					testCase.expectedRunner === "acp"
						? ({ messages: [], fileArgs: [], unknownFlags: new Map(), ...testCase.args } satisfies Args)
						: rootArgs(testCase.args);
				await runRootCommand(parsed, [], {
					createAgentSession: async options => {
						sessionOptions = options;
						return fakeSessionResult();
					},
					discoverAuthStorage: async () => authStorage,
					settings: Settings.isolated({ "marketplace.autoUpdate": "off", "startup.checkUpdate": true }),
					suppressProcessExit: true,
					startupUpdate: {
						check: async () => {
							checks += 1;
							return "999.0.0";
						},
					},
					initTheme: async () => {},
					readPipedInput: async () => {
						pipedInputReads += 1;
						return testCase.pipedInput;
					},
					runStartupCredentialAutoImportIfNeeded: async () => undefined,
					runAcpMode: async () => {
						runners.push("acp");
					},
					runPrintMode: async (_session, options) => {
						runners.push("print");
						initialMessage = options.initialMessage;
					},
				});
				expect(checks, testCase.name).toBe(0);
				expect(runners, testCase.name).toEqual([testCase.expectedRunner]);
				expect(pipedInputReads, testCase.name).toBe(testCase.expectedRunner === "acp" ? 0 : 1);
				expect(initialMessage, testCase.name).toBe(testCase.expectedInitialMessage);
				if (testCase.expectedRunner === "print") {
					expect(sessionOptions?.sdkHostModeSupported, testCase.name).toBe(false);
				} else {
					expect(sessionOptions, testCase.name).toBeUndefined();
				}
			} finally {
				authStorage.close();
				if (originalNoTitle === undefined) delete Bun.env.PI_NO_TITLE;
				else Bun.env.PI_NO_TITLE = originalNoTitle;
			}
		}
	}, 30_000);

	it("forwards CLI model and thinking to SDK-backed ACP startup controls", async () => {
		using tempDir = TempDir.createSync("@gjc-acp-startup-options-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const originalNoTitle = Bun.env.PI_NO_TITLE;
		let options: { agentDir?: string; startupOptions?: { modelId?: string; thinkingLevel?: string } } | undefined;
		try {
			await runRootCommand(
				{
					messages: [],
					fileArgs: [],
					unknownFlags: new Map(),
					mode: "acp",
					model: `${testModel.provider}/${testModel.id}`,
					thinking: "high" as Args["thinking"],
				},
				[],
				{
					discoverAuthStorage: async () => authStorage,
					settings: Settings.isolated({ "marketplace.autoUpdate": "off", "startup.checkUpdate": true }),
					suppressProcessExit: true,
					initTheme: async () => {},
					readPipedInput: async () => undefined,
					runStartupCredentialAutoImportIfNeeded: async () => undefined,
					runAcpMode: async input => {
						options = input;
					},
				},
			);
			expect(options?.startupOptions).toEqual({
				modelId: `${testModel.provider}/${testModel.id}`,
				thinkingLevel: "high",
			});
		} finally {
			authStorage.close();
			if (originalNoTitle === undefined) delete Bun.env.PI_NO_TITLE;
			else Bun.env.PI_NO_TITLE = originalNoTitle;
		}
	});
	it("forwards CLI --mcp-config as mcpConfigPath to local SDK session startup", async () => {
		using tempDir = TempDir.createSync("@gjc-mcp-config-startup-options-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const configPath = path.join(tempDir.path(), "explicit-mcp.json");
		let sessionOptions: CreateAgentSessionOptions | undefined;
		try {
			await runRootCommand(
				parseArgs([
					"--mode",
					"text",
					"--mcp-config",
					configPath,
					"--no-session",
					"--no-skills",
					"--no-rules",
					"--no-tools",
					"--no-lsp",
				]),
				[],
				{
					createAgentSession: async options => {
						sessionOptions = options;
						return fakeSessionResult();
					},
					discoverAuthStorage: async () => authStorage,
					settings: Settings.isolated({ "marketplace.autoUpdate": "off", "startup.checkUpdate": false }),
					suppressProcessExit: true,
					initTheme: async () => {},
					readPipedInput: async () => undefined,
					runStartupCredentialAutoImportIfNeeded: async () => undefined,
					runPrintMode: async () => {},
				},
			);

			expect(sessionOptions?.mcpConfigPath).toBe(configPath);
			expect(sessionOptions?.mcpManager).toBeUndefined();
		} finally {
			authStorage.close();
		}
	});

	it("preserves print-mode status, cleans up owners, and does not dispose the session twice", async () => {
		using tempDir = TempDir.createSync("@gjc-print-exit-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const originalNoTitle = Bun.env.PI_NO_TITLE;
		const originalExitCode = process.exitCode;
		let disposeCalls = 0;
		const cleanupSpy = vi.spyOn(postmortem, "cleanup").mockResolvedValue(undefined);
		const sessionResult = fakeSessionResult();
		sessionResult.session.dispose = async () => {
			disposeCalls += 1;
		};

		try {
			process.exitCode = 0;
			await runRootCommand(rootArgs({ mode: "text" }), [], {
				createAgentSession: async () => sessionResult,
				discoverAuthStorage: async () => authStorage,
				settings: Settings.isolated({ "marketplace.autoUpdate": "off", "startup.checkUpdate": false }),
				initTheme: async () => {},
				readPipedInput: async () => undefined,
				runStartupCredentialAutoImportIfNeeded: async () => undefined,
				runPrintMode: async session => {
					process.exitCode = 78;
					await session.dispose();
				},
			});

			expect(disposeCalls).toBe(1);
			expect(cleanupSpy).toHaveBeenCalledTimes(1);
			expect(process.exitCode).toBe(78);
		} finally {
			vi.restoreAllMocks();
			process.exitCode = originalExitCode ?? 0;
			authStorage.close();
			if (originalNoTitle === undefined) delete Bun.env.PI_NO_TITLE;
			else Bun.env.PI_NO_TITLE = originalNoTitle;
		}
	});
	it("cleans up noninteractive owners when print mode rejects", async () => {
		using tempDir = TempDir.createSync("@gjc-print-failure-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const originalNoTitle = Bun.env.PI_NO_TITLE;
		const printFailure = new Error("print failed");
		const cleanupSpy = vi.spyOn(postmortem, "cleanup").mockResolvedValue(undefined);
		try {
			await expect(
				runRootCommand(rootArgs({ mode: "text" }), [], {
					createAgentSession: async () => fakeSessionResult(),
					discoverAuthStorage: async () => authStorage,
					settings: Settings.isolated({ "marketplace.autoUpdate": "off", "startup.checkUpdate": false }),
					initTheme: async () => {},
					readPipedInput: async () => undefined,
					runStartupCredentialAutoImportIfNeeded: async () => undefined,
					runPrintMode: async () => {
						throw printFailure;
					},
				}),
			).rejects.toBe(printFailure);
			expect(cleanupSpy).toHaveBeenCalledTimes(1);
		} finally {
			vi.restoreAllMocks();
			authStorage.close();
			if (originalNoTitle === undefined) delete Bun.env.PI_NO_TITLE;
			else Bun.env.PI_NO_TITLE = originalNoTitle;
		}
	});
	it("disposes the interactive session before rethrowing a startup failure", async () => {
		using tempDir = TempDir.createSync("@gjc-interactive-startup-failure-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const startupFailure = new Error("interactive startup failed");
		const sessionResult = fakeSessionResult();
		let disposeCalls = 0;
		sessionResult.session.dispose = async () => {
			await Promise.resolve();
			disposeCalls += 1;
		};

		try {
			await expect(
				runRootCommand(rootArgs(), [], {
					createAgentSession: async () => sessionResult,
					discoverAuthStorage: async () => authStorage,
					settings: Settings.isolated({ "marketplace.autoUpdate": "off", "startup.checkUpdate": false }),
					initTheme: async () => {},
					readPipedInput: async () => undefined,
					stdinIsTTY: true,
					runStartupCredentialAutoImportIfNeeded: async () => undefined,
					getChangelogForDisplay: async () => {
						throw startupFailure;
					},
				}),
			).rejects.toBe(startupFailure);
			expect(disposeCalls).toBe(1);
		} finally {
			authStorage.close();
		}
	});
	it("disposes the session before propagating an RLM post-create error", async () => {
		using tempDir = TempDir.createSync("@gjc-rlm-post-create-failure-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const hookFailure = new Error("RLM post-create failed");
		const sessionResult = fakeSessionResult();
		const events: string[] = [];
		let disposeCalls = 0;
		sessionResult.session.dispose = async () => {
			events.push("dispose");
			disposeCalls += 1;
			throw new Error("cleanup failure");
		};

		try {
			await runRootCommand(rootArgs({ mode: "text" }), [], {
				createAgentSession: async () => sessionResult,
				discoverAuthStorage: async () => authStorage,
				settings: Settings.isolated({ "marketplace.autoUpdate": "off", "startup.checkUpdate": false }),
				initTheme: async () => {},
				readPipedInput: async () => undefined,
				runStartupCredentialAutoImportIfNeeded: async () => undefined,
				rlmPreset: {
					applyOptions: () => {},
					onSessionCreated: async () => {
						events.push("hook");
						throw hookFailure;
					},
				},
			}).then(
				() => {
					throw new Error("Expected RLM post-create hook to reject");
				},
				error => {
					events.push("observed");
					expect(error).toBe(hookFailure);
				},
			);

			expect(events).toEqual(["hook", "dispose", "observed"]);
			expect(disposeCalls).toBe(1);
		} finally {
			authStorage.close();
		}
	});

	it("disposes the interactive session before PI_TIMING=x exits", async () => {
		using tempDir = TempDir.createSync("@gjc-interactive-timing-exit-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const originalTiming = Bun.env.PI_TIMING;
		const timingExit = new Error("timing exit");
		const sessionResult = fakeSessionResult();
		let disposed = false;
		let disposeCalls = 0;
		sessionResult.session.dispose = async () => {
			await Promise.resolve();
			disposed = true;
			disposeCalls += 1;
		};
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((): never => {
			if (!disposed) throw new Error("PI_TIMING=x exited before session disposal");
			throw timingExit;
		});

		try {
			Bun.env.PI_TIMING = "x";
			await expect(
				runRootCommand(rootArgs(), [], {
					createAgentSession: async () => sessionResult,
					discoverAuthStorage: async () => authStorage,
					settings: Settings.isolated({ "marketplace.autoUpdate": "off", "startup.checkUpdate": false }),
					initTheme: async () => {},
					readPipedInput: async () => undefined,
					stdinIsTTY: true,
					runStartupCredentialAutoImportIfNeeded: async () => undefined,
					getChangelogForDisplay: async () => undefined,
				}),
			).rejects.toBe(timingExit);
			expect(exitSpy).toHaveBeenCalledWith(0);
			expect(disposeCalls).toBe(1);
		} finally {
			exitSpy.mockRestore();
			if (originalTiming === undefined) delete Bun.env.PI_TIMING;
			else Bun.env.PI_TIMING = originalTiming;
			authStorage.close();
		}
	});

	it("runs the real root and interactive-mode path without awaiting the version check", async () => {
		using tempDir = TempDir.createSync("@gjc-startup-interactive-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const versionCheck = Promise.withResolvers<string | undefined>();
		const changelogReached = Promise.withResolvers<void>();
		const releaseChangelog = Promise.withResolvers<void>();
		const initReached = Promise.withResolvers<void>();
		const releaseInit = Promise.withResolvers<void>();
		const notified = Promise.withResolvers<void>();
		const stop = new Error("stop interactive harness");
		const events: string[] = [];
		try {
			const root = runRootCommand(rootArgs(), [], {
				createAgentSession: async () => fakeSessionResult(),
				discoverAuthStorage: async () => authStorage,
				settings: Settings.isolated({ "marketplace.autoUpdate": "off", "startup.checkUpdate": true }),
				startupUpdate: {
					check: async () => {
						events.push("check-start");
						return await versionCheck.promise;
					},
				},
				initTheme: async () => {},
				readPipedInput: async () => undefined,
				stdinIsTTY: true,
				runStartupCredentialAutoImportIfNeeded: async () => undefined,
				getChangelogForDisplay: async () => {
					events.push("changelog-start");
					changelogReached.resolve();
					await releaseChangelog.promise;
					return undefined;
				},
				createInteractiveMode: () =>
					({
						init: async () => {
							events.push("mode-init");
							initReached.resolve();
							await releaseInit.promise;
						},
						showNewVersionNotification: (version: string) => {
							events.push(`notify:${version}`);
							notified.resolve();
						},
						renderInitialMessages: () => {},
						getUserInput: async () => {
							events.push("user-input");
							throw stop;
						},
					}) as unknown as InteractiveMode,
			});

			await changelogReached.promise;
			expect(events).toEqual(["check-start", "changelog-start"]);
			releaseChangelog.resolve();
			await initReached.promise;
			versionCheck.resolve("999.0.0");
			await Bun.sleep(0);
			expect(events).toEqual(["check-start", "changelog-start", "mode-init"]);

			releaseInit.resolve();
			await expect(root).rejects.toBe(stop);
			await notified.promise;
			expect(events).toEqual(["check-start", "changelog-start", "mode-init", "notify:999.0.0", "user-input"]);
		} finally {
			authStorage.close();
		}
	}, 15_000);

	it("keeps real interactive startup disabled and rejected checks non-blocking", async () => {
		for (const testCase of [
			{ enabled: false, check: async () => "999.0.0" },
			{ enabled: true, check: async () => await Promise.reject(new Error("registry unavailable")) },
		]) {
			using tempDir = TempDir.createSync("@gjc-startup-disabled-");
			const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
			const stop = new Error("stop interactive harness");
			let checks = 0;
			let notifications = 0;
			try {
				await expect(
					runRootCommand(rootArgs(), [], {
						createAgentSession: async () => fakeSessionResult(),
						discoverAuthStorage: async () => authStorage,
						settings: Settings.isolated({
							"marketplace.autoUpdate": "off",
							"startup.checkUpdate": testCase.enabled,
						}),
						startupUpdate: {
							check: async () => {
								checks += 1;
								return await testCase.check();
							},
						},
						initTheme: async () => {},
						readPipedInput: async () => undefined,
						stdinIsTTY: true,
						runStartupCredentialAutoImportIfNeeded: async () => undefined,
						getChangelogForDisplay: async () => undefined,
						createInteractiveMode: () =>
							({
								init: async () => {},
								showNewVersionNotification: () => {
									notifications += 1;
								},
								renderInitialMessages: () => {},
								getUserInput: async () => {
									throw stop;
								},
							}) as unknown as InteractiveMode,
					}),
				).rejects.toBe(stop);
				await Bun.sleep(0);
				expect(checks).toBe(testCase.enabled ? 1 : 0);
				expect(notifications).toBe(0);
			} finally {
				authStorage.close();
			}
		}
	}, 15_000);
	it("reaches login recovery before a credentialless default profile can abort startup", async () => {
		using tempDir = TempDir.createSync("@gjc-auth-bootstrap-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const stop = new Error("stop auth bootstrap harness");
		const parsed = parseArgs(["login", "openai-codex"]);
		const settings = Settings.isolated({
			"marketplace.autoUpdate": "off",
			"startup.checkUpdate": false,
			"modelProfile.default": "codex-medium",
		});
		let initialized = false;

		try {
			await expect(
				runRootCommand(parsed, [], {
					createAgentSession: async () => fakeSessionResult(),
					discoverAuthStorage: async () => authStorage,
					settings,
					initTheme: async () => {},
					readPipedInput: async () => undefined,
					stdinIsTTY: true,
					runStartupCredentialAutoImportIfNeeded: async () => undefined,
					getChangelogForDisplay: async () => undefined,
					createInteractiveMode: () =>
						({
							init: async () => {
								initialized = true;
							},
							showNewVersionNotification: () => {},
							renderInitialMessages: () => {},
							editor: { setText: () => {} },
							showOAuthSelector: async (mode: string, provider?: string) => {
								expect(mode).toBe("login");
								expect(provider).toBe("openai-codex");
							},
							handleBackgroundCommand: () => {},
							showError: () => {},
							getUserInput: async () => {
								throw stop;
							},
						}) as unknown as InteractiveMode,
				}),
			).rejects.toBe(stop);
			expect(initialized).toBe(true);
			expect(parsed.messages).toEqual(["/login openai-codex"]);
			expect(parsed.authBootstrap).toBe(true);
			expect(settings.get("modelProfile.default")).toBe("codex-medium");
		} finally {
			authStorage.close();
		}
	});
	it("keeps credential validation active for noninteractive login-shaped input", async () => {
		using tempDir = TempDir.createSync("@gjc-auth-bootstrap-text-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const settings = Settings.isolated({
			"marketplace.autoUpdate": "off",
			"startup.checkUpdate": false,
			"modelProfile.default": "codex-medium",
		});
		const parsed = parseArgs(["--mode", "text", "login", "openai-codex"]);
		let printModeStarted = false;
		const exit = new Error("exit 1");
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((): never => {
			throw exit;
		});
		const stderr: string[] = [];
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
			stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			return true;
		});

		try {
			await expect(
				runRootCommand(parsed, [], {
					createAgentSession: async () => fakeSessionResult(),
					discoverAuthStorage: async () => authStorage,
					settings,
					initTheme: async () => {},
					readPipedInput: async () => undefined,
					runStartupCredentialAutoImportIfNeeded: async () => undefined,
					runPrintMode: async () => {
						printModeStarted = true;
					},
				}),
			).rejects.toBe(exit);
			expect(exitSpy).toHaveBeenCalledWith(1);
			expect(printModeStarted).toBe(false);
			expect(settings.get("modelProfile.default")).toBe("codex-medium");
			expect(stderr.join("")).toContain('Model profile "codex-medium" requires credentials for: openai-codex');
		} finally {
			stderrSpy.mockRestore();
			exitSpy.mockRestore();
			authStorage.close();
		}
	});
	it("keeps updater and default-installer APIs outside startup wiring", async () => {
		const source = await Bun.file(new URL("../src/main.ts", import.meta.url)).text();

		expect(source).not.toMatch(/["']\.\/cli\/update-cli["']/);
		expect(source).not.toMatch(/["']\.\/defaults\/gjc-defaults["']/);
		expect(source).toContain("startupUpdate.startBeforeInteractiveInitialization()");
		expect(source).toContain("startupUpdate.attachAfterInteractiveInitialization");
	});
});
