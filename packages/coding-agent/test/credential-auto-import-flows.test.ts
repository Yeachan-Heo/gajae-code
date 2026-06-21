import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { AuthCredentialIfAbsentSnapshotResult } from "@gajae-code/ai";
import { Container } from "@gajae-code/tui";
import { VERSION } from "@gajae-code/utils";
import { handleCredentialsSetup } from "../src/cli/setup-cli";
import { SelectorController } from "../src/modes/controllers/selector-controller";
import { getThemeByName, setThemeInstance } from "../src/modes/theme/theme";
import {
	CREDENTIAL_AUTO_IMPORT_ROTATION_WARNING,
	runStartupCredentialAutoImportIfNeeded,
} from "../src/setup/credential-auto-import";
import type { CredentialDiscoveryResult, DiscoveryOptions, ImportableCredential } from "../src/setup/credential-import";
import * as credentialImport from "../src/setup/credential-import";
import { executeBuiltinSlashCommand } from "../src/slash-commands/builtin-registry";

const testTheme = await getThemeByName("red-claw");

function installTestTheme(): void {
	if (!testTheme) throw new Error("Failed to load test theme");
	setThemeInstance(testTheme);
}

function oauthCredential(overrides: Partial<ImportableCredential> = {}): ImportableCredential {
	return {
		provider: "anthropic",
		origin: "claude-code-file",
		source: "Claude Code (test)",
		kind: "oauth",
		redactedToken: "sk-a…oken",
		credential: { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 60_000 },
		...overrides,
	} as ImportableCredential;
}

function apiKeyCredential(): ImportableCredential {
	return {
		provider: "openai-codex",
		origin: "codex-file",
		source: "Codex CLI (test)",
		kind: "api_key",
		redactedToken: "sk-c…oken",
		credential: { type: "api_key", key: "sk-codex" },
	};
}

function discovery(
	importable: ImportableCredential[] = [],
	skipped: CredentialDiscoveryResult["skipped"] = [],
): CredentialDiscoveryResult {
	return { importable, skipped, environment: [] };
}

function inserted(provider = "anthropic"): AuthCredentialIfAbsentSnapshotResult {
	return { inserted: true, reason: "inserted", provider, entries: [] };
}

function skipped(provider = "anthropic"): AuthCredentialIfAbsentSnapshotResult {
	return { inserted: false, reason: "skipped-existing", provider, entries: [] };
}

describe("credential auto-import trigger guards", () => {
	afterEach(() => {
		spyOn(credentialImport, "discoverExternalCredentials").mockRestore?.();
	});

	function runtime() {
		const calls: Array<{ mode: string; providerId?: string; options?: unknown }> = [];
		return {
			calls,
			runtime: {
				ctx: {
					oauthManualInput: {
						hasPending: () => false,
						pendingProviderId: undefined,
						submit: () => false,
					},
					showOAuthSelector: (mode: string, providerId?: string, options?: unknown) => {
						calls.push({ mode, providerId, options });
					},
					showWarning: () => {},
					showStatus: () => {},
					editor: { setText: () => {} },
				},
			},
		};
	}

	test("bare /login is the only slash path that enables external discovery", async () => {
		const bare = runtime();
		await executeBuiltinSlashCommand("/login", bare.runtime as never);
		expect(bare.calls).toHaveLength(1);
		expect(bare.calls[0]?.options).toEqual({ allowExternalCredentialDiscovery: true, trigger: "bare-login" });

		const providerSpecific = runtime();
		await executeBuiltinSlashCommand("/login anthropic", providerSpecific.runtime as never);
		expect(providerSpecific.calls).toEqual([{ mode: "login", providerId: "anthropic", options: undefined }]);

		const callback = runtime();
		await executeBuiltinSlashCommand("/login https://localhost/callback?code=abc", callback.runtime as never);
		expect(callback.calls).toHaveLength(0);

		const logout = runtime();
		await executeBuiltinSlashCommand("/logout anthropic", logout.runtime as never);
		expect(logout.calls).toEqual([{ mode: "logout", providerId: "anthropic", options: undefined }]);
	});

	test("excluded trigger paths perform zero discovery and zero Claude keychain reads", async () => {
		const discoverSpy = spyOn(credentialImport, "discoverExternalCredentials").mockResolvedValue(discovery());
		let keychainReads = 0;
		const readClaudeKeychain = async () => {
			keychainReads += 1;
			return null;
		};

		const providerSpecific = runtime();
		await executeBuiltinSlashCommand("/login anthropic", providerSpecific.runtime as never);
		const callback = runtime();
		await executeBuiltinSlashCommand("/login http://127.0.0.1:1455/callback?code=abc", callback.runtime as never);
		const logout = runtime();
		await executeBuiltinSlashCommand("/logout anthropic", logout.runtime as never);

		// Simulates provider-onboarding oauth-login: direct selector open without discovery option.
		const onboarding = runtime();
		onboarding.runtime.ctx.showOAuthSelector("login");

		expect(discoverSpy).toHaveBeenCalledTimes(0);
		expect(keychainReads).toBe(0);
		await readClaudeKeychain();
		expect(keychainReads).toBe(1);
	});
});

