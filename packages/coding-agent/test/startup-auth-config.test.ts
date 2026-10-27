import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteAuthCredentialStore } from "@gajae-code/ai";
import { getAgentDbPath } from "@gajae-code/utils";
import { Settings } from "../src/config/settings";
import { validateSettingPatch } from "../src/config/settings-schema";
import { discoverAuthStorage } from "../src/sdk/session";
import {
	isValidPersistedCredentialSelector,
	resolveStartupAuthConfig,
	StartupAuthConfigError,
	type StartupAuthConfigErrorKind,
} from "../src/session/startup-auth-config";

const ENV_KEYS = [
	"GJC_AUTH_BROKER_URL",
	"GJC_AUTH_BROKER_TOKEN",
	"GJC_CREDENTIAL_RANKING_MODE",
	"STARTUP_AUTH_BROKER_URL",
	"STARTUP_AUTH_BROKER_TOKEN",
] as const;
const savedEnv = new Map<string, string | undefined>();
const tempDirs: string[] = [];

async function makeAgentDir(config: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-startup-auth-"));
	tempDirs.push(root);
	await fs.writeFile(path.join(root, "config.yml"), config);
	return root;
}

function clearAuthEnv(): void {
	for (const key of ENV_KEYS) {
		savedEnv.set(key, process.env[key]);
		delete process.env[key];
	}
}

