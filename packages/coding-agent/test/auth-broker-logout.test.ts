import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteAuthCredentialStore } from "@gajae-code/ai";
import { getAgentDbPath, resetAgentDirFromEnvironment, setAgentDir } from "@gajae-code/utils";
import { runAuthBrokerCommand } from "../src/cli/auth-broker-cli";

const ORIGINAL_STDOUT_WRITE = process.stdout.write.bind(process.stdout);
const ORIGINAL_STDERR_WRITE = process.stderr.write.bind(process.stderr);

function capture(stream: NodeJS.WriteStream): { text: () => string } {
	let captured = "";
	stream.write = ((chunk: string | Uint8Array): boolean => {
		captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		return true;
	}) as typeof stream.write;
	return { text: () => captured };
}

describe("auth-broker logout", () => {
	let agentDir = "";
	let dbPath = "";
	let originalAgentDirEnv: string | undefined;

	beforeEach(async () => {
		originalAgentDirEnv = process.env.GJC_CODING_AGENT_DIR;
		process.exitCode = 0;
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-broker-logout-"));
		setAgentDir(agentDir);
		dbPath = getAgentDbPath();
		const store = await SqliteAuthCredentialStore.open(dbPath);
		try {
			store.saveApiKey("anthropic", "sk-ant-test");
		} finally {
			store.close();
		}
	});

	afterEach(async () => {
		process.stdout.write = ORIGINAL_STDOUT_WRITE;
		process.stderr.write = ORIGINAL_STDERR_WRITE;
		process.exitCode = 0;
		if (originalAgentDirEnv === undefined) delete process.env.GJC_CODING_AGENT_DIR;
		else process.env.GJC_CODING_AGENT_DIR = originalAgentDirEnv;
		resetAgentDirFromEnvironment();
		await fs.rm(agentDir, { recursive: true, force: true });
	});

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
		const stdout = capture(process.stdout);
		await runAuthBrokerCommand({ action: "logout", flags: { provider: "anthropic" } });
		process.stdout.write = ORIGINAL_STDOUT_WRITE;

		expect(stdout.text()).toContain("Logged out of anthropic");
		expect(process.exitCode).toBe(0);
		expect(activeRows()).toBe(0);
	});

	test("reports the failure and exits non-zero when the disable write fails", async () => {
		const admin = new Database(dbPath);
		try {
			admin.run(
				"CREATE TRIGGER fail_disable BEFORE UPDATE OF disabled_cause ON auth_credentials WHEN NEW.disabled_cause IS NOT NULL BEGIN SELECT RAISE(ABORT, 'disable rejected by test trigger'); END",
			);
		} finally {
			admin.close();
		}
		const stdout = capture(process.stdout);
		const stderr = capture(process.stderr);

		await runAuthBrokerCommand({ action: "logout", flags: { provider: "anthropic" } });
		process.stdout.write = ORIGINAL_STDOUT_WRITE;
		process.stderr.write = ORIGINAL_STDERR_WRITE;

		expect(stdout.text()).not.toContain("Logged out");
		expect(stderr.text()).toContain("FAILED");
		expect(stderr.text()).toContain("disable rejected by test trigger");
		expect(process.exitCode).toBe(1);
		expect(activeRows()).toBe(1);
	});

	test("reports a missing provider through the same failure path", async () => {
		const stderr = capture(process.stderr);

		await runAuthBrokerCommand({ action: "logout", flags: {} });
		process.stderr.write = ORIGINAL_STDERR_WRITE;

		expect(stderr.text()).toContain("FAILED");
		expect(stderr.text()).toContain("Usage: gjc auth-broker logout <provider>");
		expect(process.exitCode).toBe(1);
		expect(activeRows()).toBe(1);
	});
});
