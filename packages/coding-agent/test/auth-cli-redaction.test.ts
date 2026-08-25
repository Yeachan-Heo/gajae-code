import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	AuthBrokerClient,
	type AuthBrokerServerHandle,
	AuthStorage,
	SqliteAuthCredentialStore,
	startAuthBroker,
} from "@gajae-code/ai";
import { setAgentDir } from "@gajae-code/utils";
import { runAuthBrokerCommand } from "../src/cli/auth-broker-cli";
import { matchesProviderCredential, runAuthGatewayCommand } from "../src/cli/auth-gateway-cli";

const SECRET = "auth-cli-provider-secret";
const ENV_KEYS = ["GJC_AUTH_BROKER_URL", "GJC_AUTH_BROKER_TOKEN"] as const;

describe("auth gateway credential matching", () => {
	it("accepts the token from a structured OAuth API key", () => {
		expect(
			matchesProviderCredential(
				{
					id: 1,
					provider: "anthropic",
					credential: {
						type: "oauth",
						access: "access-token",
						refresh: "__remote__",
						expires: Date.now() + 60_000,
					},
					identityKey: null,
				},
				'{"token":"access-token","enterpriseUrl":"https://example.test"}',
			),
		).toBe(true);
	});
});

async function captureOutput(run: () => Promise<void>): Promise<{ stdout: string; stderr: string }> {
	const originalStdout = process.stdout.write.bind(process.stdout);
	const originalStderr = process.stderr.write.bind(process.stderr);
	let stdout = "";
	let stderr = "";
	process.stdout.write = ((chunk: string | Uint8Array): boolean => {
		stdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array): boolean => {
		stderr += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		return true;
	}) as typeof process.stderr.write;
	try {
		await run();
	} finally {
		process.stdout.write = originalStdout;
		process.stderr.write = originalStderr;
		process.exitCode = 0;
	}
	return { stdout, stderr };
}