function restoreAuthEnv(): void {
	for (const key of ENV_KEYS) {
		const value = savedEnv.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	savedEnv.clear();
}

async function expectStartupAuthConfigError(
	operation: Promise<unknown>,
	kind: StartupAuthConfigErrorKind,
	secret?: string,
): Promise<void> {
	const error = await operation.then(
		() => undefined,
		(value: unknown) => value,
	);
	expect(error).toBeInstanceOf(StartupAuthConfigError);
	if (!(error instanceof StartupAuthConfigError)) return;
	expect(error.kind).toBe(kind);
	expect(error.causeClass).toBe(kind);
	expect(error.message).toContain(kind);
	expect(error.message).toContain("config.yml");
	if (secret !== undefined) expect(error.message).not.toContain(secret);
}

afterEach(async () => {
	restoreAuthEnv();
	for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("startup auth config", () => {
	it("keeps absent and empty config files on the local default authority", async () => {
		clearAuthEnv();
		const absentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-startup-auth-absent-"));
		tempDirs.push(absentDir);
		await expect(resolveStartupAuthConfig(absentDir)).resolves.toEqual({
			broker: null,
			credentialStoreIdentity: `local:${getAgentDbPath(absentDir)}`,
			credentialRankingMode: "balanced",
			credentialPins: {},
			credentialPreferences: {},
		});

		const emptyDir = await makeAgentDir("");
		await expect(resolveStartupAuthConfig(emptyDir)).resolves.toEqual({
			broker: null,
			credentialStoreIdentity: `local:${getAgentDbPath(emptyDir)}`,
			credentialRankingMode: "balanced",
			credentialPins: {},
			credentialPreferences: {},
		});
	});

	it("fails closed with a typed unreadable-config error", async () => {
		clearAuthEnv();
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-startup-auth-unreadable-"));
		tempDirs.push(agentDir);
		await fs.mkdir(path.join(agentDir, "config.yml"));
		await expectStartupAuthConfigError(resolveStartupAuthConfig(agentDir), "unreadable");
	});

	it("fails closed with a typed invalid-YAML error without exposing file contents", async () => {
		clearAuthEnv();
		const secret = "invalid-yaml-secret-token";
		const agentDir = await makeAgentDir(`auth: "${secret}\n`);
		await expectStartupAuthConfigError(resolveStartupAuthConfig(agentDir), "invalid-yaml", secret);
	});

	it("fails closed when the YAML root is not a mapping", async () => {
		clearAuthEnv();
		const secret = "non-mapping-root-secret-token";
		const agentDir = await makeAgentDir(secret);
		await expectStartupAuthConfigError(resolveStartupAuthConfig(agentDir), "non-mapping-root", secret);
	});

	it("fails closed for malformed auth, broker, gateway, and pin sections", async () => {
		clearAuthEnv();
		const malformedAuth = await makeAgentDir('auth: "auth-section-secret"\n');
		await expectStartupAuthConfigError(
			resolveStartupAuthConfig(malformedAuth),
			"invalid-auth",
			"auth-section-secret",
		);

		const malformedBroker = await makeAgentDir("auth:\n  broker:\n    url:\n      - broker-section-secret\n");
		await expectStartupAuthConfigError(
			resolveStartupAuthConfig(malformedBroker),
			"invalid-broker",
			"broker-section-secret",
		);

		const malformedGateway = await makeAgentDir('auth:\n  gateway: "gateway-section-secret"\n');
		await expectStartupAuthConfigError(
			resolveStartupAuthConfig(malformedGateway),
			"invalid-gateway",
			"gateway-section-secret",
		);

		const malformedPins = await makeAgentDir("auth:\n  credentialPins: pin-section-secret\n");
		await expectStartupAuthConfigError(
			resolveStartupAuthConfig(malformedPins),
			"invalid-credential-pins",
			"pin-section-secret",
		);
	});

	it("reads canonical nested YAML and validates persistent pins", async () => {
		clearAuthEnv();
		const agentDir = await makeAgentDir(
			[
				"auth:",
				"  broker:",
				"    url: https://broker.example",
				"    token: nested-token",
				"  credentialPinStoreIdentity: broker:https://broker.example",
				"  credentialRankingMode: earliest-reset",
				"  credentialPins:",
				"    anthropic: email:operator@example.com",
			].join("\n"),
		);

		await expect(resolveStartupAuthConfig(agentDir)).resolves.toEqual({
			broker: { url: "https://broker.example", token: "nested-token" },
			credentialStoreIdentity: "broker:https://broker.example",
			credentialPinStoreIdentity: "broker:https://broker.example",
			credentialRankingMode: "earliest-reset",
			credentialPins: { anthropic: "email:operator@example.com" },
			credentialPreferences: {},
		});
	});

	it("reads ordered credential preferences with per-account usage caps", async () => {
		clearAuthEnv();
		const agentDir = await makeAgentDir(
			[
				"auth:",
				"  credentialPreferences:",
				"    anthropic:",
				"      - cheap@example.com",
				"      - shared@example.com: 75",
				"      - email:prefixed@example.com: 40.5",
				"      - account:acct-9: 100",
				"    openai-codex: account:acct-1",
				"    kimi-code: solo@example.com",
			].join("\n"),
		);

		const resolved = await resolveStartupAuthConfig(agentDir);
		expect(resolved.credentialPreferences).toEqual({
			anthropic: [
				{ selector: { kind: "email", value: "cheap@example.com" } },
				{ selector: { kind: "email", value: "shared@example.com" }, maxUsedFraction: 0.75 },
				{ selector: { kind: "email", value: "prefixed@example.com" }, maxUsedFraction: 0.405 },
				// A 100 percent cap is the same as no cap: only blocking moves past the account.
				{ selector: { kind: "account", value: "acct-9" } },
			],
			"openai-codex": [{ selector: { kind: "account", value: "acct-1" } }],
			"kimi-code": [{ selector: { kind: "email", value: "solo@example.com" } }],
		});
	});

	it.each([
		["a numeric row id", "    anthropic: id:42\n"],
		["a non-mapping section", null],
		["a value that is not an account", "    anthropic: cheap\n"],
		["an empty list", "    anthropic: []\n"],
		["a numeric id inside a list", "    anthropic:\n      - cheap@example.com\n      - id:42\n"],
		["the same account twice", "    anthropic:\n      - cheap@example.com\n      - Cheap@Example.com: 50\n"],
		["two accounts in one entry", "    anthropic:\n      - cheap@example.com: 50\n        other@example.com: 50\n"],
		["a zero cap", "    anthropic:\n      - cheap@example.com: 0\n"],
		["a cap over 100", "    anthropic:\n      - cheap@example.com: 101\n"],
		["a string cap", '    anthropic:\n      - cheap@example.com: "75%"\n'],
		["a nested list", "    anthropic:\n      - - cheap@example.com\n"],
	])("fails closed for credential preferences with %s", async (_label, body) => {
		clearAuthEnv();
		const agentDir = await makeAgentDir(
			body === null
				? "auth:\n  credentialPreferences: preference-section-secret\n"
				: `auth:\n  credentialPreferences:\n${body}`,
		);
		await expectStartupAuthConfigError(
			resolveStartupAuthConfig(agentDir),
			"invalid-credential-preferences",
			"preference-section-secret",
		);
	});

	it.each([
		["fails closed when two entries name one stored account", "acct-cheap", true],
		["opens the store when the entries name different stored accounts", "acct-other", false],
	])("%s through different selectors", async (_label, cheapAccountId, rejected) => {
		clearAuthEnv();
		const agentDir = await makeAgentDir(
			"auth:\n  credentialPreferences:\n    anthropic:\n      - cheap@example.com: 50\n      - account:acct-cheap\n",
		);
		const store = await SqliteAuthCredentialStore.open(getAgentDbPath(agentDir));
		try {
			store.upsertAuthCredentialForProvider("anthropic", {
				type: "oauth",
				access: "access-cheap",
				refresh: "refresh-cheap",
				expires: Date.now() + 3_600_000,
				email: "cheap@example.com",
				accountId: cheapAccountId,
			});
		} finally {
			store.close();
		}

		const discovery = discoverAuthStorage(agentDir);
		if (rejected) {
			await expectStartupAuthConfigError(discovery, "invalid-credential-preferences", "cheap@example.com");
			return;
		}
		const storage = await discovery;
		try {
			expect(storage.findDuplicateCredentialPreferences()).toEqual([]);
		} finally {
			storage.close();
		}
	});

	it("keeps malformed or absent pin-store metadata from authorizing numeric pins", async () => {
		clearAuthEnv();
		const absent = await makeAgentDir("auth:\n  credentialPins:\n    anthropic: id:42\n");
		await expect(resolveStartupAuthConfig(absent)).resolves.not.toHaveProperty("credentialPinStoreIdentity");

		const malformed = await makeAgentDir(
			"auth:\n  credentialPinStoreIdentity:\n    - not-a-store-id\n  credentialPins:\n    anthropic: id:42\n",
		);
		await expect(resolveStartupAuthConfig(malformed)).resolves.not.toHaveProperty("credentialPinStoreIdentity");
	});

	it("rejects literal legacy keys with manual nested rewrite guidance", async () => {
		clearAuthEnv();
		const agentDir = await makeAgentDir('"auth.broker.url": https://legacy.example\n');
		await expect(resolveStartupAuthConfig(agentDir)).rejects.toThrow(/auth:\n {2}broker:\n {4}url: <broker-url>/);
	});

	it("applies env over global config and default ranking precedence", async () => {
		const agentDir = await makeAgentDir(
			[
				"auth:",
				"  broker:",
				"    url: https://config.example",
				"    token: config-token",
				"  credentialRankingMode: balanced",
			].join("\n"),
		);
		clearAuthEnv();
		process.env.GJC_AUTH_BROKER_URL = "https://env.example";
		process.env.GJC_AUTH_BROKER_TOKEN = "env-token";
		process.env.GJC_CREDENTIAL_RANKING_MODE = "earliest-reset";

		await expect(resolveStartupAuthConfig(agentDir)).resolves.toMatchObject({
			broker: { url: "https://env.example", token: "env-token" },
			credentialStoreIdentity: "broker:https://env.example",
			credentialRankingMode: "earliest-reset",
		});
	});

	it("resolves trusted environment indirection in nested broker values", async () => {
		clearAuthEnv();
		process.env.STARTUP_AUTH_BROKER_URL = "https://indirect.example///";
		process.env.STARTUP_AUTH_BROKER_TOKEN = "indirect-token";
		const agentDir = await makeAgentDir(
			["auth:", "  broker:", "    url: $STARTUP_AUTH_BROKER_URL", "    token: $STARTUP_AUTH_BROKER_TOKEN"].join(
				"\n",
			),
		);

		await expect(resolveStartupAuthConfig(agentDir)).resolves.toMatchObject({
			broker: { url: "https://indirect.example", token: "indirect-token" },
			credentialStoreIdentity: "broker:https://indirect.example",
		});
	});

	it("invalidates unresolved nested broker URLs instead of using a placeholder authority", async () => {
		clearAuthEnv();
		const agentDir = await makeAgentDir(
			"auth:\n  broker:\n    url: $MISSING_STARTUP_AUTH_URL\n    token: config-token\n",
		);
		await expectStartupAuthConfigError(resolveStartupAuthConfig(agentDir), "invalid-broker");
	});

	it("ignores project-scoped pins", async () => {
		clearAuthEnv();
		const agentDir = await makeAgentDir("auth:\n  credentialPins:\n    anthropic: id:42\n");
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-startup-auth-project-"));
		tempDirs.push(projectDir);
		await fs.mkdir(path.join(projectDir, ".gjc"), { recursive: true });
		await fs.writeFile(
			path.join(projectDir, ".gjc", "config.yml"),
			"auth:\n  credentialPins:\n    openai-codex: id:99\n",
		);

		await expect(resolveStartupAuthConfig(agentDir)).resolves.toMatchObject({
			credentialPins: { anthropic: "id:42" },
		});
		const settings = await Settings.loadForScope({ cwd: projectDir, agentDir });
		expect(settings.get("auth.credentialPins")).toEqual({ anthropic: "id:42" });
	});

	it("validates selector-record values and rejects unsupported forms", () => {
		expect(isValidPersistedCredentialSelector("id:1")).toBe(true);
		expect(isValidPersistedCredentialSelector("email:operator@example.com")).toBe(true);
		expect(isValidPersistedCredentialSelector("account:acct-1")).toBe(true);
		expect(isValidPersistedCredentialSelector("id:0")).toBe(false);
		expect(isValidPersistedCredentialSelector("id:01")).toBe(false);
		expect(isValidPersistedCredentialSelector("operator@example.com")).toBe(false);
		expect(isValidPersistedCredentialSelector("project:project-1")).toBe(false);
		expect(validateSettingPatch({ "auth.credentialPins": { anthropic: "id:1" } })).toEqual([]);
		expect(validateSettingPatch({ "auth.credentialPins": { anthropic: "project:project-1" } })).toEqual([
			{ path: "auth.credentialPins.anthropic", detail: "Expected credential-selector." },
		]);
		expect(validateSettingPatch({ "auth.credentialPins": { anthropic: "id:0" } })).toEqual([
			{ path: "auth.credentialPins.anthropic", detail: "Expected credential-selector." },
		]);
		expect(validateSettingPatch({ "auth.credentialPins": { anthropic: "operator@example.com" } })).toEqual([
			{ path: "auth.credentialPins.anthropic", detail: "Expected credential-selector." },
		]);
	});

	it("validates preference records with the startup parser grammar", () => {
		for (const value of [
			"email:cheap@example.com",
			"cheap@example.com",
			["cheap@example.com", { "account:acct-1": 75 }],
		]) {
			expect(validateSettingPatch({ "auth.credentialPreferences": { anthropic: value } })).toEqual([]);
		}
		for (const value of [
			"id:27",
			[],
			[{ "cheap@example.com": 0 }],
			[{ "cheap@example.com": 50, "other@example.com": 50 }],
			["cheap@example.com", "cheap@example.com"],
		]) {
			expect(validateSettingPatch({ "auth.credentialPreferences": { anthropic: value } })).toEqual([
				{ path: "auth.credentialPreferences.anthropic", detail: "Expected credential-preference-list." },
			]);
		}
	});

	it("ignores project-scoped credential preferences", async () => {
		clearAuthEnv();
		const agentDir = await makeAgentDir(
			"auth:\n  credentialPreferences:\n    anthropic:\n      - global@example.com: 80\n",
		);
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-startup-auth-project-"));
		tempDirs.push(projectDir);
		await fs.mkdir(path.join(projectDir, ".gjc"), { recursive: true });
		await fs.writeFile(
			path.join(projectDir, ".gjc", "config.yml"),
			"auth:\n  credentialPreferences:\n    anthropic:\n      - project@example.com: 10\n",
		);

		const settings = await Settings.loadForScope({ cwd: projectDir, agentDir });
		expect(settings.get("auth.credentialPreferences")).toEqual({
			anthropic: [{ "global@example.com": 80 }],
		});
	});
});
