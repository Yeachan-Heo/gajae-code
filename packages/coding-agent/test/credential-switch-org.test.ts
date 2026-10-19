import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, type OAuthCredential, SqliteAuthCredentialStore } from "@gajae-code/ai/core";
import {
	buildCredentialListText,
	switchSessionCredentialCommand,
} from "../src/slash-commands/helpers/credential-switch";
import type { SlashCommandRuntime } from "../src/slash-commands/types";

function organizationCredential(suffix: string, organizationId: string, organizationName: string): OAuthCredential {
	return {
		type: "oauth",
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 3_600_000,
		accountId: "account-uuid",
		email: "user@example.com",
		organizationId,
		organizationName,
	};
}

describe("/credential with Anthropic organizations", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore;
	let authStorage: AuthStorage;
	let runtime: SlashCommandRuntime;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-credential-switch-org-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
		authStorage.upsertCredential("anthropic", organizationCredential("team", "org-team", "Acme Team"));
		authStorage.upsertCredential("anthropic", organizationCredential("personal", "org-personal", "Personal Max"));
		runtime = {
			session: {
				model: { provider: "anthropic" },
				credentialSessionId: "session-1",
				modelRegistry: { authStorage },
			},
		} as unknown as SlashCommandRuntime;
	});

	afterEach(async () => {
		store.close();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("lists each organization of the shared account separately", async () => {
		const text = await buildCredentialListText(runtime);
		const [teamRow, personalRow] = store.listAuthCredentials("anthropic");
		expect(text).toContain(`id:${teamRow?.id} — user@example.com (Acme Team)`);
		expect(text).toContain(`id:${personalRow?.id} — user@example.com (Personal Max)`);
	});

	it("switches the session by organization name", async () => {
		const personalRow = store.listAuthCredentials("anthropic")[1];
		const message = await switchSessionCredentialCommand(runtime, "org:Personal Max");
		expect(message).toBe(
			`Switched this session to id:${personalRow?.id} — user@example.com (Personal Max). Takes effect on the next request to Anthropic.`,
		);
		expect(authStorage.getSessionCredentialRowId("anthropic", "session-1")).toBe(personalRow?.id);
	});
});