describe("auth CLI diagnostic redaction", () => {
	let agentDir = "";
	const savedEnv = new Map<string, string | undefined>();

	beforeEach(async () => {
		for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-auth-cli-redaction-"));
		setAgentDir(agentDir);
		process.exitCode = 0;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		process.exitCode = 0;
		for (const key of ENV_KEYS) {
			const value = savedEnv.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await fs.rm(agentDir, { recursive: true, force: true });
	});

	it("keeps broker import text and JSON failures bounded and secret-free", async () => {
		const source = path.join(agentDir, "credential.json");
		await Bun.write(
			source,
			JSON.stringify({
				type: "claude",
				access_token: "access-value",
				refresh_token: "refresh-value",
				expired: "2099-12-31T23:59:59Z",
				email: "secret-free@example.com",
			}),
		);
		process.env.GJC_AUTH_BROKER_URL = "https://broker.example";
		process.env.GJC_AUTH_BROKER_TOKEN = "operator-token";
		vi.spyOn(AuthBrokerClient.prototype, "uploadCredential").mockRejectedValue(
			new Error(`provider rejected request: Bearer ${SECRET}`),
		);

		const jsonOutput = await captureOutput(() =>
			runAuthBrokerCommand({ action: "import", flags: { source, json: true } }),
		);
		expect(jsonOutput.stdout).not.toContain(SECRET);
		expect(JSON.parse(jsonOutput.stdout.trim().split("\n").at(-1) ?? "{}")).toEqual({
			ok: false,
			error: { code: "credential_import_failed", message: "Credential import failed." },
			file: source,
		});

		process.exitCode = 0;
		const textOutput = await captureOutput(() =>
			runAuthBrokerCommand({ action: "import", flags: { source, json: false } }),
		);
		expect(textOutput.stdout).not.toContain(SECRET);
		expect(textOutput.stdout).toContain("Bearer [redacted]");
	});

	it("uses a stable broker status error in JSON while redacting text diagnostics", async () => {
		process.env.GJC_AUTH_BROKER_URL = "https://broker.example";
		process.env.GJC_AUTH_BROKER_TOKEN = "operator-token";
		vi.spyOn(AuthBrokerClient.prototype, "healthz").mockRejectedValue(
			new Error(`provider status failed api_key=${SECRET}`),
		);

		const jsonOutput = await captureOutput(() => runAuthBrokerCommand({ action: "status", flags: { json: true } }));
		expect(jsonOutput.stdout).not.toContain(SECRET);
		expect(JSON.parse(jsonOutput.stdout.trim())).toEqual({
			ok: false,
			url: "https://broker.example",
			error: { code: "broker_unavailable", message: "Auth broker is unavailable." },
		});

		process.exitCode = 0;
		const textOutput = await captureOutput(() => runAuthBrokerCommand({ action: "status", flags: { json: false } }));
		expect(textOutput.stdout).not.toContain(SECRET);
		expect(textOutput.stdout).toContain("Credential diagnostic unavailable.");
	});

	it("redacts provider check reasons in gateway text and JSON output", async () => {
		const brokerDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-auth-cli-redaction-broker-"));
		let brokerStore: SqliteAuthCredentialStore | undefined;
		let brokerStorage: AuthStorage | undefined;
		let handle: AuthBrokerServerHandle | undefined;
		try {
			brokerStore = await SqliteAuthCredentialStore.open(path.join(brokerDir, "agent.db"));
			brokerStorage = new AuthStorage(brokerStore);
			await brokerStorage.reload();
			handle = startAuthBroker({
				storage: brokerStorage,
				bind: "127.0.0.1:0",
				bearerTokens: ["operator-token"],
				disableRefresher: true,
			});
			process.env.GJC_AUTH_BROKER_URL = handle.url;
			process.env.GJC_AUTH_BROKER_TOKEN = "operator-token";
			vi.spyOn(AuthStorage.prototype, "checkCredentials").mockResolvedValue([
				{
					id: 7,
					provider: "anthropic",
					type: "oauth",
					ok: false,
					reason: `provider rejected request: api_key=${SECRET}`,
				},
			]);

			const jsonOutput = await captureOutput(() =>
				runAuthGatewayCommand({ action: "check", flags: { json: true } }),
			);
			expect(jsonOutput.stdout).not.toContain(SECRET);
			expect(jsonOutput.stdout).toContain("Credential check failed.");

			process.exitCode = 0;
			const textOutput = await captureOutput(() =>
				runAuthGatewayCommand({ action: "check", flags: { json: false } }),
			);
			expect(textOutput.stdout).not.toContain(SECRET);
			expect(textOutput.stdout).toContain("Credential check failed.");
		} finally {
			await handle?.close();
			brokerStorage?.close();
			brokerStore?.close();
			await fs.rm(brokerDir, { recursive: true, force: true });
		}
	});

	it("uses a stable generic message when credential checking fails at command level", async () => {
		process.env.GJC_AUTH_BROKER_URL = "https://broker.example";
		process.env.GJC_AUTH_BROKER_TOKEN = "operator-token";
		vi.spyOn(AuthBrokerClient.prototype, "fetchSnapshot").mockResolvedValue({
			status: 200,
			generation: 1,
			snapshot: {
				generation: 1,
				generatedAt: 1,
				serverNowMs: 1,
				refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: Number.MAX_SAFE_INTEGER },
				credentials: [],
			},
		});
		vi.spyOn(AuthStorage.prototype, "checkCredentials").mockRejectedValue(
			new Error(`provider account=${SECRET} email=user@example.com`),
		);
		const output = await captureOutput(() => runAuthGatewayCommand({ action: "check", flags: { json: false } }));
		expect(output.stderr).not.toContain(SECRET);
		expect(output.stderr).not.toContain("user@example.com");
		expect(output.stderr).toContain("Credential check failed.");
	});
});
