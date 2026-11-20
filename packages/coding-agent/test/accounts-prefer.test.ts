import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthBrokerServerHandle, AuthStorage, SqliteAuthCredentialStore, startAuthBroker } from "@gajae-code/ai";
import { getAgentDbPath, resetAgentDirFromEnvironment, setAgentDir } from "@gajae-code/utils";
import { YAML } from "bun";
import { runAccountsCommand } from "../src/cli/accounts-cli";
import { resetSettingsForTest } from "../src/config/settings";
import { discoverAuthStorage } from "../src/sdk/session";
import { resolveStartupAuthConfig } from "../src/session/startup-auth-config";

// Each command run opens the credential store and refreshes the offline model registry, which exceeds the default
// timeout when the suite runs alongside other files.
const CLI_TIMEOUT_MS = 30_000;

type PreferJson = { ok: boolean; preferences?: unknown[]; cleared?: boolean; error?: { message: string } };

function oauth(email: string, accountId: string, organizationId?: string) {
	return {
		type: "oauth" as const,
		access: `access-${email}-${organizationId ?? "personal"}`,
		refresh: `refresh-${email}-${organizationId ?? "personal"}`,
		expires: Date.now() + 3_600_000,
		email,
		accountId,
		...(organizationId ? { organizationId, organizationName: `${organizationId} Team` } : {}),
	};
}

async function preferJson(selectors: string[] | undefined, clear = false): Promise<PreferJson> {
	const chunks: string[] = [];
	const original = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((chunk: Uint8Array | string): boolean => {
		chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
		return true;
	}) as typeof process.stdout.write;
	const priorExitCode = process.exitCode;
	try {
		await runAccountsCommand({ action: "prefer", provider: "anthropic", selectors, flags: { json: true, clear } });
	} finally {
		process.stdout.write = original as typeof process.stdout.write;
		process.exitCode = priorExitCode ?? 0;
	}
	return JSON.parse(chunks.join(""));
}

