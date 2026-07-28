import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import * as nodeCrypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDbPath, getAgentDir, setAgentDir } from "@gajae-code/utils";
import { SqliteAuthCredentialStore } from "../src/auth-storage";
import { KIRO_STATIC_SEED, kiroModelManagerOptions } from "../src/provider-models/kiro";
import { buildKiroRequest, resetKiroProfileArnCache } from "../src/providers/kiro";
import type { AssistantMessage, Model } from "../src/types";
import { normalizeToolCallId } from "../src/utils";
import { fetchKiroModels } from "../src/utils/discovery/kiro";

const PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:123456789012:profile/PROPLUS";
const LIST_PROFILES = "AmazonCodeWhispererService.ListAvailableProfiles";
const LIST_MODELS = "AmazonCodeWhispererService.ListAvailableModels";

const model: Model<"kiro-streaming"> = {
	id: "claude-haiku-4.5",
	name: "claude-haiku-4.5",
	api: "kiro-streaming",
	provider: "kiro",
	baseUrl: "https://runtime.us-east-1.kiro.dev/",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 64_000,
};

function sha256Hex(value: string): string {
	return nodeCrypto.createHash("sha256").update(value).digest("hex");
}

/** Build a same-model assistant turn carrying one tool call with `id`. */
function assistantWithToolCall(id: string): AssistantMessage {
	return {
		role: "assistant",
		api: "kiro-streaming",
		provider: "kiro",
		model: model.id,
		content: [{ type: "toolCall", id, name: "echo_value", arguments: { value: "x" } }],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 2,
	};
}

/**
 * Drive a full same-model tool round trip and return the ids emitted by both
 * conversion callsites (`convertAssistant` and `convertToolResult`).
 */
function roundTripToolId(id: string): { assistantId: string | undefined; resultId: string | undefined } {
	const request = buildKiroRequest(
		model,
		{
			messages: [
				{ role: "user", content: "Use the tool", timestamp: 1 },
				assistantWithToolCall(id),
				{
					role: "toolResult",
					toolCallId: id,
					toolName: "echo_value",
					content: [{ type: "text", text: "done" }],
					isError: false,
					timestamp: 3,
				},
			],
		},
		PROFILE_ARN,
	);
	const history = request.conversationState.history[1];
	const assistantId =
		history && "assistantResponseMessage" in history
			? history.assistantResponseMessage.toolUses?.[0]?.toolUseId
			: undefined;
	const resultId =
		request.conversationState.currentMessage.userInputMessage.userInputMessageContext.toolResults?.[0]?.toolUseId;
	return { assistantId, resultId };
}

describe("TB Defect 10 - tool-id conditional passthrough", () => {
	test("TB-01: empty-string id fails the 1-char lower bound and is hashed", () => {
		const { assistantId } = roundTripToolId("");
		// The predicate requires 1..64 chars, so "" must not pass through.
		expect(assistantId).toBe(sha256Hex(""));
		expect(assistantId).toMatch(/^[a-f0-9]{64}$/);
	});

	test("TB-02: exactly-64-char conforming id passes through verbatim", () => {
		const id = "a".repeat(64);
		const { assistantId, resultId } = roundTripToolId(id);
		expect(assistantId).toBe(id);
		expect(resultId).toBe(id);
	});

	test("TB-03: exactly-65-char conforming id exceeds the bound and is hashed", () => {
		const id = "a".repeat(65);
		const { assistantId } = roundTripToolId(id);
		expect(assistantId).toBe(sha256Hex(id));
		expect(assistantId).not.toBe(id);
	});

	test("TB-04: characters outside the allowed class force hashing", () => {
		for (const raw of ["id.dot", "id|pipe", "id:colon", "id/slash", "id+plus", "id=eq", "id space", "idé"]) {
			const { assistantId } = roundTripToolId(raw);
			expect(assistantId).toBe(sha256Hex(raw));
		}
	});

	test("TB-05: a 64-char hex digest conforms, so hashing is idempotent", () => {
		const foreign = "call_abc|fc_def";
		const first = roundTripToolId(foreign).assistantId ?? "";
		expect(first).toBe(sha256Hex(foreign));
		// Feeding the digest back in must return it unchanged rather than
		// double-hashing, otherwise replayed history would drift every turn.
		expect(roundTripToolId(first).assistantId).toBe(first);
	});

	test("TB-06: two different non-conforming ids do not collide", () => {
		const a = roundTripToolId("call_one|fc_one").assistantId;
		const b = roundTripToolId("call_two|fc_two").assistantId;
		expect(a).not.toBe(b);
	});

	test("TB-07: both conversion callsites agree on the same non-conforming id", () => {
		const foreign = "call_QKsJSt3a0VVwVELmiM3GxIWK|fc_018d34fca8cceb25016a662d98ed6081918f20fcf4dfda78c9";
		const { assistantId, resultId } = roundTripToolId(foreign);
		expect(assistantId).toBe(sha256Hex(foreign));
		// convertAssistant and convertToolResult must produce identical ids or the
		// server sees a tool result referencing an id it never received.
		expect(resultId).toBe(assistantId);
	});

	test("TB-08: the shared normalizeToolCallId util remains a sanitizer, not a hasher", () => {
		expect(normalizeToolCallId("call_abc|fc_def")).toBe("call_abc_fc_def");
		expect(normalizeToolCallId("a".repeat(80))).toHaveLength(64);
		expect(normalizeToolCallId("plain-id_1")).toBe("plain-id_1");
		expect(normalizeToolCallId("call_abc|fc_def")).not.toBe(sha256Hex("call_abc|fc_def"));
	});
});

