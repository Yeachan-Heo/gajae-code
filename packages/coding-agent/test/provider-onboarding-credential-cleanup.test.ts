import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import type { CliConfig } from "@gajae-code/utils/cli";
import { YAML } from "bun";
import Accounts from "../src/commands/accounts";
import AuthBroker from "../src/commands/auth-broker";
import Setup from "../src/commands/setup";
import { ModelRegistry } from "../src/config/model-registry";
import { resetSettingsForTest } from "../src/config/settings";
import { AuthStorage, SqliteAuthCredentialStore } from "../src/session/auth-storage";
import { addApiCompatibleProvider, formatProviderSetupResult } from "../src/setup/provider-onboarding";
import { lookupBuiltinSlashCommand, parseProviderSetupSlashArgs } from "../src/slash-commands/builtin-registry";

const originalAgentDir = getAgentDir();
let tempRoot: string | undefined;
let modelsPath: string;
let store: SqliteAuthCredentialStore | undefined;
let authStorage: AuthStorage | undefined;

beforeEach(async () => {
	resetSettingsForTest();
	tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-store-credential-"));
	// A dedicated agent dir keeps the credential store (and the literal keys
	// these tests publish to it) out of the developer's real ~/.gjc.
	setAgentDir(path.join(tempRoot, "agent"));
	modelsPath = path.join(tempRoot, "models.yml");
	store = await SqliteAuthCredentialStore.open(path.join(tempRoot, "agent", "agent.db"));
	authStorage = new AuthStorage(store);
});

afterEach(async () => {
	store?.close();
	store = undefined;
	authStorage = undefined;
	setAgentDir(originalAgentDir);
	resetSettingsForTest();
	if (tempRoot) {
		await fs.rm(tempRoot, { recursive: true, force: true });
		tempRoot = undefined;
	}
});

interface WrittenProvider {
	baseUrl?: string;
	api?: string;
	auth?: string;
	credential?: string;
	apiKey?: string;
	apiKeyEnv?: string;
	models?: Array<{ id: string }>;
}

async function readWrittenProvider(providerId: string): Promise<WrittenProvider> {
	const parsed = YAML.parse(await Bun.file(modelsPath).text()) as {
		providers: Record<string, WrittenProvider>;
	};
	return parsed.providers[providerId]!;
}

/** The recovery step must be usable: no raw key flag, and an explicit env form. */
function expectRecoveryGuidance(message: string): void {
	expect(message).toContain("running `/provider` with no arguments in the interactive TUI");
	expect(message).toContain("--api-key-env <ENV>");
	expect(message).toContain("(--model <id> | --discover) --force");
	expect(message).toContain("gjc setup provider");
	expect(message).not.toContain("with a working key");
	expect(message).not.toMatch(/--api-key\b(?!-)/);
}