describe("startup credential auto-import marker matrix", () => {
	function makeMarkerStore(lastVersion?: string) {
		let marker = lastVersion;
		let writes = 0;
		return {
			markerStore: {
				read: () => marker,
				write: (value: string) => {
					marker = value;
					writes += 1;
					return true;
				},
			},
			get marker() {
				return marker;
			},
			get writes() {
				return writes;
			},
		};
	}

	function authStorage(outcomes: Array<AuthCredentialIfAbsentSnapshotResult | Error>) {
		const calls: string[] = [];
		return {
			calls,
			authStorage: {
				importCredentialIfAbsent: async (provider: string) => {
					calls.push(provider);
					const outcome = outcomes.shift() ?? skipped(provider);
					if (outcome instanceof Error) throw outcome;
					return outcome;
				},
			},
		};
	}

	async function runCase(args: {
		lastVersion?: string;
		discover: (options?: DiscoveryOptions) => Promise<CredentialDiscoveryResult>;
		outcomes?: Array<AuthCredentialIfAbsentSnapshotResult | Error>;
	}) {
		const marker = makeMarkerStore(args.lastVersion);
		const a = authStorage(args.outcomes ?? []);
		const refreshCalls: string[] = [];
		const notice = await runStartupCredentialAutoImportIfNeeded({
			authStorage: a.authStorage as never,
			modelRegistry: { refresh: async (mode?: string) => refreshCalls.push(mode ?? "") } as never,
			discover: args.discover,
			markerStore: marker.markerStore,
		});
		return { marker, auth: a, refreshCalls, notice };
	}

	test("marker at VERSION skips discovery and reads", async () => {
		let discoveryReads = 0;
		let keychainReads = 0;
		const result = await runCase({
			lastVersion: VERSION,
			discover: async options => {
				discoveryReads += 1;
				await options?.readClaudeKeychain?.();
				keychainReads += 1;
				return discovery();
			},
		});
		expect(discoveryReads).toBe(0);
		expect(keychainReads).toBe(0);
		expect(result.marker.marker).toBe(VERSION);
		expect(result.marker.writes).toBe(0);
	});

	test("global discovery failure does not advance marker", async () => {
		const result = await runCase({
			discover: async () => {
				throw new Error("boom");
			},
		});
		expect(result.marker.marker).toBeUndefined();
		expect(result.marker.writes).toBe(0);
		expect(result.refreshCalls).toHaveLength(0);
		expect(result.notice).toBeUndefined();
	});

	test("no candidates advances marker without refresh or notice", async () => {
		const result = await runCase({ discover: async () => discovery([]) });
		expect(result.marker.marker).toBe(VERSION);
		expect(result.marker.writes).toBe(1);
		expect(result.refreshCalls).toHaveLength(0);
		expect(result.notice).toBeUndefined();
	});

	test("all skipped advances marker without refresh or notice", async () => {
		const result = await runCase({ discover: async () => discovery([oauthCredential()]), outcomes: [skipped()] });
		expect(result.marker.marker).toBe(VERSION);
		expect(result.refreshCalls).toHaveLength(0);
		expect(result.notice).toBeUndefined();
	});

	test("all failed does not advance marker or refresh", async () => {
		const result = await runCase({
			discover: async () => discovery([oauthCredential()]),
			outcomes: [new Error("write conflict")],
		});
		expect(result.marker.marker).toBeUndefined();
		expect(result.marker.writes).toBe(0);
		expect(result.refreshCalls).toHaveLength(0);
		expect(result.notice).toBeUndefined();
	});

	test("partial import advances marker, refreshes registry, and emits exact rotation warning", async () => {
		const result = await runCase({
			discover: async () =>
				discovery([oauthCredential(), oauthCredential({ provider: "openai-codex", origin: "codex-file" })]),
			outcomes: [inserted("anthropic"), skipped("openai-codex")],
		});
		expect(result.marker.marker).toBe(VERSION);
		expect(result.refreshCalls).toEqual(["offline"]);
		expect(result.notice).toContain(CREDENTIAL_AUTO_IMPORT_ROTATION_WARNING);
		expect(CREDENTIAL_AUTO_IMPORT_ROTATION_WARNING).toBe(
			"Refreshing in gjc may log out the Claude/Codex CLI because OAuth refresh tokens can rotate.",
		);
	});
});