interface CapturedRequest {
	target: string;
	url: string;
	body: string;
}

function recordingFetcher(captured: CapturedRequest[]): typeof fetch {
	return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
		const target = String(request.headers.get("x-amz-target"));
		captured.push({ target, url: request.url, body: await request.text() });
		if (target === LIST_PROFILES) {
			return Response.json({ profiles: [{ arn: PROFILE_ARN }] });
		}
		return Response.json({
			models: [{ modelId: "claude-haiku-4.5", modelName: "Claude Haiku 4.5" }],
		});
	}) as typeof fetch;
}

function profileLookups(captured: CapturedRequest[]): CapturedRequest[] {
	// Filter on x-amz-target: KIRO_MANAGEMENT_URL also serves ListAvailableModels
	// and GetUsageLimits, so counting URL hits would false-positive.
	return captured.filter(entry => entry.target === LIST_PROFILES);
}

describe("TB Defect 6/7 - ARN trust invariant", () => {
	test("TB-09: an explicit profileArn suppresses ListAvailableProfiles entirely", async () => {
		resetKiroProfileArnCache();
		const captured: CapturedRequest[] = [];
		const models = await fetchKiroModels({
			accessToken: "token-explicit",
			profileArn: PROFILE_ARN,
			fetcher: recordingFetcher(captured),
		});

		expect(models).not.toBeNull();
		expect(profileLookups(captured)).toEqual([]);
		const listModels = captured.find(entry => entry.target === LIST_MODELS);
		expect(JSON.parse(listModels?.body ?? "{}")).toMatchObject({ profileArn: PROFILE_ARN });
		expect(listModels?.url).toContain(encodeURIComponent(PROFILE_ARN));
	});

	test("TB-10: an absent profileArn resolves exactly once", async () => {
		resetKiroProfileArnCache();
		const captured: CapturedRequest[] = [];
		const models = await fetchKiroModels({ accessToken: "token-absent", fetcher: recordingFetcher(captured) });

		expect(models).not.toBeNull();
		expect(profileLookups(captured)).toHaveLength(1);
		expect(JSON.parse(captured.find(e => e.target === LIST_MODELS)?.body ?? "{}")).toMatchObject({
			profileArn: PROFILE_ARN,
		});
	});

	test("TB-11: a structured apiKey carrying an ARN reaches discovery without a lookup", async () => {
		resetKiroProfileArnCache();
		const captured: CapturedRequest[] = [];
		const options = kiroModelManagerOptions({
			apiKey: JSON.stringify({ token: "social-token", kiroMethod: "google", kiroProfileArn: PROFILE_ARN }),
		});

		expect(options.fetchDynamicModels).toBeDefined();
		// Exercise the real plumbing from provider-models, not fetchKiroModels alone.
		const fetcher = recordingFetcher(captured);
		const originalFetch = globalThis.fetch;
		globalThis.fetch = fetcher;
		try {
			await options.fetchDynamicModels?.();
		} finally {
			globalThis.fetch = originalFetch;
		}
		expect(profileLookups(captured)).toEqual([]);
	});

	test("TB-12: a bare-token apiKey has no ARN and must resolve once", async () => {
		resetKiroProfileArnCache();
		const captured: CapturedRequest[] = [];
		const options = kiroModelManagerOptions({ apiKey: "bare-builder-id-token" });

		const fetcher = recordingFetcher(captured);
		const originalFetch = globalThis.fetch;
		globalThis.fetch = fetcher;
		try {
			await options.fetchDynamicModels?.();
		} finally {
			globalThis.fetch = originalFetch;
		}
		expect(profileLookups(captured)).toHaveLength(1);
	});

	test("TB-13: an empty-string profileArn is never forwarded as an ARN", async () => {
		resetKiroProfileArnCache();
		const captured: CapturedRequest[] = [];
		const models = await fetchKiroModels({
			accessToken: "token-empty-arn",
			profileArn: "",
			fetcher: recordingFetcher(captured),
		});

		expect(models).not.toBeNull();
		const listModels = captured.find(entry => entry.target === LIST_MODELS);
		const body = JSON.parse(listModels?.body ?? "{}") as { profileArn?: string };
		// Either resolution filled it in, or it was resolved before use; what must
		// never happen is an empty ARN reaching the control plane.
		expect(body.profileArn).toBeTruthy();
		expect(body.profileArn).not.toBe("");
	});

	test("TB-14: no ARN slot means exactly one lookup, then memoized across calls", async () => {
		resetKiroProfileArnCache();
		const captured: CapturedRequest[] = [];
		const fetcher = recordingFetcher(captured);
		await fetchKiroModels({ accessToken: "token-memo", fetcher });
		await fetchKiroModels({ accessToken: "token-memo", fetcher });
		expect(profileLookups(captured)).toHaveLength(1);
	});
});