describe("gjc accounts prefer", () => {
	let agentDir = "";
	let originalAgentDir: string | undefined;
	let ids: number[] = [];

	beforeEach(async () => {
		originalAgentDir = process.env.GJC_CODING_AGENT_DIR;
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-accounts-prefer-"));
		setAgentDir(agentDir);
		resetSettingsForTest();
		const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
		try {
			for (const credential of [
				oauth("cheap@example.com", "acct-cheap"),
				oauth("shared@example.com", "acct-shared"),
				// One login that belongs to two organizations: neither its email nor its account id is unique.
				oauth("team@example.com", "acct-team", "org-a"),
				oauth("team@example.com", "acct-team", "org-b"),
			]) {
				store.upsertAuthCredentialForProvider("anthropic", credential);
			}
			ids = store.listAuthCredentials("anthropic").map(entry => entry.id);
			expect(ids).toHaveLength(4);
		} finally {
			store.close();
		}
	});

	afterEach(async () => {
		if (originalAgentDir === undefined) delete process.env.GJC_CODING_AGENT_DIR;
		else process.env.GJC_CODING_AGENT_DIR = originalAgentDir;
		resetAgentDirFromEnvironment();
		resetSettingsForTest();
		await fs.rm(agentDir, { recursive: true, force: true });
	});

	async function writtenPreferences(): Promise<unknown> {
		const file = Bun.file(path.join(agentDir, "config.yml"));
		if (!(await file.exists())) return undefined;
		const parsed = YAML.parse(await file.text()) as { auth?: { credentialPreferences?: unknown } } | null;
		return parsed?.auth?.credentialPreferences;
	}

	it(
		"writes the ordered list in the short config form that startup reads back",
		async () => {
			const result = await preferJson(["cheap@example.com", `id:${ids[1]}=75`]);

			expect(result).toEqual({
				ok: true,
				provider: "anthropic",
				preferences: ["cheap@example.com", { "shared@example.com": 75 }],
			} as never);
			expect(await writtenPreferences()).toEqual({
				anthropic: ["cheap@example.com", { "shared@example.com": 75 }],
			});
			expect((await resolveStartupAuthConfig(agentDir)).credentialPreferences).toEqual({
				anthropic: [
					{ selector: { kind: "email", value: "cheap@example.com" } },
					{ selector: { kind: "email", value: "shared@example.com" }, maxUsedFraction: 0.75 },
				],
			});
		},
		CLI_TIMEOUT_MS,
	);

	it.each([
		["a colon in its local part, in the email: form", "odd:name@example.com", "email:odd:name@example.com", "75"],
		["an account: prefix, in the email: form", "account:team@example.com", "email:account:team@example.com", "75"],
		["an email: prefix, in the email: form", "email:team@example.com", "email:email:team@example.com", "75"],
		["an equals sign in its local part, bare", "user=2@example.com", "user=2@example.com", undefined],
	])(
		"stores an email with %s that startup reads back as the same row",
		async (_label, email, written, cap) => {
			const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
			let rowId: number;
			try {
				store.upsertAuthCredentialForProvider("anthropic", oauth(email, `acct-${ids.length}`));
				rowId = store.listAuthCredentials("anthropic").find(entry => !ids.includes(entry.id))!.id;
			} finally {
				store.close();
			}
			const argument = cap === undefined ? email : `id:${rowId}=${cap}`;

			const result = await preferJson([argument]);

			const entry = cap === undefined ? written : { [written]: Number(cap) };
			expect(result.preferences).toEqual([entry]);
			expect(await writtenPreferences()).toEqual({ anthropic: [entry] });
			const [preference] = (await resolveStartupAuthConfig(agentDir)).credentialPreferences.anthropic ?? [];
			expect(preference?.selector).toEqual({ kind: "email", value: email });
			const storage = await discoverAuthStorage(agentDir);
			try {
				expect(storage.resolveOAuthPinTarget("anthropic", preference!.selector).credentialId).toBe(rowId);
			} finally {
				storage.close();
			}
		},
		CLI_TIMEOUT_MS,
	);

	it(
		"stores a 100 percent cap as an uncapped account",
		async () => {
			await preferJson(["cheap@example.com=100"]);

			expect(await writtenPreferences()).toEqual({ anthropic: ["cheap@example.com"] });
		},
		CLI_TIMEOUT_MS,
	);

	it(
		"stores organization ids even when selected by display name, read back as those rows",
		async () => {
			const result = await preferJson(["org:org-b Team", `id:${ids[2]}=90`]);

			const entries = ["org:org-b", { "org:org-a": 90 }];
			expect(result).toEqual({ ok: true, provider: "anthropic", preferences: entries } as never);
			expect(await writtenPreferences()).toEqual({ anthropic: entries });
			const preferences = (await resolveStartupAuthConfig(agentDir)).credentialPreferences.anthropic ?? [];
			expect(preferences).toEqual([
				{ selector: { kind: "org", value: "org-b" } },
				{ selector: { kind: "org", value: "org-a" }, maxUsedFraction: 0.9 },
			]);
			const storage = await discoverAuthStorage(agentDir);
			try {
				expect(storage.findDuplicateCredentialPreferences()).toEqual([]);
				expect(
					preferences.map(({ selector }) => storage.resolveOAuthPinTarget("anthropic", selector).credentialId),
				).toEqual([ids[3], ids[2]]);
			} finally {
				storage.close();
			}
		},
		CLI_TIMEOUT_MS,
	);

	it.each([
		[
			"uses an organization id shared only with a disabled row",
			oauth("other@example.com", "acct-other", "org-b"),
			3,
			"org:org-b",
			{ kind: "org", value: "org-b" },
		],
		[
			"uses an account id instead of an email shared with a disabled row",
			oauth("cheap@example.com", "acct-other", "org-other"),
			0,
			"account:acct-cheap",
			{ kind: "account", value: "acct-cheap" },
		],
	] as const)(
		"%s",
		async (_label, disabledCredential, targetIndex, written, selector) => {
			const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
			try {
				const rows = store.upsertAuthCredentialForProvider("anthropic", disabledCredential);
				const disabledId = rows.find(row => !ids.includes(row.id))!.id;
				store.deleteAuthCredential(disabledId, "disabled in test");
				expect(store.listCredentialInventory("anthropic").find(row => row.id === disabledId)?.disabled).toBe(true);
			} finally {
				store.close();
			}
			const targetId = ids[targetIndex];

			const result = await preferJson([`id:${targetId}`]);

			expect(result).toMatchObject({ ok: true, provider: "anthropic", preferences: [written] });
			expect(await writtenPreferences()).toEqual({ anthropic: [written] });
			const [preference] = (await resolveStartupAuthConfig(agentDir)).credentialPreferences.anthropic ?? [];
			expect(preference?.selector).toEqual(selector);
			const storage = await discoverAuthStorage(agentDir);
			try {
				expect(storage.findDuplicateCredentialPreferences()).toEqual([]);
				expect(storage.resolveOAuthPinTarget("anthropic", preference!.selector).credentialId).toBe(targetId);
			} finally {
				storage.close();
			}
		},
		CLI_TIMEOUT_MS,
	);

	it(
		"refuses a disabled row by id and writes nothing, even after a valid selector",
		async () => {
			const disabledId = ids[1];
			const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
			try {
				store.deleteAuthCredential(disabledId, "disabled in test");
			} finally {
				store.close();
			}

			const result = await preferJson(["cheap@example.com", `id:${disabledId}`]);

			expect(result.ok).toBe(false);
			expect(result.error?.message).toContain(`id:${disabledId}`);
			expect(await writtenPreferences()).toBeUndefined();
		},
		CLI_TIMEOUT_MS,
	);

	it.each([
		["an account that is not stored", ["missing@example.com"], "No active OAuth credential"],
		["a zero cap", ["cheap@example.com=0"], "above 0 and at most 100"],
		["a cap over 100", ["cheap@example.com=101"], "above 0 and at most 100"],
		["a malformed cap", ["cheap@example.com=7o"], "above 0 and at most 100"],
		["the same account twice", ["cheap@example.com", "id:" /* filled below */], "listed more than once"],
		[
			"an account with no unique email, account id, or organization id",
			["id:" /* the organization-less row of the team login, filled below */],
			"no unique email, account id, or organization id",
		],
	])(
		"refuses %s and writes nothing",
		async (_label, selectors, message) => {
			const orgless = selectors.length === 1 && selectors[0] === "id:";
			let orglessId: number | undefined;
			if (orgless) {
				const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
				try {
					store.upsertAuthCredentialForProvider("anthropic", oauth("team@example.com", "acct-team"));
					orglessId = store.listAuthCredentials("anthropic").find(entry => !ids.includes(entry.id))!.id;
				} finally {
					store.close();
				}
			}
			const args = selectors.map(value => (value === "id:" ? `id:${orglessId ?? ids[0]}` : value));
			const result = await preferJson(args);

			expect(result.ok).toBe(false);
			expect(result.error?.message).toContain(message);
			expect(await writtenPreferences()).toBeUndefined();
		},
		CLI_TIMEOUT_MS,
	);

	it(
		"stores and resolves organization ids through an auth broker with a disabled sibling",
		async () => {
			const brokerDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-accounts-prefer-broker-"));
			const brokerStore = await SqliteAuthCredentialStore.open(path.join(brokerDir, "agent.db"));
			const brokerStorage = new AuthStorage(brokerStore);
			let handle: AuthBrokerServerHandle | undefined;
			const savedUrl = process.env.GJC_AUTH_BROKER_URL;
			const savedToken = process.env.GJC_AUTH_BROKER_TOKEN;
			try {
				brokerStore.upsertAuthCredentialForProvider(
					"anthropic",
					oauth("team@example.com", "acct-team", "broker-a"),
				);
				brokerStore.upsertAuthCredentialForProvider(
					"anthropic",
					oauth("team@example.com", "acct-team", "broker-b"),
				);
				brokerStore.upsertAuthCredentialForProvider(
					"anthropic",
					oauth("other@example.com", "acct-other", "broker-b"),
				);
				const brokerRows = brokerStore.listCredentialInventory("anthropic");
				const disabledId = brokerRows.find(row => row.email === "other@example.com")!.id;
				const brokerAId = brokerRows.find(row => row.organizationId === "broker-a")!.id;
				const brokerBId = brokerRows.find(row => row.organizationId === "broker-b" && row.id !== disabledId)!.id;
				brokerStore.deleteAuthCredential(disabledId, "disabled in test");
				await brokerStorage.reload();
				expect(brokerStorage.listCredentialInventory("anthropic").find(row => row.id === disabledId)).toMatchObject(
					{
						disabled: true,
						organizationId: "broker-b",
					},
				);
				handle = startAuthBroker({
					storage: brokerStorage,
					bind: "127.0.0.1:0",
					bearerTokens: ["prefer-token"],
					disableRefresher: true,
				});
				process.env.GJC_AUTH_BROKER_URL = handle.url;
				process.env.GJC_AUTH_BROKER_TOKEN = "prefer-token";

				const result = await preferJson(["org:broker-b", "org:broker-a=90"]);

				// These organizations exist only on the broker, so a CLI that read the local store would refuse them.
				const entries = ["org:broker-b", { "org:broker-a": 90 }];
				expect(result).toEqual({ ok: true, provider: "anthropic", preferences: entries } as never);
				expect(await writtenPreferences()).toEqual({ anthropic: entries });
				const startupAuth = await resolveStartupAuthConfig(agentDir);
				const storage = await discoverAuthStorage(agentDir, startupAuth);
				try {
					const disabledRow = storage.listCredentialInventory("anthropic").find(row => row.id === disabledId);
					expect(disabledRow).toMatchObject({ disabled: true, credentialKind: "oauth" });
					// The broker gives disabled rows metadata only, not the identity fields used for preferences.
					expect(disabledRow?.organizationId).toBeUndefined();
					expect(disabledRow?.email).toBeUndefined();
					expect(disabledRow?.accountId).toBeUndefined();
					expect(storage.findDuplicateCredentialPreferences()).toEqual([]);
					const preferences = startupAuth.credentialPreferences.anthropic ?? [];
					expect(
						preferences.map(({ selector }) => storage.resolveOAuthPinTarget("anthropic", selector).credentialId),
					).toEqual([brokerBId, brokerAId]);
				} finally {
					storage.close();
				}
			} finally {
				if (savedUrl === undefined) delete process.env.GJC_AUTH_BROKER_URL;
				else process.env.GJC_AUTH_BROKER_URL = savedUrl;
				if (savedToken === undefined) delete process.env.GJC_AUTH_BROKER_TOKEN;
				else process.env.GJC_AUTH_BROKER_TOKEN = savedToken;
				await handle?.close();
				brokerStorage.close();
				brokerStore.close();
				await fs.rm(brokerDir, { recursive: true, force: true });
			}
		},
		CLI_TIMEOUT_MS,
	);

	it(
		"clears only the named provider",
		async () => {
			await preferJson(["cheap@example.com"]);
			const result = await preferJson(undefined, true);

			expect(result).toEqual({ ok: true, provider: "anthropic", cleared: true } as never);
			expect(await writtenPreferences()).toEqual({});
		},
		CLI_TIMEOUT_MS,
	);

	it(
		"requires accounts or --clear, not both",
		async () => {
			expect((await preferJson(undefined)).error?.message).toContain("one or more accounts");
			expect((await preferJson(["cheap@example.com"], true)).error?.message).toContain("not both");
		},
		CLI_TIMEOUT_MS,
	);
});
