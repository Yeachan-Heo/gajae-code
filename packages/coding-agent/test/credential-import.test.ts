import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteAuthCredentialStore } from "@gajae-code/ai";
import { getAgentDbPath, setAgentDir } from "@gajae-code/utils";
import {
	buildCredentialAutoImportNotice,
	CREDENTIAL_AUTO_IMPORT_ROTATION_WARNING,
	CredentialAutoImportFailureClass,
	runExternalCredentialAutoImport,
} from "../src/setup/credential-auto-import";
import {
	type CredentialDiscoveryResult,
	discoverExternalCredentials,
	filterAutoImportOAuthCredentials,
	formatCredentialSummary,
	formatDiscoverySummary,
	importCredentials,
	isAutoImportOAuthCredential,
} from "../src/setup/credential-import";

const CLAUDE_ACCESS = "sk-ant-oat01-claude-access-token-value";
const CLAUDE_REFRESH = "sk-ant-ort01-claude-refresh-token-value";
const CODEX_REFRESH = "codex-refresh-token-value-1234567890";
const CODEX_API_KEY = "sk-codex-api-key-value-0987654321";

function base64url(value: object): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** Build an unsigned JWT whose payload Codex would only ever base64-decode. */
function makeJwt(payload: Record<string, unknown>): string {
	return `${base64url({ alg: "none", typ: "JWT" })}.${base64url(payload)}.synthetic`;
}

const CODEX_EXP_SECONDS = Math.floor(Date.now() / 1000) + 3600;
const CODEX_ACCESS = makeJwt({
	exp: CODEX_EXP_SECONDS,
	"https://api.openai.com/auth": { chatgpt_account_id: "acct-codex-123" },
	"https://api.openai.com/profile": { email: "codex-user@example.com" },
});

