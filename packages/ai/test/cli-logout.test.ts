import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDbPath } from "@gajae-code/utils";
import { SqliteAuthCredentialStore } from "../src/auth-storage";

const CLI_PATH = path.join(import.meta.dir, "..", "src", "cli.ts");

describe("pi-ai cli logout", () => {
	let agentDir = "";
	let dbPath = "";

	beforeEach(async () => {
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-ai-cli-logout-"));
		dbPath = getAgentDbPath(agentDir);
		const store = await SqliteAuthCredentialStore.open(dbPath);
		try {
			store.saveApiKey("anthropic", "sk-ant-test");
		} finally {
			store.close();
		}
	});

	afterEach(async () => {
		await fs.rm(agentDir, { recursive: true, force: true });
	});

	async function runLogout(): Promise<{ exitCode: number; stdout: string; stderr: string }> {
		const proc = Bun.spawn({
			cmd: [process.execPath, CLI_PATH, "logout", "anthropic"],
			env: { ...process.env, GJC_CODING_AGENT_DIR: agentDir, ANTHROPIC_API_KEY: "", ANTHROPIC_OAUTH_TOKEN: "" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		return { exitCode, stdout, stderr };
	}

	function activeRows(): number {
		const reader = new Database(dbPath, { readonly: true });
		try {
			const row = reader
				.prepare(
					"SELECT COUNT(*) AS n FROM auth_credentials WHERE provider = 'anthropic' AND disabled_cause IS NULL",
				)
				.get() as { n: number };
			return row.n;
		} finally {
			reader.close();
		}
	}

	test("disables the provider's credentials and reports success", async () => {
		const result = await runLogout();

		expect(result.stdout).toContain("Logged out from anthropic");
		expect(result.exitCode).toBe(0);
		expect(activeRows()).toBe(0);
	});

	test("exits non-zero without a success line when the disable write fails", async () => {
		const admin = new Database(dbPath);
		try {
			admin.run(
				"CREATE TRIGGER fail_disable BEFORE UPDATE OF disabled_cause ON auth_credentials WHEN NEW.disabled_cause IS NOT NULL BEGIN SELECT RAISE(ABORT, 'disable rejected by test trigger'); END",
			);
		} finally {
			admin.close();
		}

		const result = await runLogout();

		expect(result.stdout).not.toContain("Logged out");
		expect(result.stderr).toContain("disable rejected by test trigger");
		expect(result.exitCode).not.toBe(0);
		expect(activeRows()).toBe(1);
	});
});
