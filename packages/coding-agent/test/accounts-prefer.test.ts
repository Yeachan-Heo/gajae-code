import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteAuthCredentialStore } from "@gajae-code/ai";
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
		...(organizationId ? { organizationId, organizationName: organizationId } : {}),
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

	it.each([
		["an account that is not stored", ["missing@example.com"], "No active OAuth credential"],
		["a zero cap", ["cheap@example.com=0"], "above 0 and at most 100"],
		["a cap over 100", ["cheap@example.com=101"], "above 0 and at most 100"],
		["a malformed cap", ["cheap@example.com=7o"], "above 0 and at most 100"],
		["the same account twice", ["cheap@example.com", "id:" /* filled below */], "listed more than once"],
		["an account with no unique email or account id", ["org:org-a"], "no unique email or account id"],
	])(
		"refuses %s and writes nothing",
		async (_label, selectors, message) => {
			const args = selectors.map(value => (value === "id:" ? `id:${ids[0]}` : value));
			const result = await preferJson(args);

			expect(result.ok).toBe(false);
			expect(result.error?.message).toContain(message);
			expect(await writtenPreferences()).toBeUndefined();
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
