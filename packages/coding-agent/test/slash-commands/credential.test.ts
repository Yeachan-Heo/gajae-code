import { afterEach, describe, expect, test } from "bun:test";
import { AuthStorage, type OAuthCredential, SqliteAuthCredentialStore } from "@gajae-code/ai/core";
import { Settings } from "../../src/config/settings";
import type { AgentSession } from "../../src/session/agent-session";
import type { SessionManager } from "../../src/session/session-manager";
import { executeAcpBuiltinSlashCommand } from "../../src/slash-commands/acp-builtins";

const openStores: SqliteAuthCredentialStore[] = [];

function oauth(access: string, email: string): OAuthCredential {
	return {
		type: "oauth",
		access,
		refresh: `refresh-${access}`,
		expires: Date.now() + 60 * 60_000,
		email,
	};
}

async function createRuntime(options?: { provider?: string; model?: { provider: string; id: string } }) {
	const store = await SqliteAuthCredentialStore.open(":memory:");
	openStores.push(store);
	const authStorage = new AuthStorage(store, { rankingStrategyResolver: () => undefined });
	const provider = options?.provider ?? "anthropic";
	await authStorage.set(provider, [
		oauth("token-account-a", "a@example.test"),
		oauth("token-account-b", "b@example.test"),
	]);

	const output: string[] = [];
	const session = {
		sessionId: "session-1",
		credentialSessionId: "session-1",
		model: options?.model,
		modelRegistry: { authStorage },
	};
	const sessionManager = {
		getSessionId: () => "session-1",
	};
	return {
		output,
		authStorage,
		session,
		runtime: {
			session: session as unknown as AgentSession,
			sessionManager: sessionManager as unknown as SessionManager,
			settings: Settings.isolated(),
			cwd: "/tmp/project",
			output: (text: string) => {
				output.push(text);
			},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		},
	};
}

afterEach(() => {
	for (const store of openStores.splice(0)) store.close();
});

describe("/credential slash command", () => {
	test("lists stored accounts with no argument", async () => {
		const { output, runtime } = await createRuntime({ model: { provider: "anthropic", id: "claude-3-5-sonnet" } });

		await expect(executeAcpBuiltinSlashCommand("/credential", runtime)).resolves.toEqual({ consumed: true });

		expect(output).toHaveLength(1);
		expect(output[0]).toContain("Stored accounts");
		expect(output[0]).toContain("a@example.test");
		expect(output[0]).toContain("b@example.test");
	});

	test("switches to a specific row by id, inferring the current model's provider", async () => {
		const { output, runtime, authStorage } = await createRuntime({
			model: { provider: "anthropic", id: "claude-3-5-sonnet" },
		});
		const rows = (await authStorage.exportSnapshot()).credentials;
		const rowB = rows.find(entry => entry.credential.type === "oauth" && entry.credential.email === "b@example.test");
		if (!rowB) throw new Error("test setup failed");

		await expect(executeAcpBuiltinSlashCommand(`/credential id:${rowB.id}`, runtime)).resolves.toEqual({
			consumed: true,
		});

		expect(output).toHaveLength(1);
		expect(output[0]).toContain("Switched this session");
		expect(output[0]).toContain("b@example.test");
		expect(await authStorage.getApiKey("anthropic", "session-1")).toBe("token-account-b");
	});

	test("switches by explicit provider-qualified selector", async () => {
		const { output, runtime, authStorage } = await createRuntime({
			provider: "openai-codex",
			model: undefined,
		});
		const rows = (await authStorage.exportSnapshot()).credentials;
		const rowB = rows.find(entry => entry.credential.type === "oauth" && entry.credential.email === "b@example.test");
		if (!rowB) throw new Error("test setup failed");

		await expect(executeAcpBuiltinSlashCommand(`/credential openai-codex/id:${rowB.id}`, runtime)).resolves.toEqual({
			consumed: true,
		});

		expect(output[0]).toContain("Switched this session");
		expect(await authStorage.getApiKey("openai-codex", "session-1")).toBe("token-account-b");
	});

	test("/account alias switches the same way", async () => {
		const { output, runtime, authStorage } = await createRuntime({
			model: { provider: "anthropic", id: "claude-3-5-sonnet" },
		});
		const rows = (await authStorage.exportSnapshot()).credentials;
		const rowB = rows.find(entry => entry.credential.type === "oauth" && entry.credential.email === "b@example.test");
		if (!rowB) throw new Error("test setup failed");

		await expect(executeAcpBuiltinSlashCommand(`/account id:${rowB.id}`, runtime)).resolves.toEqual({
			consumed: true,
		});
		expect(output[0]).toContain("Switched this session");
	});

	test("reports an error for an unmatched selector instead of throwing", async () => {
		const { output, runtime } = await createRuntime({ model: { provider: "anthropic", id: "claude-3-5-sonnet" } });

		await expect(executeAcpBuiltinSlashCommand("/credential id:999", runtime)).resolves.toEqual({
			consumed: true,
		});

		expect(output[0]).toContain("No stored OAuth credential matches id:999");
	});

	test("refuses to switch while --credential hard-pins the provider", async () => {
		const { output, runtime, authStorage } = await createRuntime({
			model: { provider: "anthropic", id: "claude-3-5-sonnet" },
		});
		const rows = (await authStorage.exportSnapshot()).credentials;
		authStorage.setRuntimeCredentialSelector("anthropic", { kind: "id", value: String(rows[0]!.id) });

		await expect(executeAcpBuiltinSlashCommand(`/credential id:${rows[1]!.id}`, runtime)).resolves.toEqual({
			consumed: true,
		});

		expect(output[0]).toContain("--credential already pins this session");
	});

	test("switches by email to the unique OAuth-pool provider when the current model's provider has no matching row", async () => {
		const { output, runtime, authStorage } = await createRuntime({
			model: { provider: "anthropic", id: "claude-3-5-sonnet" },
		});
		// Anthropic has rows, but none matching the selector; openai-codex is the unique match.
		await authStorage.set("openai-codex", [oauth("token-codex-c", "c@example.test")]);

		await expect(executeAcpBuiltinSlashCommand("/credential email:c@example.test", runtime)).resolves.toEqual({
			consumed: true,
		});

		expect(output[0]).toContain("Switched this session");
		expect(await authStorage.getApiKey("openai-codex", "session-1")).toBe("token-codex-c");
	});

	test("reports an ambiguous unqualified selector across providers", async () => {
		const { runtime, authStorage } = await createRuntime({ model: undefined });
		// Same email registered on a second provider makes an unqualified match ambiguous.
		await authStorage.set("openai-codex", [oauth("token-codex-shared", "a@example.test")]);

		const output: string[] = [];
		const ambiguousRuntime = { ...runtime, output: (text: string) => void output.push(text) };
		await expect(
			executeAcpBuiltinSlashCommand("/credential email:a@example.test", ambiguousRuntime),
		).resolves.toEqual({ consumed: true });
		expect(output[0]).toContain("ambiguous across providers");
	});
});
