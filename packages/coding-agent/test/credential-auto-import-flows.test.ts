import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AuthCredentialIfAbsentSnapshotResult } from "@gajae-code/ai";
import { Container } from "@gajae-code/tui";
import { logger, VERSION } from "@gajae-code/utils";

import { handleCredentialsSetup } from "../src/cli/setup-cli";
import { ProviderOnboardingSelectorComponent } from "../src/modes/components/provider-onboarding-selector";
import { SelectorController } from "../src/modes/controllers/selector-controller";
import { getThemeByName, setThemeInstance } from "../src/modes/theme/theme";
import {
	CREDENTIAL_AUTO_IMPORT_PERSISTENCE_WARNING,
	CREDENTIAL_AUTO_IMPORT_REFRESH_WARNING,
	CREDENTIAL_AUTO_IMPORT_RETRY_WARNING,
	CREDENTIAL_AUTO_IMPORT_ROTATION_WARNING,
	type CredentialAutoImportStateFile,
	type CredentialAutoImportStateMutation,
	type CredentialAutoImportStateStore,
	type CredentialAutoImportStateStoreDependencies,
	createCredentialAutoImportStateStore,
	getCredentialAutoImportStatePath,
	readCredentialAutoImportState,
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
	function makeStateStore(lastVersion?: string) {
		const state: CredentialAutoImportStateFile = lastVersion ? { lastImportVersion: lastVersion } : {};
		let writes = 0;
		const stateStore: CredentialAutoImportStateStore = {
			read: async () => ({ state: { ...state }, problems: [], unreadable: false }),
			write: async mutation => {
				if (mutation.lastImportVersion !== undefined) state.lastImportVersion = mutation.lastImportVersion;
				if (state.initialImportResolution === undefined && mutation.initialImportResolution !== undefined) {
					state.initialImportResolution = mutation.initialImportResolution;
				}
				writes += 1;
				return true;
			},
		};
		return {
			stateStore,
			get marker() {
				return state.lastImportVersion;
			},
			get resolution() {
				return state.initialImportResolution;
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
		const marker = makeStateStore(args.lastVersion);
		const a = authStorage(args.outcomes ?? []);
		const refreshCalls: string[] = [];
		const notice = await runStartupCredentialAutoImportIfNeeded({
			authStorage: a.authStorage as never,
			modelRegistry: { refresh: async (mode?: string) => refreshCalls.push(mode ?? "") } as never,
			discover: args.discover,
			stateStore: marker.stateStore,
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

	test("global discovery failure logs only bounded failure evidence and does not advance marker", async () => {
		const errorSentinel = "STARTUP_GLOBAL_DISCOVERY_ERROR_SENTINEL";
		const warning = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const result = await runCase({
				discover: async () => {
					throw new Error(`global discovery failed ${errorSentinel}`);
				},
			});
			expect(result.marker.marker).toBeUndefined();
			expect(result.marker.writes).toBe(0);
			expect(result.refreshCalls).toHaveLength(0);
			expect(result.notice).toBeUndefined();
			expect(warning).toHaveBeenCalledWith("Credential auto-import completed with failures", {
				trigger: "startup",
				failureCounts: { "discovery-unavailable": 1 },
			});
			expect(JSON.stringify(warning.mock.calls)).not.toContain(errorSentinel);
		} finally {
			warning.mockRestore();
		}
	});

	test("no candidates advances marker without refresh or notice", async () => {
		const result = await runCase({ discover: async () => discovery([]) });
		expect(result.marker.marker).toBe(VERSION);
		expect(result.marker.writes).toBe(1);
		expect(result.refreshCalls).toHaveLength(0);
		expect(result.notice).toBeUndefined();
		expect(result.marker.resolution).toBeUndefined();
	});

	test("all skipped advances marker without refresh or notice", async () => {
		const result = await runCase({ discover: async () => discovery([oauthCredential()]), outcomes: [skipped()] });
		expect(result.marker.marker).toBe(VERSION);
		expect(result.refreshCalls).toHaveLength(0);
		expect(result.notice).toBeUndefined();
		expect(result.marker.resolution).toBe("accepted");
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
		expect(result.marker.resolution).toBeUndefined();
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
		expect(result.marker.resolution).toBe("accepted");
	});

	test("startup keeps an accepted transition and logs bounded mixed failure evidence", async () => {
		const marker = makeStateStore();
		const sourceSentinel = "STARTUP_SOURCE_SENTINEL";
		const reasonSentinel = "STARTUP_REASON_SENTINEL";
		const environmentSentinel = "STARTUP_ENVIRONMENT_SENTINEL";
		const errorSentinel = "STARTUP_ERROR_SENTINEL";
		const warning = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const notice = await runStartupCredentialAutoImportIfNeeded({
				authStorage: authStorage([
					inserted("anthropic"),
					skipped("openai-codex"),
					new Error(`write conflict ${errorSentinel}`),
				]).authStorage as never,
				modelRegistry: { refresh: async () => {} } as never,
				discover: async () => ({
					importable: [
						oauthCredential({ source: sourceSentinel }),
						oauthCredential({ provider: "openai-codex", origin: "codex-file", source: sourceSentinel }),
						oauthCredential({ source: sourceSentinel }),
					],
					skipped: [
						{
							origin: "claude-code-file",
							source: sourceSentinel,
							reason: `unreadable ${reasonSentinel}`,
						},
					],
					environment: [
						{ provider: "anthropic", variable: environmentSentinel, redactedValue: environmentSentinel },
					],
				}),
				stateStore: marker.stateStore,
			});
			expect(marker.marker).toBe(VERSION);
			expect(marker.resolution).toBe("accepted");
			expect(notice).toContain(CREDENTIAL_AUTO_IMPORT_ROTATION_WARNING);
			expect(warning).toHaveBeenCalledWith("Credential auto-import completed with failures", {
				trigger: "startup",
				failureCounts: { "source-unreadable": 1, "write-conflict": 1 },
			});
			const emitted = JSON.stringify(warning.mock.calls);
			for (const sentinel of [sourceSentinel, reasonSentinel, environmentSentinel, errorSentinel]) {
				expect(emitted).not.toContain(sentinel);
			}
		} finally {
			warning.mockRestore();
		}
	});

	test("source-failed zero candidates remain unresolved for a later startup retry", async () => {
		const marker = makeStateStore();
		const result = await runStartupCredentialAutoImportIfNeeded({
			authStorage: authStorage([]).authStorage as never,
			modelRegistry: { refresh: async () => {} } as never,
			discover: async () =>
				discovery(
					[],
					[
						{
							origin: "claude-code-file",
							source: "external credential source",
							reason: "unreadable credential file",
						},
					],
				),
			stateStore: marker.stateStore,
		});
		expect(result).toBeUndefined();
		expect(marker.writes).toBe(0);
		expect(marker.resolution).toBeUndefined();
	});

	test("startup keeps its accepted decision when the provider refresh fails", async () => {
		const marker = makeStateStore();
		const notice = await runStartupCredentialAutoImportIfNeeded({
			authStorage: authStorage([inserted()]).authStorage as never,
			modelRegistry: {
				refresh: async () => {
					throw new Error("refresh failed");
				},
			} as never,
			discover: async () => discovery([oauthCredential()]),
			stateStore: marker.stateStore,
		});
		expect(marker.resolution).toBe("accepted");
		expect(notice).toContain(CREDENTIAL_AUTO_IMPORT_REFRESH_WARNING);
	});
});

describe("credential auto-import state classification and compatibility", () => {
	const temporaryAgentDirs: string[] = [];

	afterEach(async () => {
		await Promise.all(
			temporaryAgentDirs.splice(0).map(agentDir => fs.rm(agentDir, { recursive: true, force: true })),
		);
	});

	async function createTemporaryAgentDir(): Promise<string> {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-credential-auto-import-"));
		temporaryAgentDirs.push(agentDir);
		return agentDir;
	}

	function createWriteTransactionBarrier(): {
		dependencies: CredentialAutoImportStateStoreDependencies;
		firstEntered: Promise<void>;
		secondEntered: Promise<void>;
		releaseNext: () => Promise<void>;
	} {
		const firstEntered = Promise.withResolvers<void>();
		const secondEntered = Promise.withResolvers<void>();
		const queued: Array<() => Promise<void>> = [];
		let entries = 0;
		const dependencies: CredentialAutoImportStateStoreDependencies = {
			withFileLock: async <T>(_statePath: string, transaction: () => Promise<T>): Promise<T> => {
				const result = Promise.withResolvers<T>();
				queued.push(async () => {
					try {
						result.resolve(await transaction());
					} catch (error) {
						result.reject(error);
					}
				});
				entries += 1;
				if (entries === 1) firstEntered.resolve();
				if (entries === 2) secondEntered.resolve();
				return result.promise;
			},
		};
		return {
			dependencies,
			firstEntered: firstEntered.promise,
			secondEntered: secondEntered.promise,
			releaseNext: async () => {
				const transaction = queued.shift();
				if (!transaction) throw new Error("No queued state transaction");
				await transaction();
			},
		};
	}

	async function writeStateTransactionsInOrder(
		agentDir: string,
		firstMutation: CredentialAutoImportStateMutation,
		secondMutation: CredentialAutoImportStateMutation,
	): Promise<[boolean, boolean]> {
		const barrier = createWriteTransactionBarrier();
		const firstStore = createCredentialAutoImportStateStore(agentDir, barrier.dependencies);
		const secondStore = createCredentialAutoImportStateStore(agentDir, barrier.dependencies);
		const firstWrite = firstStore.write(firstMutation);
		await barrier.firstEntered;
		const secondWrite = secondStore.write(secondMutation);
		await barrier.secondEntered;
		await barrier.releaseNext();
		await barrier.releaseNext();
		const [firstResult, secondResult] = await Promise.all([firstWrite, secondWrite]);
		return [firstResult, secondResult];
	}

	test("classifies malformed JSON and non-object state without projecting a resolution", async () => {
		const agentDir = await createTemporaryAgentDir();
		const statePath = getCredentialAutoImportStatePath(agentDir);
		for (const [serialized, problem] of [
			["{", "malformed-json"],
			["null", "malformed-root"],
			["[]", "malformed-root"],
		] as const) {
			await fs.writeFile(statePath, serialized);
			expect(await readCredentialAutoImportState(agentDir)).toEqual({
				state: {},
				problems: [problem],
				unreadable: false,
			});
		}
	});

	test("refuses invalid state mutations without creating a state file", async () => {
		const agentDir = await createTemporaryAgentDir();
		const store = createCredentialAutoImportStateStore(agentDir);
		expect(await store.write({ lastImportVersion: "not a version" })).toBe(false);
		expect(await store.write({ initialImportResolution: "later" as never })).toBe(false);
		expect(await fs.readdir(agentDir)).toEqual([]);
	});

	test("keeps startup discovery behind an injected unreadable state gate", async () => {
		let reads = 0;
		let writes = 0;
		let discoveryReads = 0;
		const stateStore: CredentialAutoImportStateStore = {
			read: async () => {
				reads += 1;
				return { state: {}, problems: [], unreadable: true };
			},
			write: async () => {
				writes += 1;
				return true;
			},
		};
		await runStartupCredentialAutoImportIfNeeded({
			authStorage: { importCredentialIfAbsent: mock(async () => inserted()) },
			modelRegistry: { refresh: async () => {} } as never,
			discover: async () => {
				discoveryReads += 1;
				return discovery([oauthCredential()]);
			},
			stateStore,
		});
		expect(reads).toBe(1);
		expect(writes).toBe(0);
		expect(discoveryReads).toBe(0);
	});

	test("writes state through a mode-restricted temporary file and removes it after atomic replacement", async () => {
		const rootDir = await createTemporaryAgentDir();
		const agentDir = path.join(rootDir, "state");
		const statePath = getCredentialAutoImportStatePath(agentDir);
		expect(await createCredentialAutoImportStateStore(agentDir).write({ initialImportResolution: "accepted" })).toBe(
			true,
		);
		expect((await fs.stat(agentDir)).mode & 0o777).toBe(0o700);
		expect((await fs.stat(statePath)).mode & 0o777).toBe(0o600);
		expect((await fs.readdir(agentDir)).filter(entry => entry.includes(".tmp."))).toEqual([]);
	});

	test("keeps durable state and removes the temporary file when atomic replacement fails", async () => {
		const agentDir = await createTemporaryAgentDir();
		const statePath = getCredentialAutoImportStatePath(agentDir);
		const durableBytes = '{"initialImportResolution":"declined"}\n';
		const errorSentinel = "ATOMIC_WRITE_FAILURE_SENTINEL";
		await fs.writeFile(statePath, durableBytes);
		const warning = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const store = createCredentialAutoImportStateStore(agentDir, {
				rename: async () => {
					throw new Error(errorSentinel);
				},
			});
			expect(await store.write({ lastImportVersion: "1.2.3" })).toBe(false);
			expect(await fs.readFile(statePath, "utf-8")).toBe(durableBytes);
			expect((await fs.readdir(agentDir)).filter(entry => entry.includes(".tmp."))).toEqual([]);
			expect(warning).toHaveBeenCalledWith("Credential auto-import state persistence failed", {
				classification: "state-write-failed",
			});
			expect(JSON.stringify(warning.mock.calls)).not.toContain(errorSentinel);
		} finally {
			warning.mockRestore();
		}
	});

	test("uses the normal-read projection inside the lock transaction", async () => {
		const agentDir = await createTemporaryAgentDir();
		const statePath = getCredentialAutoImportStatePath(agentDir);
		await fs.writeFile(statePath, '{"initialImportResolution":"later","lastImportVersion":"1.2.3"}\n');
		const store = createCredentialAutoImportStateStore(agentDir);
		expect(await store.read()).toEqual({
			state: { lastImportVersion: "1.2.3" },
			problems: ["invalid-initial-import-resolution"],
			unreadable: false,
		});
		expect(await store.write({ initialImportResolution: "accepted" })).toBe(true);
		expect(await fs.readFile(statePath, "utf-8")).toBe(
			'{"lastImportVersion":"1.2.3","initialImportResolution":"accepted"}\n',
		);
	});

	test("projects valid canonical resolution independently and repairs an invalid marker sibling", async () => {
		const agentDir = await createTemporaryAgentDir();
		const statePath = getCredentialAutoImportStatePath(agentDir);
		await fs.writeFile(statePath, '{"ignored":true,"initialImportResolution":"declined","lastImportVersion":7}\n');

		const initialRead = await readCredentialAutoImportState(agentDir);
		expect(initialRead.state).toEqual({ initialImportResolution: "declined" });
		expect(initialRead.problems).toEqual(["invalid-last-import-version"]);

		const store = createCredentialAutoImportStateStore(agentDir);
		expect(await store.write({ lastImportVersion: "1.2.3" })).toBe(true);
		expect(await fs.readFile(statePath, "utf-8")).toBe(
			'{"lastImportVersion":"1.2.3","initialImportResolution":"declined"}\n',
		);
	});

	test("keeps a valid marker when the canonical sibling is invalid and replaces it with the first terminal resolution", async () => {
		const agentDir = await createTemporaryAgentDir();
		const statePath = getCredentialAutoImportStatePath(agentDir);
		await fs.writeFile(statePath, '{"initialImportResolution":"later","lastImportVersion":"1.2.3"}\n');

		const initialRead = await readCredentialAutoImportState(agentDir);
		expect(initialRead.state).toEqual({ lastImportVersion: "1.2.3" });
		expect(initialRead.problems).toEqual(["invalid-initial-import-resolution"]);

		const store = createCredentialAutoImportStateStore(agentDir);
		expect(await store.write({ initialImportResolution: "accepted" })).toBe(true);
		expect(await readCredentialAutoImportState(agentDir)).toEqual({
			state: { lastImportVersion: "1.2.3", initialImportResolution: "accepted" },
			problems: [],
			unreadable: false,
		});
	});

	for (const { label, first, second, expectedBytes } of [
		{
			label: "accepted before declined",
			first: "accepted",
			second: "declined",
			expectedBytes: '{"initialImportResolution":"accepted"}\n',
		},
		{
			label: "declined before accepted",
			first: "declined",
			second: "accepted",
			expectedBytes: '{"initialImportResolution":"declined"}\n',
		},
	] as const) {
		test(`preserves the first terminal resolution with barrier-controlled ${label} writers`, async () => {
			const agentDir = await createTemporaryAgentDir();
			expect(
				await writeStateTransactionsInOrder(
					agentDir,
					{ initialImportResolution: first },
					{ initialImportResolution: second },
				),
			).toEqual([true, true]);
			expect(await fs.readFile(getCredentialAutoImportStatePath(agentDir), "utf-8")).toBe(expectedBytes);
		});
	}

	for (const { label, first, second } of [
		{
			label: "marker before resolution",
			first: { lastImportVersion: "1.2.3" },
			second: { initialImportResolution: "declined" },
		},
		{
			label: "resolution before marker",
			first: { initialImportResolution: "declined" },
			second: { lastImportVersion: "1.2.3" },
		},
	] as const) {
		test(`merges marker and terminal resolution with barrier-controlled ${label} writers`, async () => {
			const agentDir = await createTemporaryAgentDir();
			expect(await writeStateTransactionsInOrder(agentDir, first, second)).toEqual([true, true]);
			expect(await fs.readFile(getCredentialAutoImportStatePath(agentDir), "utf-8")).toBe(
				'{"lastImportVersion":"1.2.3","initialImportResolution":"declined"}\n',
			);
		});
	}

	test("accepted and declined real state suppress restart discovery", async () => {
		const acceptedAgentDir = await createTemporaryAgentDir();
		let acceptedDiscoveryReads = 0;
		const acceptedAuthStorage = {
			importCredentialIfAbsent: async () => skipped(),
		};
		const acceptedDiscover = async () => {
			acceptedDiscoveryReads += 1;
			return discovery([oauthCredential()]);
		};
		await runStartupCredentialAutoImportIfNeeded({
			authStorage: acceptedAuthStorage as never,
			modelRegistry: { refresh: async () => {} } as never,
			discover: acceptedDiscover,
			version: "1.2.3",
			agentDir: acceptedAgentDir,
		});
		await runStartupCredentialAutoImportIfNeeded({
			authStorage: acceptedAuthStorage as never,
			modelRegistry: { refresh: async () => {} } as never,
			discover: acceptedDiscover,
			version: "1.2.4",
			agentDir: acceptedAgentDir,
		});
		expect(acceptedDiscoveryReads).toBe(1);

		const declinedAgentDir = await createTemporaryAgentDir();
		const declinedStore = createCredentialAutoImportStateStore(declinedAgentDir);
		expect(await declinedStore.write({ initialImportResolution: "declined" })).toBe(true);
		let declinedDiscoveryReads = 0;
		await runStartupCredentialAutoImportIfNeeded({
			authStorage: acceptedAuthStorage as never,
			modelRegistry: { refresh: async () => {} } as never,
			discover: async () => {
				declinedDiscoveryReads += 1;
				return discovery([oauthCredential()]);
			},
			version: "1.2.3",
			agentDir: declinedAgentDir,
		});
		expect(declinedDiscoveryReads).toBe(0);
	});

	for (const { label, serialized } of [
		{
			label: "canonical-valid marker-invalid",
			serialized: '{"initialImportResolution":"accepted","lastImportVersion":"later"}\n',
		},
		{
			label: "marker-valid canonical-invalid",
			serialized: `{"initialImportResolution":"later","lastImportVersion":"${VERSION}"}\n`,
		},
	] as const) {
		test(`startup skips discovery for ${label} state projection`, async () => {
			const agentDir = await createTemporaryAgentDir();
			const statePath = getCredentialAutoImportStatePath(agentDir);
			let discoveryReads = 0;
			await fs.writeFile(statePath, serialized);
			await runStartupCredentialAutoImportIfNeeded({
				authStorage: { importCredentialIfAbsent: async () => inserted() },
				modelRegistry: { refresh: async () => {} } as never,
				discover: async () => {
					discoveryReads += 1;
					return discovery([oauthCredential()]);
				},
				agentDir,
			});
			expect(discoveryReads).toBe(0);
			expect(await fs.readFile(statePath, "utf-8")).toBe(serialized);
		});
	}
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
	function inMemoryStateStore(initial: CredentialAutoImportStateFile = {}) {
		const state: CredentialAutoImportStateFile = { ...initial };
		const writes: CredentialAutoImportStateFile[] = [];
		const stateStore: CredentialAutoImportStateStore = {
			read: async () => ({ state: { ...state }, problems: [], unreadable: false }),
			write: async mutation => {
				if (mutation.lastImportVersion !== undefined) state.lastImportVersion = mutation.lastImportVersion;
				if (state.initialImportResolution === undefined && mutation.initialImportResolution !== undefined) {
					state.initialImportResolution = mutation.initialImportResolution;
				}
				writes.push({ ...state });
				return true;
			},
		};
		return { state, stateStore, writes };
	}
	function createControllerHarness(
		args: {
			confirm: boolean;
			importOutcome?: AuthCredentialIfAbsentSnapshotResult;
			importOutcomes?: Array<AuthCredentialIfAbsentSnapshotResult | Error>;
			onImport?: () => void;
			onRequestRender?: () => void;
			agentDir?: string;
		},
		stateStore?: CredentialAutoImportStateStore,
	) {
		installTestTheme();
		const importCalls: string[] = [];
		const refreshCalls: string[] = [];
		const confirmMessages: Array<{ title: string; message: string }> = [];
		const warnings: string[] = [];
		const statuses: string[] = [];
		const settingsReads: string[] = [];
		const editorContainer = new Container();
		const ctx = {
			ui: { setFocus: mock(() => {}), requestRender: mock(() => args.onRequestRender?.()) },
			editorContainer,
			editor: new Container(),
			chatContainer: new Container(),
			settings: {
				getAgentDir: () => {
					settingsReads.push("read");
					return args.agentDir ?? path.join(os.tmpdir(), "gjc-credential-auto-import-controller");
				},
			},
			showWarning: (message: string) => warnings.push(message),
			showStatus: (message: string) => statuses.push(message),
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
							const outcome = args.importOutcomes?.shift() ?? args.importOutcome ?? inserted(provider);
							if (outcome instanceof Error) throw outcome;
							args.onImport?.();
							return outcome;
						},
					},
					getApiKeyForProvider: mock(async () => undefined),
				},
			},
		} as never;
		return {
			controller: new SelectorController(ctx, stateStore),
			importCalls,
			refreshCalls,
			confirmMessages,
			editorContainer,
			settingsReads,
			statuses,
			warnings,
		};
	}

	function bareLoginOptions(result: CredentialDiscoveryResult = discovery([oauthCredential()])) {
		return {
			allowExternalCredentialDiscovery: true,
			trigger: "bare-login" as const,
			externalCredentialDiscover: async () => result,
		};
	}

	test("bare /login shows rotation warning before persisting imported OAuth credentials", async () => {
		const state = inMemoryStateStore();
		const harness = createControllerHarness({ confirm: true }, state.stateStore);

		await harness.controller.showOAuthSelector("login", undefined, bareLoginOptions());

		expect(harness.confirmMessages).toHaveLength(1);
		expect(harness.confirmMessages[0]?.message).toContain("Claude (Anthropic) · Claude Code file: 1");
		expect(harness.confirmMessages[0]?.message).not.toContain("Claude Code (test)");
		expect(harness.confirmMessages[0]?.message).not.toContain(oauthCredential().redactedToken);
		expect(harness.confirmMessages[0]?.message).toContain(CREDENTIAL_AUTO_IMPORT_ROTATION_WARNING);
		expect(harness.importCalls).toEqual(["anthropic"]);
		expect(harness.refreshCalls).toEqual(["offline"]);
		expect(state.state.initialImportResolution).toBe("accepted");
	});

	test("declining bare /login import persists a permanent decline without importing credentials", async () => {
		const state = inMemoryStateStore();
		const harness = createControllerHarness({ confirm: false }, state.stateStore);

		await harness.controller.showOAuthSelector("login", undefined, bareLoginOptions());

		expect(harness.confirmMessages).toHaveLength(1);
		expect(harness.importCalls).toEqual([]);
		expect(harness.refreshCalls).toEqual([]);
		expect(state.state.initialImportResolution).toBe("declined");
	});

	test("confirmed bare /login import remains idempotent when credential already exists", async () => {
		const harness = createControllerHarness(
			{ confirm: true, importOutcome: skipped() },
			inMemoryStateStore().stateStore,
		);

		await harness.controller.showOAuthSelector("login", undefined, bareLoginOptions());

		expect(harness.confirmMessages).toHaveLength(1);
		expect(harness.importCalls).toEqual(["anthropic"]);
		expect(harness.refreshCalls).toEqual([]);
	});

	test("bare /login leaves canonical state unresolved when every accepted credential write fails", async () => {
		const errorSentinel = "LOGIN_ALL_WRITES_FAILED_SENTINEL";
		const state = inMemoryStateStore();
		const warning = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const harness = createControllerHarness(
				{ confirm: true, importOutcomes: [new Error(`write conflict ${errorSentinel}`)] },
				state.stateStore,
			);
			let discoveryReads = 0;
			await harness.controller.showOAuthSelector("login", undefined, {
				...bareLoginOptions(),
				externalCredentialDiscover: async () => {
					discoveryReads += 1;
					return discovery([oauthCredential()]);
				},
			});
			expect(discoveryReads).toBe(2);
			expect(harness.importCalls).toEqual(["anthropic"]);
			expect(state.writes).toEqual([]);
			expect(state.state).toEqual({});
			expect(harness.warnings).toEqual([CREDENTIAL_AUTO_IMPORT_RETRY_WARNING]);
			expect(harness.editorContainer.children).toHaveLength(1);
			expect(warning).toHaveBeenCalledWith("Credential auto-import completed with failures", {
				trigger: "bare-login",
				failureCounts: { "write-conflict": 1 },
			});
			const visible = JSON.stringify({
				logs: warning.mock.calls,
				confirmMessages: harness.confirmMessages,
				warnings: harness.warnings,
				statuses: harness.statuses,
			});
			expect(visible).not.toContain(errorSentinel);
		} finally {
			warning.mockRestore();
		}
	});

	test("bare /login leaves canonical state unresolved when the accepted second scan fails globally", async () => {
		const errorSentinel = "LOGIN_SECOND_SCAN_FAILURE_SENTINEL";
		const state = inMemoryStateStore();
		const warning = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const harness = createControllerHarness({ confirm: true }, state.stateStore);
			let discoveryReads = 0;
			await harness.controller.showOAuthSelector("login", undefined, {
				...bareLoginOptions(),
				externalCredentialDiscover: async () => {
					discoveryReads += 1;
					if (discoveryReads === 2) throw new Error(`second scan failed ${errorSentinel}`);
					return discovery([oauthCredential()]);
				},
			});
			expect(discoveryReads).toBe(2);
			expect(harness.importCalls).toEqual([]);
			expect(state.writes).toEqual([]);
			expect(state.state).toEqual({});
			expect(harness.warnings).toEqual([CREDENTIAL_AUTO_IMPORT_RETRY_WARNING]);
			expect(harness.editorContainer.children).toHaveLength(1);
			expect(warning).toHaveBeenCalledWith("Credential auto-import completed with failures", {
				trigger: "bare-login",
				failureCounts: { "discovery-unavailable": 1 },
			});
			const visible = JSON.stringify({
				logs: warning.mock.calls,
				confirmMessages: harness.confirmMessages,
				warnings: harness.warnings,
				statuses: harness.statuses,
			});
			expect(visible).not.toContain(errorSentinel);
		} finally {
			warning.mockRestore();
		}
	});

	test("bare /login keeps accepted state and exposes only bounded mixed failure evidence", async () => {
		const sourceSentinel = "LOGIN_SOURCE_SENTINEL";
		const reasonSentinel = "LOGIN_REASON_SENTINEL";
		const environmentSentinel = "LOGIN_ENVIRONMENT_SENTINEL";
		const errorSentinel = "LOGIN_ERROR_SENTINEL";
		const result: CredentialDiscoveryResult = {
			importable: [
				oauthCredential({ source: sourceSentinel }),
				oauthCredential({ provider: "openai-codex", origin: "codex-file", source: sourceSentinel }),
				oauthCredential({ source: sourceSentinel }),
			],
			skipped: [{ origin: "claude-code-file", source: sourceSentinel, reason: `unreadable ${reasonSentinel}` }],
			environment: [{ provider: "anthropic", variable: environmentSentinel, redactedValue: environmentSentinel }],
		};
		const state = inMemoryStateStore();
		const warning = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const harness = createControllerHarness(
				{
					confirm: true,
					importOutcomes: [
						inserted("anthropic"),
						skipped("openai-codex"),
						new Error(`write conflict ${errorSentinel}`),
					],
				},
				state.stateStore,
			);
			await harness.controller.showOAuthSelector("login", undefined, bareLoginOptions(result));
			expect(state.state.initialImportResolution).toBe("accepted");
			expect(harness.importCalls).toEqual(["anthropic", "openai-codex", "anthropic"]);
			expect(harness.warnings).toEqual([CREDENTIAL_AUTO_IMPORT_RETRY_WARNING]);
			expect(warning).toHaveBeenCalledWith("Credential auto-import completed with failures", {
				trigger: "bare-login",
				failureCounts: { "source-unreadable": 1, "write-conflict": 1 },
			});
			const visible = JSON.stringify({
				state: state.state,
				logs: warning.mock.calls,
				confirmMessages: harness.confirmMessages,
				warnings: harness.warnings,
				statuses: harness.statuses,
			});
			for (const sentinel of [sourceSentinel, reasonSentinel, environmentSentinel, errorSentinel]) {
				expect(visible).not.toContain(sentinel);
			}
		} finally {
			warning.mockRestore();
		}
	});

	test("resolved and same-version legacy state suppress bare /login discovery before preview", async () => {
		for (const initialState of [
			{ initialImportResolution: "accepted" as const },
			{ initialImportResolution: "declined" as const },
			{ lastImportVersion: VERSION },
		]) {
			const state = inMemoryStateStore(initialState);
			const harness = createControllerHarness({ confirm: true }, state.stateStore);
			let discoveryReads = 0;
			await harness.controller.showOAuthSelector("login", undefined, {
				...bareLoginOptions(),
				externalCredentialDiscover: async () => {
					discoveryReads += 1;
					return discovery([oauthCredential()]);
				},
			});
			expect(discoveryReads).toBe(0);
			expect(harness.confirmMessages).toHaveLength(0);
		}
	});

	test("bare /login reads resolved state from the configured agent directory", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-credential-auto-import-controller-"));
		try {
			await createCredentialAutoImportStateStore(agentDir).write({ initialImportResolution: "declined" });
			const harness = createControllerHarness({ confirm: true, agentDir });
			let discoveryReads = 0;
			await harness.controller.showOAuthSelector("login", undefined, {
				...bareLoginOptions(),
				externalCredentialDiscover: async () => {
					discoveryReads += 1;
					return discovery();
				},
			});
			expect(harness.settingsReads).toEqual(["read"]);
			expect(discoveryReads).toBe(0);
			expect(harness.confirmMessages).toHaveLength(0);
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	for (const { label, serialized } of [
		{
			label: "canonical-valid marker-invalid",
			serialized: '{"initialImportResolution":"accepted","lastImportVersion":"later"}\n',
		},
		{
			label: "marker-valid canonical-invalid",
			serialized: `{"initialImportResolution":"later","lastImportVersion":"${VERSION}"}\n`,
		},
	] as const) {
		test(`bare /login skips discovery for ${label} state projection`, async () => {
			const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-credential-auto-import-controller-"));
			const statePath = getCredentialAutoImportStatePath(agentDir);
			try {
				await fs.writeFile(statePath, serialized);
				const harness = createControllerHarness({ confirm: true, agentDir });
				let discoveryReads = 0;
				await harness.controller.showOAuthSelector("login", undefined, {
					...bareLoginOptions(),
					externalCredentialDiscover: async () => {
						discoveryReads += 1;
						return discovery([oauthCredential()]);
					},
				});
				expect(harness.settingsReads).toEqual(["read"]);
				expect(discoveryReads).toBe(0);
				expect(harness.confirmMessages).toHaveLength(0);
				expect(await fs.readFile(statePath, "utf-8")).toBe(serialized);
			} finally {
				await fs.rm(agentDir, { recursive: true, force: true });
			}
		});
	}

	test("persists accepted and declined across controller restart with real state I/O", async () => {
		for (const [resolution, confirm] of [
			["accepted", true],
			["declined", false],
		] as const) {
			const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-credential-auto-import-controller-"));
			try {
				let firstDiscoveryReads = 0;
				const first = createControllerHarness({ confirm, agentDir });
				await first.controller.showOAuthSelector("login", undefined, {
					...bareLoginOptions(),
					externalCredentialDiscover: async () => {
						firstDiscoveryReads += 1;
						return discovery([oauthCredential()]);
					},
				});
				expect(first.settingsReads).toEqual(["read"]);
				expect(firstDiscoveryReads).toBe(confirm ? 2 : 1);
				expect(await readCredentialAutoImportState(agentDir)).toEqual({
					state: { initialImportResolution: resolution },
					problems: [],
					unreadable: false,
				});

				let restartDiscoveryReads = 0;
				const restarted = createControllerHarness({ confirm: true, agentDir });
				await restarted.controller.showOAuthSelector("login", undefined, {
					...bareLoginOptions(),
					externalCredentialDiscover: async () => {
						restartDiscoveryReads += 1;
						return discovery([oauthCredential()]);
					},
				});
				expect(restarted.settingsReads).toEqual(["read"]);
				expect(restartDiscoveryReads).toBe(0);
				expect(restarted.confirmMessages).toEqual([]);
				expect(restarted.importCalls).toEqual([]);
			} finally {
				await fs.rm(agentDir, { recursive: true, force: true });
			}
		}
	});

	test("old legacy marker remains eligible and failed persistence re-offers after a real-state restart", async () => {
		const oldMarker = inMemoryStateStore({ lastImportVersion: "0.0.1" });
		const oldMarkerHarness = createControllerHarness({ confirm: false }, oldMarker.stateStore);
		await oldMarkerHarness.controller.showOAuthSelector("login", undefined, bareLoginOptions());
		expect(oldMarkerHarness.confirmMessages).toHaveLength(1);

		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-credential-auto-import-controller-"));
		try {
			const realStateStore = createCredentialAutoImportStateStore(agentDir);
			let writes = 0;
			const failingStateStore: CredentialAutoImportStateStore = {
				read: realStateStore.read,
				write: async () => {
					writes += 1;
					return false;
				},
			};
			const first = createControllerHarness({ confirm: false, agentDir }, failingStateStore);
			await first.controller.showOAuthSelector("login", undefined, bareLoginOptions());
			expect(writes).toBe(1);
			expect(first.warnings).toEqual([CREDENTIAL_AUTO_IMPORT_PERSISTENCE_WARNING]);
			expect(await readCredentialAutoImportState(agentDir)).toEqual({ state: {}, problems: [], unreadable: false });

			let retryDiscoveryReads = 0;
			const restarted = createControllerHarness({ confirm: false, agentDir }, failingStateStore);
			await restarted.controller.showOAuthSelector("login", undefined, {
				...bareLoginOptions(),
				externalCredentialDiscover: async () => {
					retryDiscoveryReads += 1;
					return discovery([oauthCredential()]);
				},
			});
			expect(retryDiscoveryReads).toBe(1);
			expect(restarted.confirmMessages).toHaveLength(1);
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	test("explicit provider credential import bypasses automatic import state after the final render", async () => {
		let discoveryReads = 0;
		const { promise: importCompleted, resolve: resolveImport } = Promise.withResolvers<void>();
		const discoverSpy = spyOn(credentialImport, "discoverExternalCredentials").mockImplementation(async () => {
			discoveryReads += 1;
			return discovery([oauthCredential()]);
		});
		let stateReads = 0;
		let stateWrites = 0;
		const stateStore: CredentialAutoImportStateStore = {
			read: async () => {
				stateReads += 1;
				return { state: {}, problems: [], unreadable: false };
			},
			write: async () => {
				stateWrites += 1;
				return true;
			},
		};
		let importStarted = false;
		try {
			const harness = createControllerHarness(
				{
					confirm: true,
					onImport: () => {
						importStarted = true;
					},
					onRequestRender: () => {
						if (importStarted) resolveImport();
					},
				},
				stateStore,
			);
			harness.controller.showProviderOnboarding();
			const selector = harness.editorContainer.children[0];
			if (!(selector instanceof ProviderOnboardingSelectorComponent)) {
				throw new Error("Expected provider onboarding selector");
			}
			selector.handleInput("\x1b[B");
			selector.handleInput("\x1b[B");
			selector.handleInput("\x1b[B");
			selector.handleInput("\n");
			await importCompleted;
			expect(discoveryReads).toBe(2);
			expect(harness.importCalls).toEqual(["anthropic"]);
			expect(stateReads).toBe(0);
			expect(stateWrites).toBe(0);
			expect(harness.settingsReads).toEqual([]);
		} finally {
			discoverSpy.mockRestore();
		}
	});
});