describe("discoverExternalCredentials", () => {
	let homeDir = "";

	beforeEach(async () => {
		homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-cred-discovery-"));
	});

	afterEach(async () => {
		await fs.rm(homeDir, { recursive: true, force: true });
	});

	async function writeClaude(body: unknown): Promise<void> {
		const dir = path.join(homeDir, ".claude");
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, ".credentials.json"), typeof body === "string" ? body : JSON.stringify(body));
	}

	async function writeCodex(body: unknown): Promise<void> {
		const dir = path.join(homeDir, ".codex");
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, "auth.json"), typeof body === "string" ? body : JSON.stringify(body));
	}

	function discover(): Promise<CredentialDiscoveryResult> {
		return discoverExternalCredentials({ homeDir, env: {}, platform: "linux" });
	}

	const validClaude = {
		claudeAiOauth: {
			accessToken: CLAUDE_ACCESS,
			refreshToken: CLAUDE_REFRESH,
			expiresAt: Date.now() + 3_600_000,
			scopes: ["user:inference", "user:profile"],
		},
	};

	const validCodexOAuth = {
		OPENAI_API_KEY: null,
		tokens: {
			id_token: makeJwt({ email: "codex-user@example.com" }),
			access_token: CODEX_ACCESS,
			refresh_token: CODEX_REFRESH,
			account_id: "acct-codex-123",
		},
		last_refresh: "2026-01-01T00:00:00Z",
	};

	test("Claude present / Codex absent", async () => {
		await writeClaude(validClaude);
		const result = await discover();
		expect(result.importable).toHaveLength(1);
		const cred = result.importable[0]!;
		expect(cred.provider).toBe("anthropic");
		expect(cred.kind).toBe("oauth");
		expect(cred.origin).toBe("claude-code-file");
		expect(cred.credential.type).toBe("oauth");
		if (cred.credential.type === "oauth") {
			expect(cred.credential.access).toBe(CLAUDE_ACCESS);
			expect(cred.credential.refresh).toBe(CLAUDE_REFRESH);
		}
		expect(result.skipped).toHaveLength(0);
	});

	test("Codex present / Claude absent (OAuth tokens)", async () => {
		await writeCodex(validCodexOAuth);
		const result = await discover();
		expect(result.importable).toHaveLength(1);
		const cred = result.importable[0]!;
		expect(cred.provider).toBe("openai-codex");
		expect(cred.kind).toBe("oauth");
		expect(cred.identity?.accountId).toBe("acct-codex-123");
		expect(cred.identity?.email).toBe("codex-user@example.com");
		expect(cred.expiresAt).toBe(CODEX_EXP_SECONDS * 1000);
		if (cred.credential.type === "oauth") {
			expect(cred.credential.access).toBe(CODEX_ACCESS);
			expect(cred.credential.refresh).toBe(CODEX_REFRESH);
			expect(cred.credential.accountId).toBe("acct-codex-123");
		}
	});

	test("Codex present with only OPENAI_API_KEY (api key)", async () => {
		await writeCodex({ OPENAI_API_KEY: CODEX_API_KEY });
		const result = await discover();
		expect(result.importable).toHaveLength(1);
		const cred = result.importable[0]!;
		expect(cred.provider).toBe("openai-codex");
		expect(cred.kind).toBe("api_key");
		if (cred.credential.type === "api_key") {
			expect(cred.credential.key).toBe(CODEX_API_KEY);
		}
	});

	test("both present", async () => {
		await writeClaude(validClaude);
		await writeCodex(validCodexOAuth);
		const result = await discover();
		expect(result.importable).toHaveLength(2);
		expect(result.importable.map(c => c.provider).sort()).toEqual(["anthropic", "openai-codex"]);
		expect(result.skipped).toHaveLength(0);
	});

	test("no existing config falls back cleanly", async () => {
		const result = await discover();
		expect(result.importable).toHaveLength(0);
		expect(result.skipped).toHaveLength(0);
		expect(result.environment).toHaveLength(0);
	});

	test("malformed Claude JSON is skipped, not thrown", async () => {
		await writeClaude("{ not valid json");
		const result = await discover();
		expect(result.importable).toHaveLength(0);
		expect(result.skipped).toHaveLength(1);
		expect(result.skipped[0]!.origin).toBe("claude-code-file");
		expect(result.skipped[0]!.reason).toContain("malformed credential file");
		expect(result.skipped[0]!.reason).not.toContain("not valid json");
	});

	test("Claude file missing tokens is skipped", async () => {
		await writeClaude({ claudeAiOauth: { expiresAt: 123 } });
		const result = await discover();
		expect(result.importable).toHaveLength(0);
		expect(result.skipped[0]!.reason).toContain("missing accessToken or refreshToken");
	});

	test("Claude unsupported shape (no claudeAiOauth) is skipped", async () => {
		await writeClaude({ somethingElse: true });
		const result = await discover();
		expect(result.importable).toHaveLength(0);
		expect(result.skipped[0]!.reason).toContain("unsupported shape");
	});

	test.each([
		["null", null, "unsupported shape (root is not an object)"],
		["number", 42, "unsupported shape (root is not an object)"],
		["array", ["x"], "unsupported shape (root is not an object)"],
		["string", '"x"', "unsupported shape (root is not an object)"],
	])("Claude %s root is skipped, not thrown", async (_label, body, reason) => {
		await writeClaude(body);
		const result = await discover();
		expect(result.importable).toHaveLength(0);
		expect(result.skipped).toHaveLength(1);
		expect(result.skipped[0]!.origin).toBe("claude-code-file");
		expect(result.skipped[0]!.reason).toBe(reason);
	});

	test("Codex incomplete OAuth tokens are skipped", async () => {
		await writeCodex({ tokens: { access_token: CODEX_ACCESS } });
		const result = await discover();
		expect(result.importable).toHaveLength(0);
		expect(result.skipped[0]!.reason).toContain("incomplete OAuth tokens");
	});

	test("Codex unsupported shape is skipped", async () => {
		await writeCodex({ unrelated: true });
		const result = await discover();
		expect(result.importable).toHaveLength(0);
		expect(result.skipped[0]!.reason).toContain("unsupported shape");
	});

	test.each([
		["null", null, "unsupported shape (root is not an object)"],
		["number", 42, "unsupported shape (root is not an object)"],
		["array", ["x"], "unsupported shape (root is not an object)"],
		["string", '"x"', "unsupported shape (root is not an object)"],
	])("Codex %s root is skipped, not thrown", async (_label, body, reason) => {
		await writeCodex(body);
		const result = await discover();
		expect(result.importable).toHaveLength(0);
		expect(result.skipped).toHaveLength(1);
		expect(result.skipped[0]!.origin).toBe("codex-file");
		expect(result.skipped[0]!.reason).toBe(reason);
	});

	test("macOS keychain is read only when no file exists", async () => {
		const result = await discoverExternalCredentials({
			homeDir,
			env: {},
			platform: "darwin",
			readClaudeKeychain: async () => JSON.stringify(validClaude),
		});
		expect(result.importable).toHaveLength(1);
		expect(result.importable[0]!.origin).toBe("claude-code-keychain");
		expect(result.importable[0]!.source).toContain("Keychain");
	});

	test("file takes priority over keychain on macOS", async () => {
		await writeClaude(validClaude);
		let keychainCalled = false;
		const result = await discoverExternalCredentials({
			homeDir,
			env: {},
			platform: "darwin",
			readClaudeKeychain: async () => {
				keychainCalled = true;
				return JSON.stringify(validClaude);
			},
		});
		expect(keychainCalled).toBe(false);
		expect(result.importable[0]!.origin).toBe("claude-code-file");
	});

	test("environment-backed auth is detected but not imported", async () => {
		const result = await discoverExternalCredentials({
			homeDir,
			platform: "linux",
			env: {
				ANTHROPIC_API_KEY: "sk-ant-env-key-1234567890",
				OPENAI_API_KEY: "sk-openai-env-key-0987654321",
				CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-env-oauth-token",
			},
		});
		expect(result.importable).toHaveLength(0);
		expect(result.environment).toHaveLength(3);
		const variables = result.environment.map(e => e.variable).sort();
		expect(variables).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY"]);
	});

	test("summaries never leak raw secrets", async () => {
		await writeClaude(validClaude);
		await writeCodex(validCodexOAuth);
		const result = await discoverExternalCredentials({
			homeDir,
			platform: "linux",
			env: { ANTHROPIC_API_KEY: "sk-ant-env-key-1234567890" },
		});
		const blob = [...formatDiscoverySummary(result), ...result.importable.map(formatCredentialSummary)].join("\n");
		expect(blob).not.toContain(CLAUDE_ACCESS);
		expect(blob).not.toContain(CLAUDE_REFRESH);
		expect(blob).not.toContain(CODEX_ACCESS);
		expect(blob).not.toContain(CODEX_REFRESH);
		expect(blob).not.toContain("sk-ant-env-key-1234567890");
		// Redacted markers still present for traceability.
		expect(blob).toContain("…");
	});

	// Red-team regression (#654): JSON.parse errors echo the offending input
	// verbatim, so a credential file that fails to parse must NEVER let any
	// token-like substring reach skipped.reason or any user-visible surface.
	// Token bodies are assembled from fragments so the literal never appears
	// verbatim in source (avoids tripping secret scanners / push protection);
	// the runtime values are still realistic token-like strings for the asserts.
	const LEAKY_CLAUDE_TOKEN = ["sk", "live", "abcdef0123456789SECRETBODY"].join("_");
	const LEAKY_AWS_TOKEN = `AKIA${"IOSFODNN7EXAMPLE"}0123456789`;
	const LEAKY_BARE_CLAUDE = "unquotedClaudeTokenValue777SECRET";

	function assertNoLeak(result: CredentialDiscoveryResult, ...secrets: string[]): void {
		const surfaces = [
			JSON.stringify(result),
			formatDiscoverySummary(result).join("\n"),
			result.skipped.map(s => s.reason).join("\n"),
			result.skipped.map(s => s.source).join("\n"),
		];
		for (const secret of secrets) {
			for (const surface of surfaces) {
				expect(surface).not.toContain(secret);
			}
		}
	}

	test("malformed Claude credential file never leaks token-like substrings", async () => {
		await writeClaude(`{"claudeAiOauth":{"accessToken": ${LEAKY_CLAUDE_TOKEN}}}`);
		const result = await discover();
		expect(result.importable).toHaveLength(0);
		expect(result.skipped).toHaveLength(1);
		expect(result.skipped[0]!.reason).toContain("malformed credential file");
		assertNoLeak(result, LEAKY_CLAUDE_TOKEN);
	});

	test("malformed Claude credential file with unquoted token never leaks", async () => {
		await writeClaude(`{"claudeAiOauth":{"refreshToken": ${LEAKY_BARE_CLAUDE}}}`);
		const result = await discover();
		expect(result.importable).toHaveLength(0);
		expect(result.skipped[0]!.reason).toContain("malformed credential file");
		assertNoLeak(result, LEAKY_BARE_CLAUDE);
	});

	test("malformed Codex credential file with AWS-style identifier never leaks", async () => {
		await writeCodex(`{"OPENAI_API_KEY": ${LEAKY_AWS_TOKEN}}`);
		const result = await discover();
		expect(result.importable).toHaveLength(0);
		expect(result.skipped).toHaveLength(1);
		expect(result.skipped[0]!.reason).toContain("malformed credential file");
		assertNoLeak(result, LEAKY_AWS_TOKEN);
	});

	test("malformed reason exposes only a non-sensitive error class", async () => {
		await writeClaude(`{"claudeAiOauth":{"accessToken": ${LEAKY_CLAUDE_TOKEN}}}`);
		const result = await discover();
		expect(result.skipped[0]!.reason).toBe("malformed credential file (SyntaxError)");
	});
});

