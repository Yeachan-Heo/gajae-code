import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteAuthCredentialStore } from "@gajae-code/ai";
import { getAgentDbPath, resetAgentDirFromEnvironment, setAgentDir } from "@gajae-code/utils";
import { runAccountsCommand } from "../src/cli/accounts-cli";

function organizationCredential(suffix: string, organizationId: string, organizationName: string) {
	return {
		type: "oauth" as const,
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 3_600_000,
		accountId: "shared-account",
		email: "shared@example.com",
		organizationId,
		organizationName,
	};
}

type AccountsJson = { ok: boolean; removedIds?: number[]; selector?: string; error?: { message: string } };

async function accountsJson(args: Parameters<typeof runAccountsCommand>[0]): Promise<AccountsJson> {
	const chunks: string[] = [];
	const original = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((chunk: Uint8Array | string): boolean => {
		chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
		return true;
	}) as typeof process.stdout.write;
	const priorExitCode = process.exitCode;
	try {
		await runAccountsCommand(args);
	} finally {
		process.stdout.write = original as typeof process.stdout.write;
		process.exitCode = priorExitCode ?? 0;
	}
	return JSON.parse(chunks.join(""));
}

function logoutJson(account: string): Promise<AccountsJson> {
	return accountsJson({ action: "logout", provider: "anthropic", flags: { account, json: true } });
}

describe("gjc accounts with org:<organization> selectors", () => {
	let agentDir = "";
	let originalAgentDir: string | undefined;
	let ids: number[] = [];

	beforeEach(async () => {
		originalAgentDir = process.env.GJC_CODING_AGENT_DIR;
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-accounts-logout-org-"));
		setAgentDir(agentDir);
		const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
		try {
			// Two organizations share a display name; a third has a name equal to the first one's id.
			for (const credential of [
				organizationCredential("first", "org-first", "Acme"),
				organizationCredential("second", "org-second", "Acme"),
				organizationCredential("impostor", "org-impostor", "org-first"),
			]) {
				store.upsertAuthCredentialForProvider("anthropic", credential);
			}
			ids = store.listAuthCredentials("anthropic").map(entry => entry.id);
			expect(ids).toHaveLength(3);
		} finally {
			store.close();
		}
	});

	afterEach(async () => {
		if (originalAgentDir === undefined) delete process.env.GJC_CODING_AGENT_DIR;
		else process.env.GJC_CODING_AGENT_DIR = originalAgentDir;
		resetAgentDirFromEnvironment();
		await fs.rm(agentDir, { recursive: true, force: true });
	});

	async function remainingIds(): Promise<number[]> {
		const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
		try {
			return store.listAuthCredentials("anthropic").map(entry => entry.id);
		} finally {
			store.close();
		}
	}

	it("refuses a display name shared by two organizations and removes nothing", async () => {
		const result = await logoutJson("org:Acme");

		expect(result.ok).toBe(false);
		expect(result.error?.message).toContain("was missing or ambiguous");
		expect(await remainingIds()).toEqual(ids);
	});

	it("removes only the organization whose id matches exactly, not one named after that id", async () => {
		const result = await logoutJson("org:org-first");

		expect(result).toEqual({ ok: true, provider: "anthropic", removedIds: [ids[0]!] } as never);
		expect(await remainingIds()).toEqual([ids[1]!, ids[2]!]);
	});

	it("refuses to pin a shared display name and names the candidate rows", async () => {
		const result = await accountsJson({
			action: "pin",
			provider: "anthropic",
			selectors: ["org:Acme"],
			flags: { persistent: true, json: true },
		});

		expect(result.ok).toBe(false);
		expect(result.error?.message).toContain(`ids: ${ids[0]}, ${ids[1]}`);
	});
});