describe("custom provider credential cleanup", () => {
	it("force-replacing a store-backed provider with an env-backed one drops the stale stored key", async () => {
		const envName = "GJC_STORE_TO_ENV_TEST_KEY";
		const previousEnv = Bun.env[envName];
		Bun.env[envName] = "sk-from-environment";
		try {
			await addApiCompatibleProvider({
				compatibility: "openai",
				providerId: "flip-provider",
				baseUrl: "https://api.example.com/v1",
				apiKey: "sk-literal-stale",
				models: ["literal-model"],
				modelsPath,
				authStorage,
			});
			// An OAuth row added later must survive the api_key cleanup.
			await authStorage!.set("flip-provider", [
				{ type: "api_key", key: "sk-literal-stale" },
				{
					type: "oauth",
					access: "oauth-access-token",
					refresh: "oauth-refresh-token",
					expires: Date.now() + 3_600_000,
				},
			]);
			const before = new ModelRegistry(authStorage!, modelsPath);
			await before.refresh("offline");
			expect(await before.getApiKeyForProvider("flip-provider")).toBe("sk-literal-stale");

			const result = await addApiCompatibleProvider({
				compatibility: "openai",
				providerId: "flip-provider",
				baseUrl: "https://api.example.com/v1",
				apiKeyEnv: envName,
				models: ["env-model"],
				modelsPath,
				force: true,
				authStorage,
			});
			expect(result.credentialSource).toBe("env");
			expect(result.credentialCleanup).toEqual({ disabledApiKeys: 1, envName });
			const banner = formatProviderSetupResult(result);
			expect(banner).toContain("Stored API key: disabled 1 stored credential(s) for this provider");
			expect(banner).toContain("they no longer resolve");
			expect(banner).toContain(`${envName} now supplies the key`);
			expect(banner).toContain("gjc accounts logout flip-provider --all");
			expect(banner).toContain("removes every stored credential for this provider, including OAuth logins");
			expect(banner).not.toContain("Stored API key: removed");
			const provider = await readWrittenProvider("flip-provider");
			expect(provider.apiKeyEnv).toBe(envName);
			expect(provider.credential).toBeUndefined();

			const remaining = authStorage!
				.exportSnapshot()
				.credentials.filter(entry => entry.provider === "flip-provider")
				.map(entry => entry.credential.type);
			expect(remaining).toEqual(["oauth"]);

			// What survives the process is what matters: reopen the SQLite store and
			// confirm the api_key row is not merely absent from the in-memory snapshot.
			const reopened = await SqliteAuthCredentialStore.open(path.join(tempRoot!, "agent", "agent.db"));
			try {
				const persisted = reopened.listAuthCredentials("flip-provider").map(entry => entry.credential.type);
				expect(persisted).toEqual(["oauth"]);
			} finally {
				reopened.close();
			}

			const after = new ModelRegistry(authStorage!, modelsPath);
			await after.refresh("offline");
			expect(await after.getApiKeyForProvider("flip-provider")).toBe("sk-from-environment");
		} finally {
			if (previousEnv === undefined) delete Bun.env[envName];
			else Bun.env[envName] = previousEnv;
		}
	});

	it("does not delete a stored key when the replaced entry never declared credential: store", async () => {
		const envName = "GJC_ENV_PINNED_REPLACEMENT_KEY";
		const previousEnv = Bun.env[envName];
		Bun.env[envName] = "sk-new-env-value";
		try {
			await Bun.write(
				modelsPath,
				[
					"providers:",
					"  env-pinned:",
					"    baseUrl: https://api.example.com/v1",
					"    api: openai-completions",
					"    apiKeyEnv: OLD_ENV_NAME",
					"    models:",
					"      - id: old-model",
					"",
				].join("\n"),
			);
			// A stored key may exist for unrelated reasons (for example a login).
			// The replaced entry never declared credential: store, so it is not ours
			// to delete.
			await authStorage!.set("env-pinned", { type: "api_key", key: "sk-login-owned-key" });

			const result = await addApiCompatibleProvider({
				compatibility: "openai",
				providerId: "env-pinned",
				baseUrl: "https://api.example.com/v1",
				apiKeyEnv: envName,
				models: ["new-model"],
				modelsPath,
				force: true,
				authStorage,
			});

			expect(result.credentialCleanup).toBeUndefined();
			expect(result.storedCredentialShadow).toEqual({ storedApiKeys: 1, envName });
			const banner = formatProviderSetupResult(result);
			expect(banner).not.toContain("Stored API key: removed");
			expect(banner).toContain("1 stored API key credential(s) for this provider take precedence");
			expect(banner).toContain("gjc accounts logout env-pinned --all");
			const remaining = authStorage!
				.exportSnapshot()
				.credentials.filter(entry => entry.provider === "env-pinned")
				.map(entry => entry.credential.type);
			expect(remaining).toEqual(["api_key"]);

			const reopened = await SqliteAuthCredentialStore.open(path.join(tempRoot!, "agent", "agent.db"));
			try {
				const persisted = reopened.listAuthCredentials("env-pinned").map(entry => entry.credential.type);
				expect(persisted).toEqual(["api_key"]);
			} finally {
				reopened.close();
			}
		} finally {
			if (previousEnv === undefined) delete Bun.env[envName];
			else Bun.env[envName] = previousEnv;
		}
	});

	it("refuses a store-to-env replacement when the replacement env is unset", async () => {
		const envName = "GJC_STORE_TO_UNSET_ENV_KEY";
		delete Bun.env[envName];
		await addApiCompatibleProvider({
			compatibility: "openai",
			providerId: "unset-env-provider",
			baseUrl: "https://api.example.com/v1",
			apiKey: "sk-kept-literal",
			models: ["literal-model"],
			modelsPath,
			authStorage,
		});

		await expect(
			addApiCompatibleProvider({
				compatibility: "openai",
				providerId: "unset-env-provider",
				baseUrl: "https://api.example.com/v1",
				apiKeyEnv: envName,
				models: ["env-model"],
				modelsPath,
				force: true,
				authStorage,
			}),
		).rejects.toThrow(`${envName} is not set`);

		const provider = await readWrittenProvider("unset-env-provider");
		expect(provider.credential).toBe("store");
		expect(provider.apiKeyEnv).toBeUndefined();
		expect(await authStorage!.peekApiKey("unset-env-provider")).toBe("sk-kept-literal");
	});

	it("reports broker-owned stores that reject credential deletion", async () => {
		const envName = "GJC_BROKER_STORE_SWITCH_KEY";
		const previousEnv = Bun.env[envName];
		Bun.env[envName] = "sk-broker-env-value";
		try {
			await Bun.write(
				modelsPath,
				[
					"providers:",
					"  broker-provider:",
					"    baseUrl: https://api.example.com/v1",
					"    api: openai-completions",
					"    credential: store",
					"    models:",
					"      - id: broker-model",
					"",
				].join("\n"),
			);
			const remoteStore = {
				exportSnapshot: () => ({
					generation: 1,
					generatedAt: Date.now(),
					credentials: [
						{
							id: 11,
							provider: "broker-provider",
							credential: { type: "api_key" as const, key: "sk-broker-owned" },
							identityKey: null,
						},
					],
				}),
				set: async () => undefined,
				remove: async () => undefined,
				disableCredentialById: () => {
					throw new Error("Remote auth-broker credentials can only be disabled on the broker host");
				},
				reload: async () => undefined,
			};

			const brokerError = await addApiCompatibleProvider({
				compatibility: "openai",
				providerId: "broker-provider",
				baseUrl: "https://api.example.com/v1",
				apiKeyEnv: envName,
				models: ["env-model"],
				modelsPath,
				force: true,
				authStorage: remoteStore,
			}).then(
				() => undefined,
				(error: unknown) => error,
			);
			const brokerMessage = brokerError instanceof Error ? brokerError.message : String(brokerError);
			expect(brokerMessage).toMatch(
				/broker-owned[\s\S]*gjc auth-broker logout broker-provider[\s\S]*including OAuth rows[\s\S]*previous provider settings were restored/,
			);
			// A rejected disable leaves the active rows in place, so the provider still
			// resolves them; the text must not claim otherwise.
			expect(brokerMessage).toContain(
				"rows not confirmed disabled still resolve and remain the provider's credential",
			);
			expect(brokerMessage).not.toContain("no resolving stored key");
			expectRecoveryGuidance(brokerMessage);

			const provider = await readWrittenProvider("broker-provider");
			expect(provider.credential).toBe("store");
			expect(provider.apiKeyEnv).toBeUndefined();
		} finally {
			if (previousEnv === undefined) delete Bun.env[envName];
			else Bun.env[envName] = previousEnv;
		}
	});

	it("fails loudly when a stored API key survives cleanup", async () => {
		const envName = "GJC_SURVIVING_STORE_KEY";
		const previousEnv = Bun.env[envName];
		Bun.env[envName] = "sk-surviving-env-value";
		try {
			await Bun.write(
				modelsPath,
				[
					"providers:",
					"  surviving-provider:",
					"    baseUrl: https://api.example.com/v1",
					"    api: openai-completions",
					"    credential: store",
					"    models:",
					"      - id: surviving-model",
					"",
				].join("\n"),
			);
			// A store whose delete silently does nothing: the in-memory snapshot still
			// reports the row, so verification must fail rather than claim success.
			const stuckStore = {
				exportSnapshot: () => ({
					generation: 1,
					generatedAt: Date.now(),
					credentials: [
						{
							id: 21,
							provider: "surviving-provider",
							credential: { type: "api_key" as const, key: "sk-surviving" },
							identityKey: null,
						},
					],
				}),
				set: async () => undefined,
				remove: async () => undefined,
				disableCredentialById: () => true,
				reload: async () => undefined,
			};

			const survivingError = await addApiCompatibleProvider({
				compatibility: "openai",
				providerId: "surviving-provider",
				baseUrl: "https://api.example.com/v1",
				apiKeyEnv: envName,
				models: ["env-model"],
				modelsPath,
				force: true,
				authStorage: stuckStore,
			}).then(
				() => undefined,
				(error: unknown) => error,
			);
			const survivingMessage = survivingError instanceof Error ? survivingError.message : String(survivingError);
			expect(survivingMessage).toMatch(
				/kept 1 stored API key credential\(s\)[\s\S]*gjc accounts logout surviving-provider --all[\s\S]*previous provider settings were restored/,
			);
			expect(survivingMessage).toContain(
				"the surviving rows above still resolve and remain the provider's credential",
			);
			expectRecoveryGuidance(survivingMessage);

			const provider = await readWrittenProvider("surviving-provider");
			expect(provider.credential).toBe("store");
		} finally {
			if (previousEnv === undefined) delete Bun.env[envName];
			else Bun.env[envName] = previousEnv;
		}
	});

	it("reports partial deletion without claiming disabled rows were restored", async () => {
		const envName = "GJC_PARTIAL_DELETE_KEY";
		const previousEnv = Bun.env[envName];
		Bun.env[envName] = "sk-partial-env-value";
		try {
			await Bun.write(
				modelsPath,
				[
					"providers:",
					"  partial-provider:",
					"    baseUrl: https://api.example.com/v1",
					"    api: openai-completions",
					"    credential: store",
					"    models:",
					"      - id: partial-model",
					"",
				].join("\n"),
			);
			await authStorage!.set("partial-provider", [
				{ type: "api_key", key: "sk-partial-one" },
				{ type: "api_key", key: "sk-partial-two" },
			]);

			let disableCalls = 0;
			const flakyStore = {
				exportSnapshot: () => authStorage!.exportSnapshot(),
				set: (...args: Parameters<AuthStorage["set"]>) => authStorage!.set(...args),
				remove: (...args: Parameters<AuthStorage["remove"]>) => authStorage!.remove(...args),
				disableCredentialById: (id: number, cause: string) => {
					disableCalls += 1;
					if (disableCalls === 2) throw new Error("simulated local delete failure");
					return authStorage!.disableCredentialById(id, cause);
				},
				reload: () => authStorage!.reload(),
			};

			await expect(
				addApiCompatibleProvider({
					compatibility: "openai",
					providerId: "partial-provider",
					baseUrl: "https://api.example.com/v1",
					apiKeyEnv: envName,
					models: ["env-model"],
					modelsPath,
					force: true,
					authStorage: flakyStore,
				}),
			).rejects.toThrow(
				/disabled 1 of 2[\s\S]*cannot be restored[\s\S]*gjc accounts logout partial-provider --all[\s\S]*removes every stored credential for this provider, including OAuth logins[\s\S]*previous provider settings were restored[\s\S]*rows already disabled stay disabled/,
			);
			expect(disableCalls).toBe(2);

			// Config rolled back; exactly one api_key row was already disabled and stays so.
			const provider = await readWrittenProvider("partial-provider");
			expect(provider.credential).toBe("store");
			const reopened = await SqliteAuthCredentialStore.open(path.join(tempRoot!, "agent", "agent.db"));
			try {
				const persisted = reopened
					.listAuthCredentials("partial-provider")
					.filter(entry => entry.credential.type === "api_key");
				expect(persisted).toHaveLength(1);
			} finally {
				reopened.close();
			}
		} finally {
			if (previousEnv === undefined) delete Bun.env[envName];
			else Bun.env[envName] = previousEnv;
		}
	});

	it("counts only confirmed disables in the partial-failure report", async () => {
		const envName = "GJC_UNCONFIRMED_DISABLE_KEY";
		const previousEnv = Bun.env[envName];
		Bun.env[envName] = "sk-unconfirmed-env-value";
		try {
			await Bun.write(
				modelsPath,
				[
					"providers:",
					"  unconfirmed-provider:",
					"    baseUrl: https://api.example.com/v1",
					"    api: openai-completions",
					"    credential: store",
					"    models:",
					"      - id: unconfirmed-model",
					"",
				].join("\n"),
			);
			await authStorage!.set("unconfirmed-provider", [
				{ type: "api_key", key: "sk-unconfirmed-one" },
				{ type: "api_key", key: "sk-unconfirmed-two" },
			]);

			// The first disable reports "row not found" (false, no throw), so it must
			// not count as a disable; the second one fails outright.
			let disableCalls = 0;
			const falseThenThrowStore = {
				exportSnapshot: () => authStorage!.exportSnapshot(),
				set: (...args: Parameters<AuthStorage["set"]>) => authStorage!.set(...args),
				remove: (...args: Parameters<AuthStorage["remove"]>) => authStorage!.remove(...args),
				disableCredentialById: () => {
					disableCalls += 1;
					if (disableCalls === 1) return false;
					throw new Error("simulated store failure");
				},
				reload: () => authStorage!.reload(),
			};

			let failure = "";
			try {
				await addApiCompatibleProvider({
					compatibility: "openai",
					providerId: "unconfirmed-provider",
					baseUrl: "https://api.example.com/v1",
					apiKeyEnv: envName,
					models: ["env-model"],
					modelsPath,
					force: true,
					authStorage: falseThenThrowStore,
				});
			} catch (error) {
				failure = error instanceof Error ? error.message : String(error);
			}
			expect(failure).toContain("disabled 0 of 2 before the failure");
			expect(failure).toContain("raised an error while disabling the rows");
			// An exception after a successful removal must not be reported as a
			// rejected disable.
			expect(failure).not.toContain("rejected the disable");
			expect(disableCalls).toBe(2);

			// Nothing was actually disabled: both rows are still active on disk.
			const reopened = await SqliteAuthCredentialStore.open(path.join(tempRoot!, "agent", "agent.db"));
			try {
				expect(reopened.listAuthCredentials("unconfirmed-provider")).toHaveLength(2);
			} finally {
				reopened.close();
			}
		} finally {
			if (previousEnv === undefined) delete Bun.env[envName];
			else Bun.env[envName] = previousEnv;
		}
	});

	it("reports an unconfirmable removal without claiming the store rejected the disable", async () => {
		const envName = "GJC_UNCONFIRMED_RELOAD_KEY";
		const previousEnv = Bun.env[envName];
		Bun.env[envName] = "sk-unconfirmed-reload-env-value";
		try {
			await Bun.write(
				modelsPath,
				[
					"providers:",
					"  reload-provider:",
					"    baseUrl: https://api.example.com/v1",
					"    api: openai-completions",
					"    credential: store",
					"    models:",
					"      - id: reload-model",
					"",
				].join("\n"),
			);
			await authStorage!.set("reload-provider", { type: "api_key", key: "sk-reload-stale" });

			// The disable itself succeeds; only the confirmation read fails.
			const unreadableReloadStore = {
				exportSnapshot: () => authStorage!.exportSnapshot(),
				set: (...args: Parameters<AuthStorage["set"]>) => authStorage!.set(...args),
				remove: (...args: Parameters<AuthStorage["remove"]>) => authStorage!.remove(...args),
				disableCredentialById: (id: number, cause: string) => authStorage!.disableCredentialById(id, cause),
				reload: async () => {
					throw new Error("snapshot read failed");
				},
			};

			let message = "";
			try {
				await addApiCompatibleProvider({
					compatibility: "openai",
					providerId: "reload-provider",
					baseUrl: "https://api.example.com/v1",
					apiKeyEnv: envName,
					models: ["env-model"],
					modelsPath,
					force: true,
					authStorage: unreadableReloadStore,
				});
			} catch (error) {
				message = error instanceof Error ? error.message : String(error);
			}

			expect(message).toContain("the store reported 1 of 1 stored API key credential(s) disabled");
			expect(message).toContain("the confirmation read failed");
			expect(message).not.toContain("(confirmed)");
			expect(message).toContain("may in fact be disabled");
			expect(message).toContain("gjc accounts list");
			expect(message).toContain("previous provider settings were restored");
			expect(message).toContain(
				"rows whose disable was not confirmed may still resolve and remain the provider's credential",
			);
			expect(message).not.toContain("no resolving stored key");
			expectRecoveryGuidance(message);
			// The disable was not rejected, so neither diagnosis nor its recovery may
			// be asserted for this path.
			expect(message).not.toContain("rejected the disable");
			expect(message).not.toContain("auth-broker logout");

			// Config rolled back to the store-backed declaration.
			expect((await readWrittenProvider("reload-provider")).credential).toBe("store");
		} finally {
			if (previousEnv === undefined) delete Bun.env[envName];
			else Bun.env[envName] = previousEnv;
		}
	});

	it("leaves the disabled row as a removable target for gjc accounts logout --all", async () => {
		const envName = "GJC_RECOVERY_HARD_DELETE_KEY";
		const previousEnv = Bun.env[envName];
		Bun.env[envName] = "sk-recovery-env-value";
		try {
			await addApiCompatibleProvider({
				compatibility: "openai",
				providerId: "recover-provider",
				baseUrl: "https://api.example.com/v1",
				apiKey: "sk-recover-me",
				models: ["recover-model"],
				modelsPath,
				authStorage,
			});
			const result = await addApiCompatibleProvider({
				compatibility: "openai",
				providerId: "recover-provider",
				baseUrl: "https://api.example.com/v1",
				apiKeyEnv: envName,
				models: ["recover-model"],
				modelsPath,
				force: true,
				authStorage,
			});
			expect(result.credentialCleanup).toEqual({ disabledApiKeys: 1, envName });

			// What this proves is store-level: the row setup soft-disabled is still
			// listed, still enumerated by `listCredentialRemovalTargets`, and removed
			// by `removeAuthCredentialsHard`. It does not exercise the CLI's own --all
			// selection set, which consumes the same store APIs.
			const inventory = authStorage!.listCredentialInventory("recover-provider");
			expect(inventory).toHaveLength(1);
			const row = inventory[0]!;
			expect(row.credentialKind).toBe("api_key");
			expect(row.disabled).toBe(true);

			const targets = authStorage!.listCredentialRemovalTargets("recover-provider");
			expect(targets.map(target => target.id)).toEqual([row.id]);
			const removed = authStorage!.removeAuthCredentialsHard("recover-provider", targets);
			expect(removed.kind).toBe("removed");

			// Empty active+disabled inventory, in memory and after reopening the DB.
			expect(authStorage!.listCredentialInventory("recover-provider")).toEqual([]);
			expect(
				authStorage!.exportSnapshot().credentials.filter(entry => entry.provider === "recover-provider"),
			).toEqual([]);
			const reopened = await SqliteAuthCredentialStore.open(path.join(tempRoot!, "agent", "agent.db"));
			try {
				expect(reopened.listCredentialInventory("recover-provider")).toEqual([]);
			} finally {
				reopened.close();
			}
		} finally {
			if (previousEnv === undefined) delete Bun.env[envName];
			else Bun.env[envName] = previousEnv;
		}
	});

	it("parses every command the cleanup guidance names with the real definitions", async () => {
		const providerId = "recovery-cli-provider";
		const envName = "GJC_RECOVERY_CLI_KEY";
		const previousEnv = Bun.env[envName];
		Bun.env[envName] = "sk-recovery-cli-env";
		try {
			await Bun.write(
				modelsPath,
				[
					"providers:",
					`  ${providerId}:`,
					"    baseUrl: https://api.example.com/v1",
					"    api: openai-completions",
					"    credential: store",
					"    models:",
					"      - id: recovery-model",
					"",
				].join("\n"),
			);
			// Drive a real cleanup failure and take its guidance as data.
			const remoteStore = {
				exportSnapshot: () => ({
					generation: 1,
					generatedAt: Date.now(),
					credentials: [
						{
							id: 71,
							provider: providerId,
							credential: { type: "api_key" as const, key: "sk-broker-owned" },
							identityKey: null,
						},
					],
				}),
				set: async () => undefined,
				remove: async () => undefined,
				disableCredentialById: () => {
					throw new Error("Remote auth-broker credentials can only be disabled on the broker host");
				},
				reload: async () => undefined,
			};
			let message = "";
			try {
				await addApiCompatibleProvider({
					compatibility: "openai",
					providerId,
					baseUrl: "https://api.example.com/v1",
					apiKeyEnv: envName,
					models: ["env-model"],
					modelsPath,
					force: true,
					authStorage: remoteStore,
				});
			} catch (error) {
				message = error instanceof Error ? error.message : String(error);
			}

			// The text promises these forms; each must parse against the real CLI.
			expect(message).toContain("gjc accounts list");
			expect(message).toContain(`gjc accounts logout ${providerId} --all`);
			expect(message).toContain(`gjc auth-broker logout ${providerId}`);
			expect(message).toContain("/provider add --compat <openai|anthropic>");
			expect(message).toContain("in the interactive TUI");

			const cliConfig: CliConfig = { bin: "gjc", version: "0.0.0-test", commands: new Map() };
			const accounts = await new Accounts(["logout", providerId, "--all"], cliConfig).parse(Accounts);
			expect(accounts.args.action).toBe("logout");
			expect(accounts.args.provider).toBe(providerId);
			expect(accounts.flags.all).toBe(true);

			const accountsList = await new Accounts(["list"], cliConfig).parse(Accounts);
			expect(accountsList.args.action).toBe("list");

			const broker = await new AuthBroker(["logout", providerId], cliConfig).parse(AuthBroker);
			expect(broker.args.action).toBe("logout");
			expect(broker.args.source).toBe(providerId);

			const setup = await new Setup(
				[
					"provider",
					"--compat",
					"openai",
					"--provider",
					providerId,
					"--base-url",
					"https://api.example.com/v1",
					"--api-key-env",
					"ENV",
					"--discover",
					"--force",
				],
				cliConfig,
			).parse(Setup);
			expect(setup.args.component).toBe("provider");
			expect(setup.flags.compat).toBe("openai");
			expect(setup.flags.provider).toBe(providerId);
			expect(setup.flags["api-key-env"]).toBe("ENV");
			expect(setup.flags.discover).toBe(true);
			expect(setup.flags.force).toBe(true);

			// The slash surface: the registry entry exists and its real arg parser
			// accepts the exact env-reference form the message shows.
			const providerCommand = lookupBuiltinSlashCommand("provider");
			expect(providerCommand).toBeDefined();
			expect(providerCommand?.allowArgs).toBe(true);
			expect(
				parseProviderSetupSlashArgs(
					`--compat openai --provider ${providerId} --base-url https://api.example.com/v1 --api-key-env ENV --discover --force`,
				),
			).toEqual({
				compat: "openai",
				provider: providerId,
				baseUrl: "https://api.example.com/v1",
				apiKeyEnv: "ENV",
				discover: true,
				force: true,
				models: [],
				rejectedRawApiKey: false,
			});
		} finally {
			if (previousEnv === undefined) delete Bun.env[envName];
			else Bun.env[envName] = previousEnv;
		}
	});
});
