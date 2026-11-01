import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir, TempDir } from "@gajae-code/utils";
import { closeDb, getRecentRequests, initDb, insertMessageStats } from "../src/db";
import { parseSessionFile } from "../src/parser";

const originalConfigDir = process.env.PI_CONFIG_DIR;
const originalAgentDir = getAgentDir();
let tempDir: TempDir | null = null;

beforeEach(() => {
	tempDir = TempDir.createSync(path.join(os.homedir(), "pi-stats-error-message-"));
	const configDir = path.relative(os.homedir(), tempDir.join("config"));
	process.env.PI_CONFIG_DIR = configDir;
	setAgentDir(path.join(os.homedir(), configDir, "agent"));
});

afterEach(() => {
	closeDb();
	if (originalConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
	else process.env.PI_CONFIG_DIR = originalConfigDir;
	setAgentDir(originalAgentDir);
	tempDir?.removeSync();
	tempDir = null;
});

function assistant(id: string, errorMessage: string | null, stopReason: string): Record<string, unknown> {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-test",
			stopReason,
			timestamp: Date.now(),
			...(errorMessage === null ? {} : { errorMessage }),
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		},
	};
}

async function persist(
	entries: Record<string, unknown>[],
): Promise<{ file: string; stored: Map<string, string | null> }> {
	await initDb();
	const file = tempDir!.join("session.jsonl");
	await fs.writeFile(file, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
	const parsed = await parseSessionFile(file);
	expect(parsed.stats).toHaveLength(entries.length);
	insertMessageStats(parsed.stats);
	const stored = new Map(getRecentRequests(50).map(row => [row.entryId, row.errorMessage]));
	return { file, stored };
}

const API_KEY = "sk-ant-api03-STATS-CANARY-0001";
const BEARER = "8f4c2e1a9b7d6f3e5a0c9b8d7e6f5a4c";
const GITHUB = "ghp_0123456789abcdef";
const GITHUB_PAT = "github_pat_11AAAAAAAAAA0123456789";
const SLACK = "xoxb-1234567890-abcdef";
const NPM = "npm_0123456789abcdefghij";
const GITLAB = "glpat-0123456789abcdefghij";
const STRIPE = "sk_live_0123456789abcdef";
const HUGGING_FACE = "hf_0123456789abcdefghij";
const GOOGLE = `AIza${"A".repeat(35)}`;
const AWS = "AKIAIOSFODNN7EXAMPLE";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.signatureextra";
const PEM = "-----BEGIN PRIVATE KEY-----\nMIIBtestkeymaterialonly\n-----END PRIVATE KEY-----";
const SESSION_COOKIE = "abc123def456";
const URL_USERINFO = "user:s3cret-token";

const CREDENTIAL_ERROR = [
	"provider request failed: 401 Unauthorized",
	`key=${API_KEY}`,
	`Authorization: Bearer ${BEARER}`,
	GITHUB,
	GITHUB_PAT,
	SLACK,
	NPM,
	GITLAB,
	STRIPE,
	HUGGING_FACE,
	GOOGLE,
	AWS,
	JWT,
	PEM,
	`sessionid=${SESSION_COOKIE}`,
	`https://${URL_USERINFO}@example.com/v1`,
].join(" ");

describe("stats error message persistence", () => {
	it("stores a session provider error without credential shapes", async () => {
		await initDb();
		const file = tempDir!.join("session.jsonl");
		await fs.writeFile(file, `${JSON.stringify(assistant("err-1", CREDENTIAL_ERROR, "error"))}\n`);
		const parsed = await parseSessionFile(file);
		expect(parsed.stats[0]?.errorMessage).toContain(API_KEY);
		insertMessageStats(parsed.stats);
		const stored = getRecentRequests(10).find(row => row.entryId === "err-1")?.errorMessage ?? "";
		expect(stored).toContain("401");
		expect(stored).toContain("Unauthorized");
		expect(stored).toContain("example.com");
		for (const secret of [
			API_KEY,
			BEARER,
			GITHUB,
			GITHUB_PAT,
			SLACK,
			NPM,
			GITLAB,
			STRIPE,
			HUGGING_FACE,
			GOOGLE,
			AWS,
			JWT,
			"BEGIN PRIVATE KEY",
			SESSION_COOKIE,
			URL_USERINFO,
		]) {
			expect(stored).not.toContain(secret);
		}
		expect(getRecentRequests(10).find(row => row.entryId === "err-1")?.sessionFile).toBe(file);
	});

	it("keeps a status code, an https url, a filesystem path, and an already masked error", async () => {
		const plain = "503 upstream";
		const url = "HTTP 429 from https://api.example.com/v1/messages";
		const filesystemPath = "config=/home/victim/.gjc/config.yml session=sessions/sess-42.jsonl";
		const unlabeledHex = "opaque_hex=deadbeefcafebabe0123456789abcdefdeadbeefcafebabe0123456789abcdef";
		const alreadyMasked = "provider failed «redacted-api-key» Authorization: «redacted-auth»";
		const { file, stored } = await persist([
			assistant("plain", plain, "error"),
			assistant("url", url, "error"),
			assistant("path", filesystemPath, "error"),
			assistant("hex", unlabeledHex, "error"),
			assistant("masked", alreadyMasked, "error"),
			assistant("ok", null, "stop"),
		]);
		expect(stored.get("plain")).toBe(plain);
		expect(stored.get("url")).toBe(url);
		expect(stored.get("path")).toBe(filesystemPath);
		expect(stored.get("hex")).toBe(unlabeledHex);
		expect(stored.get("masked")).toBe(alreadyMasked);
		expect(stored.get("ok")).toBeNull();
		expect(getRecentRequests(10).find(row => row.entryId === "plain")?.sessionFile).toBe(file);
	});
});