let previousAgentDir: string | undefined;
let previousPiConfigDir: string | undefined;
let previousGjcConfigDir: string | undefined;
let tempConfigRoot: string | undefined;

async function useTempAgentDir(): Promise<void> {
	previousAgentDir = getAgentDir();
	previousPiConfigDir = process.env.PI_CONFIG_DIR;
	previousGjcConfigDir = process.env.GJC_CONFIG_DIR;
	tempConfigRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-kiro-tierb-"));
	process.env.PI_CONFIG_DIR = path.relative(os.homedir(), tempConfigRoot);
	delete process.env.GJC_CONFIG_DIR;
	setAgentDir(path.join(tempConfigRoot, "agent"));
	await fs.mkdir(path.dirname(getAgentDbPath()), { recursive: true });
}

afterEach(async () => {
	if (previousPiConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
	else process.env.PI_CONFIG_DIR = previousPiConfigDir;
	previousPiConfigDir = undefined;

	if (previousGjcConfigDir === undefined) delete process.env.GJC_CONFIG_DIR;
	else process.env.GJC_CONFIG_DIR = previousGjcConfigDir;
	previousGjcConfigDir = undefined;

	if (previousAgentDir) {
		setAgentDir(previousAgentDir);
		previousAgentDir = undefined;
	}
	if (tempConfigRoot) {
		await fs.rm(tempConfigRoot, { recursive: true, force: true });
		tempConfigRoot = undefined;
	}
});

describe("TB Defect 9 - kiro_kv schema ownership", () => {
	test("TB-17: an existing DB without kiro_kv gains the table and keeps its rows", async () => {
		await useTempAgentDir();

		// First open creates the full schema, then drop kiro_kv to simulate a DB
		// written before this change.
		const first = await SqliteAuthCredentialStore.open(getAgentDbPath());
		await first.close?.();
		const seed = new Database(getAgentDbPath());
		try {
			seed.run("DROP TABLE IF EXISTS kiro_kv");
			seed
				.prepare("INSERT INTO auth_credentials (provider, credential_type, data) VALUES (?, ?, ?)")
				.run("kiro", "oauth", JSON.stringify({ access: "a", refresh: "r", expires: 1 }));
		} finally {
			seed.close();
		}

		const second = await SqliteAuthCredentialStore.open(getAgentDbPath());
		try {
			const db = new Database(getAgentDbPath(), { readonly: true });
			try {
				const table = db
					.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'kiro_kv'")
					.get() as { present?: number } | undefined;
				expect(table?.present).toBe(1);

				const version = db.prepare("SELECT version FROM auth_schema_version WHERE id = 1").get() as
					| { version?: number }
					| undefined;
				expect(version?.version).toBe(4);

				const rows = db.prepare("SELECT COUNT(*) AS n FROM auth_credentials WHERE provider = ?").get("kiro") as
					| { n?: number }
					| undefined;
				expect(rows?.n).toBe(1);
			} finally {
				db.close();
			}
		} finally {
			await second.close?.();
		}
	});
});

describe("TB Defect 11 - seed metadata claims", () => {
	test("TB-22: seed metadata is complete and matches discovery fallbacks", () => {
		const fields: Omit<Model<"kiro-streaming">, "id" | "name"> = {
			api: "kiro-streaming",
			provider: "kiro",
			baseUrl: "https://runtime.us-east-1.kiro.dev/",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 64_000,
		};
		expect(KIRO_STATIC_SEED).toEqual(
			["claude-opus-5", "claude-sonnet-5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"].map(id => ({
				id,
				name: id,
				...fields,
			})),
		);
	});

	test("TB-23: discovery falls back to the same 200k window when tokenLimits is absent", async () => {
		resetKiroProfileArnCache();
		const fetcher = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
			if (request.headers.get("x-amz-target") === LIST_PROFILES) {
				return Response.json({ profiles: [{ arn: PROFILE_ARN }] });
			}
			// No tokenLimits at all: the fallback must match the seed.
			return Response.json({ models: [{ modelId: "kiro-unknown", modelName: "Unknown" }] });
		}) as typeof fetch;

		const models = await fetchKiroModels({ accessToken: "token-fallback", fetcher });
		expect(models?.[0]?.contextWindow).toBe(200_000);
		expect(models?.[0]?.input).toEqual(["text"]);
	});
});