describe("importCredentials", () => {
	let homeDir = "";
	let agentDir = "";
	let originalAgentDir: string | undefined;

	beforeEach(async () => {
		originalAgentDir = process.env.GJC_AGENT_DIR;
		homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-cred-import-home-"));
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-cred-import-agent-"));
		setAgentDir(agentDir);
	});

	afterEach(async () => {
		if (originalAgentDir === undefined) delete process.env.GJC_AGENT_DIR;
		else process.env.GJC_AGENT_DIR = originalAgentDir;
		await fs.rm(homeDir, { recursive: true, force: true });
		await fs.rm(agentDir, { recursive: true, force: true });
	});

	test("imports discovered credentials into the SQLite store", async () => {
		await fs.mkdir(path.join(homeDir, ".claude"), { recursive: true });
		await fs.writeFile(
			path.join(homeDir, ".claude", ".credentials.json"),
			JSON.stringify({
				claudeAiOauth: {
					accessToken: CLAUDE_ACCESS,
					refreshToken: CLAUDE_REFRESH,
					expiresAt: Date.now() + 3_600_000,
				},
			}),
		);
		const result = await discoverExternalCredentials({ homeDir, env: {}, platform: "linux" });
		const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
		try {
			const summary = await importCredentials(result.importable, (provider, credential) =>
				store.upsertAuthCredentialForProvider(provider, credential),
			);
			expect(summary.imported).toHaveLength(1);
			expect(summary.failed).toHaveLength(0);
			const stored = store.listAuthCredentials("anthropic");
			expect(stored).toHaveLength(1);
			expect(stored[0]!.credential.type).toBe("oauth");
			if (stored[0]!.credential.type === "oauth") {
				expect(stored[0]!.credential.access).toBe(CLAUDE_ACCESS);
			}
		} finally {
			store.close();
		}
	});

	test("records per-credential failures without aborting the batch", async () => {
		const importable = [
			{
				provider: "anthropic" as const,
				origin: "claude-code-file" as const,
				source: "Claude Code (test)",
				kind: "oauth" as const,
				redactedToken: "sk-a…oken",
				credential: { type: "oauth" as const, access: "a", refresh: "r", expires: Date.now() },
			},
			{
				provider: "openai-codex" as const,
				origin: "codex-file" as const,
				source: "Codex CLI (test)",
				kind: "api_key" as const,
				redactedToken: "sk-c…4321",
				credential: { type: "api_key" as const, key: "k" },
			},
		];
		const summary = await importCredentials(importable, (provider, _credential) => {
			if (provider === "openai-codex") throw new Error("boom");
		});
		expect(summary.imported.map(c => c.provider)).toEqual(["anthropic"]);
		expect(summary.failed).toHaveLength(1);
		expect(summary.failed[0]!.credential.provider).toBe("openai-codex");
		expect(summary.failed[0]!.error).toContain("boom");
	});
});
describe("auto-import OAuth filter and orchestrator", () => {
	function oauthCredential(overrides: Partial<Parameters<typeof isAutoImportOAuthCredential>[0]> = {}) {
		return {
			provider: "anthropic" as const,
			origin: "claude-code-file" as const,
			source: "Claude Code (test)",
			kind: "oauth" as const,
			redactedToken: "sk-a…oken",
			credential: { type: "oauth" as const, access: "a", refresh: "r", expires: Date.now() },
			...overrides,
		};
	}

	test("OAuth-only accept/reject matrix", () => {
		const accepted = [
			oauthCredential(),
			oauthCredential({ origin: "claude-code-keychain", source: "Claude Code (macOS Keychain)" }),
			oauthCredential({ provider: "openai-codex", origin: "codex-file", source: "Codex CLI (~/.codex/auth.json)" }),
		];
		const rejected = [
			oauthCredential({
				provider: "openai-codex",
				origin: "codex-file",
				kind: "api_key",
				credential: { type: "api_key", key: "k" },
			}),
			oauthCredential({
				provider: "anthropic",
				origin: "claude-code-file",
				kind: "oauth",
				credential: { type: "api_key", key: "k" },
			}),
			oauthCredential({
				provider: "anthropic",
				origin: "claude-code-keychain",
				kind: "api_key",
				credential: { type: "api_key", key: "k" },
			}),
			oauthCredential({
				provider: "openai-codex",
				origin: "codex-file",
				kind: "oauth",
				credential: { type: "api_key", key: "k" },
			}),
		];
		for (const credential of accepted) expect(isAutoImportOAuthCredential(credential)).toBe(true);
		for (const credential of rejected) expect(isAutoImportOAuthCredential(credential)).toBe(false);
		expect(filterAutoImportOAuthCredentials([...accepted, ...rejected])).toEqual(accepted);
	});

	test("provider-origin pairings reject impossible source/provider combinations", () => {
		const validAnthropicFile = oauthCredential({ provider: "anthropic", origin: "claude-code-file" });
		const validAnthropicKeychain = oauthCredential({ provider: "anthropic", origin: "claude-code-keychain" });
		const validCodexFile = oauthCredential({ provider: "openai-codex", origin: "codex-file" });
		const invalidAnthropicCodexFile = oauthCredential({ provider: "anthropic", origin: "codex-file" });
		const invalidCodexClaudeFile = oauthCredential({ provider: "openai-codex", origin: "claude-code-file" });
		const invalidCodexClaudeKeychain = oauthCredential({ provider: "openai-codex", origin: "claude-code-keychain" });

		expect(isAutoImportOAuthCredential(validAnthropicFile)).toBe(true);
		expect(isAutoImportOAuthCredential(validAnthropicKeychain)).toBe(true);
		expect(isAutoImportOAuthCredential(validCodexFile)).toBe(true);
		expect(isAutoImportOAuthCredential(invalidAnthropicCodexFile)).toBe(false);
		expect(isAutoImportOAuthCredential(invalidCodexClaudeFile)).toBe(false);
		expect(isAutoImportOAuthCredential(invalidCodexClaudeKeychain)).toBe(false);
		expect(
			filterAutoImportOAuthCredentials([
				validAnthropicFile,
				validAnthropicKeychain,
				validCodexFile,
				invalidAnthropicCodexFile,
				invalidCodexClaudeFile,
				invalidCodexClaudeKeychain,
			]),
		).toEqual([validAnthropicFile, validAnthropicKeychain, validCodexFile]);
	});

	test("orchestrator imports through importCredentialIfAbsent", async () => {
		const credential = oauthCredential();
		const calls: string[] = [];
		const result = await runExternalCredentialAutoImport({
			authStorage: {
				importCredentialIfAbsent: async (provider: string, _credential: unknown) => {
					calls.push(provider);
					return { inserted: true, reason: "inserted", provider, entries: [] };
				},
			},
			discover: async () => ({ importable: [credential], skipped: [], environment: [] }),
			trigger: "startup",
		});
		expect(calls).toEqual(["anthropic"]);
		expect(result.imported).toEqual([credential]);
		expect(result.discovered).toBe(true);
	});

	test("notice is emitted only when imported and includes exact rotation warning", () => {
		expect(buildCredentialAutoImportNotice({ imported: [] })).toBeUndefined();
		const notice = buildCredentialAutoImportNotice({ imported: [oauthCredential()] });
		expect(notice).toContain("Imported 1 external OAuth credential(s) into gjc");
		expect(notice).toContain(CREDENTIAL_AUTO_IMPORT_ROTATION_WARNING);
		expect(CREDENTIAL_AUTO_IMPORT_ROTATION_WARNING).toBe(
			"Refreshing in gjc may log out the Claude/Codex CLI because OAuth refresh tokens can rotate.",
		);
	});

	test("global discovery failure does not mark discovered", async () => {
		const result = await runExternalCredentialAutoImport({
			authStorage: {
				importCredentialIfAbsent: async () => ({
					inserted: true,
					reason: "inserted",
					provider: "anthropic",
					entries: [],
				}),
			},
			discover: async () => {
				throw new Error("boom");
			},
			trigger: "startup",
		});
		expect(result.discovered).toBe(false);
		expect(result.imported).toHaveLength(0);
		expect(result.globalDiscoveryFailure?.failureClass).toBe(CredentialAutoImportFailureClass.DiscoveryUnavailable);
	});
});