describe("setup credentials keychain and preview behavior", () => {
	let stdout = "";
	let exitCode: string | number | undefined | null;

	beforeEach(() => {
		stdout = "";
		exitCode = process.exitCode;
		spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
			stdout += String(chunk);
			return true;
		});
		spyOn(process.stderr, "write").mockImplementation((_chunk: string | Uint8Array) => {
			return true;
		});
	});

	afterEach(() => {
		spyOn(process.stdout, "write").mockRestore?.();
		spyOn(process.stderr, "write").mockRestore?.();
		process.exitCode = exitCode;
	});

	function deps(reads: { discover: number; keychain: number }, result: CredentialDiscoveryResult) {
		return {
			openStore: async () => ({ close: () => {} }) as never,
			createAuthStorage: () =>
				({
					reload: async () => {},
					importCredentialIfAbsent: async (provider: string) => inserted(provider),
				}) as never,
			discover: async (options?: DiscoveryOptions) => {
				reads.discover += 1;
				if (options?.readClaudeKeychain) {
					await options.readClaudeKeychain();
				} else {
					reads.keychain += 1;
				}
				return result;
			},
		};
	}

	test.each([
		["default", {}],
		["dry-run", { dryRun: true }],
		["json", { json: true }],
		["yes", { yes: true }],
	])("setup credentials %s does not invoke keychain reader", async (_label, flags) => {
		const reads = { discover: 0, keychain: 0 };
		await handleCredentialsSetup({ ...flags, dryRun: true, yes: true }, deps(reads, discovery([oauthCredential()])));
		expect(reads.discover).toBe(1);
		expect(reads.keychain).toBe(0);
	});

	test("setup credentials --keychain allows keychain discovery", async () => {
		const reads = { discover: 0, keychain: 0 };
		await handleCredentialsSetup(
			{ keychain: true, dryRun: true, yes: true },
			deps(reads, discovery([oauthCredential({ origin: "claude-code-keychain" })])),
		);
		expect(reads.discover).toBe(1);
		expect(reads.keychain).toBe(1);
	});

	test("setup preview filters API keys out of importable counts and JSON", async () => {
		const reads = { discover: 0, keychain: 0 };
		await handleCredentialsSetup({ json: true, dryRun: true }, deps(reads, discovery([apiKeyCredential()])));
		const payload = JSON.parse(stdout.trim());
		expect(payload.importable).toEqual([]);
		expect(JSON.stringify(payload)).not.toContain("api_key");
	});

	test("denied keychain read records sanitized skip and continues", async () => {
		const reads = { discover: 0, keychain: 0 };
		await handleCredentialsSetup(
			{ keychain: true, json: true, dryRun: true },
			deps(
				reads,
				discovery(
					[],
					[
						{
							origin: "claude-code-keychain",
							source: "Claude Code (macOS Keychain)",
							reason: "unreadable credential file (Error: denied)",
						},
					],
				),
			),
		);
		const payload = JSON.parse(stdout.trim());
		expect(payload.skipped).toHaveLength(1);
		expect(payload.skipped[0].reason).toContain("denied");
		expect(payload.imported).toEqual([]);
	});
});

describe("bare /login external credential import gate", () => {
	function createControllerHarness(args: { confirm: boolean; importOutcome?: AuthCredentialIfAbsentSnapshotResult }) {
		installTestTheme();
		const importCalls: string[] = [];
		const refreshCalls: string[] = [];
		const confirmMessages: Array<{ title: string; message: string }> = [];
		const ctx = {
			ui: { setFocus: mock(() => {}), requestRender: mock(() => {}) },
			editorContainer: new Container(),
			editor: new Container(),
			chatContainer: new Container(),
			showHookConfirm: mock(async (title: string, message: string) => {
				confirmMessages.push({ title, message });
				return args.confirm;
			}),
			session: {
				sessionId: "session-1",
				modelRegistry: {
					refresh: mock(async (mode?: string) => refreshCalls.push(mode ?? "")),
					authStorage: {
						hasAuth: () => false,
						importCredentialIfAbsent: async (provider: string) => {
							importCalls.push(provider);
							return args.importOutcome ?? inserted(provider);
						},
					},
					getApiKeyForProvider: mock(async () => undefined),
				},
			},
		} as never;
		return { controller: new SelectorController(ctx), importCalls, refreshCalls, confirmMessages };
	}

	function bareLoginOptions() {
		return {
			allowExternalCredentialDiscovery: true,
			trigger: "bare-login" as const,
			externalCredentialDiscover: async () => discovery([oauthCredential()]),
		};
	}

	test("bare /login shows rotation warning before persisting imported OAuth credentials", async () => {
		const harness = createControllerHarness({ confirm: true });

		await harness.controller.showOAuthSelector("login", undefined, bareLoginOptions());

		expect(harness.confirmMessages).toHaveLength(1);
		expect(harness.confirmMessages[0]?.message).toContain("Claude Code (test)");
		expect(harness.confirmMessages[0]?.message).toContain(CREDENTIAL_AUTO_IMPORT_ROTATION_WARNING);
		expect(harness.importCalls).toEqual(["anthropic"]);
		expect(harness.refreshCalls).toEqual(["offline"]);
	});

	test("declining bare /login import does not persist discovered credentials", async () => {
		const harness = createControllerHarness({ confirm: false });

		await harness.controller.showOAuthSelector("login", undefined, bareLoginOptions());

		expect(harness.confirmMessages).toHaveLength(1);
		expect(harness.importCalls).toEqual([]);
		expect(harness.refreshCalls).toEqual([]);
	});

	test("confirmed bare /login import remains idempotent when credential already exists", async () => {
		const harness = createControllerHarness({ confirm: true, importOutcome: skipped() });

		await harness.controller.showOAuthSelector("login", undefined, bareLoginOptions());

		expect(harness.confirmMessages).toHaveLength(1);
		expect(harness.importCalls).toEqual(["anthropic"]);
		expect(harness.refreshCalls).toEqual([]);
	});
});
