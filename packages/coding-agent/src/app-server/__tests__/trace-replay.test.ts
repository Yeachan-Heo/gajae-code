import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConnectionState } from "../router/connection-state";
import { processInbound } from "../server";
import { HandlerRegistry, registerBuiltinHandlers } from "../suites/handlers";
import { ThreadRuntimeManager } from "../thread-runtime/thread-runtime-manager";
import { assertTranscript, goldenBytes, type TranscriptHeader } from "./e2e/oracle-contract";
import traceFixture from "./fixtures/t3code-startup-trace.json" with { type: "json" };

const TEST_ROOT = mkdtempSync(path.join(os.tmpdir(), "gjc-trace-replay-"));
const TEST_CWD = path.join(TEST_ROOT, "cwd");
const TEST_AGENT_DIR = path.join(TEST_ROOT, "agent");
const DISABLED_MODEL_PROVIDERS = [
	"alibaba-token-plan",
	"amazon-bedrock",
	"anthropic",
	"azure-openai",
	"bizrouter",
	"cerebras",
	"cloudflare-ai-gateway",
	"cursor",
	"deepinfra",
	"deepseek",
	"firepass",
	"fireworks",
	"fugu",
	"github-copilot",
	"gitlab-duo",
	"glm-zcode",
	"google",
	"google-antigravity",
	"google-gemini-cli",
	"google-vertex",
	"groq",
	"huggingface",
	"kilo",
	"kimi-code",
	"litellm",
	"mara",
	"minimax",
	"minimax-cn",
	"minimax-code",
	"minimax-code-cn",
	"mistral",
	"moonshot",
	"nanogpt",
	"nvidia",
	"ollama-cloud",
	"openai",
	"openai-codex",
	"opencode",
	"opencode-go",
	"opencode-zen",
	"opengateway",
	"openrouter",
	"qianfan",
	"qwen-portal",
	"synthetic",
	"together",
	"venice",
	"vercel-ai-gateway",
	"xai",
	"xiaomi",
	"xiaomi-token-plan-ams",
	"xiaomi-token-plan-cn",
	"xiaomi-token-plan-sgp",
	"zai",
	"zenmux",
] as const;
const GOLDEN_PATH = path.join(import.meta.dir, "e2e/golden/trace-replay.golden.json");
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const previousEnvironment = {
	GJC_AGENT_DIR: process.env.GJC_AGENT_DIR,
	GJC_CODING_AGENT_DIR: process.env.GJC_CODING_AGENT_DIR,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
	HOME: process.env.HOME,
};

beforeAll(() => {
	mkdirSync(TEST_CWD, { recursive: true });
	mkdirSync(TEST_AGENT_DIR, { recursive: true });
	writeFileSync(
		path.join(TEST_AGENT_DIR, "config.yml"),
		`disabledProviders:\n${DISABLED_MODEL_PROVIDERS.map(provider => `  - ${provider}`).join("\n")}\n`,
		"utf8",
	);
	process.env.GJC_AGENT_DIR = TEST_AGENT_DIR;
	process.env.GJC_CODING_AGENT_DIR = TEST_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = TEST_AGENT_DIR;
	process.env.HOME = TEST_ROOT;
});

afterAll(() => {
	for (const [key, value] of Object.entries(previousEnvironment)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(TEST_ROOT, { recursive: true, force: true });
});

type JsonObject = Record<string, unknown>;

type StartupStep = {
	readonly step: number;
	readonly direction: "client->server";
	readonly type: "request" | "notification";
	readonly method: string;
	readonly params?: JsonObject;
	readonly paramsOmitted?: boolean;
};

type TraceFixture = {
	readonly schemaVersion: number;
	readonly kind: string;
	readonly provenance: {
		readonly clientVersion: string;
		readonly sourceSha256: string;
		readonly extractedFrom: string;
		readonly note: string;
	};
	readonly startupSequence: readonly StartupStep[];
	readonly scopeImplication: string;
};

type Transcript = {
	readonly requests: Array<{ id: number; method: string }>;
	readonly responses: JsonObject[];
};

const fixture = traceFixture as TraceFixture;
const HEADER: TranscriptHeader = {
	gateId: "trace-replay",
	transportMode: "in-process",
	executionMode: "injected-in-process-session",
	profile: "experimental",
	clientVersion: fixture.provenance.clientVersion,
};

function isRecord(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function materializeParams(value: unknown): unknown {
	if (value === "<input.cwd>") return TEST_CWD;
	if (Array.isArray(value)) return value.map(materializeParams);
	if (!isRecord(value)) return value;
	return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, materializeParams(entry)]));
}

function decodeResponse(frame: Uint8Array | undefined): JsonObject {
	if (frame === undefined) throw new Error("Expected a JSON-RPC response for a startup request.");
	const parsed: unknown = JSON.parse(decoder.decode(frame));
	if (!isRecord(parsed)) throw new Error("Expected a JSON-RPC response object.");
	return parsed;
}

async function replayStartupSequence(): Promise<Transcript> {
	const state = new ConnectionState();
	const manager = new ThreadRuntimeManager();
	const registry = new HandlerRegistry();
	registerBuiltinHandlers(registry);
	const requests: Array<{ id: number; method: string }> = [];
	const responses: JsonObject[] = [];

	for (const step of fixture.startupSequence) {
		const frame: JsonObject = { id: step.step, method: step.method };
		if (step.type === "request") {
			requests.push({ id: step.step, method: step.method });
			if (!step.paramsOmitted && Object.hasOwn(step, "params")) frame.params = materializeParams(step.params);
		} else if (step.paramsOmitted) {
			delete frame.id;
		} else if (Object.hasOwn(step, "params")) {
			delete frame.id;
			frame.params = materializeParams(step.params);
		} else {
			delete frame.id;
		}

		const inbound = await processInbound(
			state,
			manager,
			encoder.encode(JSON.stringify(frame)),
			undefined,
			"websocket",
			registry,
			{ accountAuthState: () => false },
		);
		if (step.type === "notification") {
			expect(inbound.response, `${step.method} notification must not produce a response`).toBeUndefined();
			continue;
		}
		responses.push(decodeResponse(inbound.response));
	}

	return { requests, responses };
}

function tamperRequiredIdentifier(transcript: Transcript): { responses: JsonObject[]; expectedRule: string } {
	const turnIndex = transcript.responses.findIndex(response => {
		const result = response.result;
		return isRecord(result) && isRecord(result.turn) && Object.hasOwn(result.turn, "id");
	});
	if (turnIndex >= 0) {
		const response = transcript.responses[turnIndex]!;
		const result = response.result as JsonObject;
		const turn = result.turn as JsonObject;
		const { id: _droppedId, ...tamperedTurn } = turn;
		const tamperedResponses = [...transcript.responses];
		tamperedResponses[turnIndex] = { ...response, result: { ...result, turn: tamperedTurn } };
		return { responses: tamperedResponses, expectedRule: "validator.result" };
	}

	const response = transcript.responses[0];
	if (!response) throw new Error("Trace replay produced no response to tamper.");
	const { id: _droppedId, ...tamperedResponse } = response;
	const tamperedResponses = [...transcript.responses];
	tamperedResponses[0] = tamperedResponse;
	return { responses: tamperedResponses, expectedRule: "correlation.missingId" };
}

test("trace fixture provenance is pinned and explicitly cannot satisfy the real-client gate", () => {
	expect(fixture.schemaVersion).toBe(1);
	expect(fixture.kind).toBe("t3code-startup-trace");
	expect(fixture.provenance.clientVersion).toBe("0.0.28");
	expect(fixture.provenance.sourceSha256).toBe("c69b9ebf8ddf0b30194616b49163bc5b6e3670be5549b81567b56f3dcd7aebd3");
	expect(fixture.provenance.extractedFrom).toBe("Contents/Resources/app.asar.unpacked/apps/server/dist/bin.mjs");
	expect(fixture.provenance.note).toContain("not a live socket transcript");
	expect(fixture.provenance.note).toContain("cannot satisfy the real-t3 gate");
	expect(fixture.scopeImplication).toContain("static extraction");
	expect(fixture.scopeImplication).toContain("does not show the current behavior of a live GJC server");
	const initializeStep = fixture.startupSequence.find(step => step.method === "initialize");
	expect(initializeStep?.params?.capabilities).toEqual({ experimentalApi: true });
	const initializedStep = fixture.startupSequence.find(step => step.method === "initialized");
	expect(initializedStep?.paramsOmitted).toBe(true);
});

test("trace replay satisfies the shared oracle and committed golden bytes", async () => {
	const transcript = await replayStartupSequence();
	expect(transcript.requests.map(request => request.method)).toEqual([
		"initialize",
		"account/read",
		"skills/list",
		"model/list",
	]);
	expect(transcript.responses).toHaveLength(transcript.requests.length);

	const accountRead = transcript.responses.find(response => response.id === 3);
	if (!accountRead) throw new Error("account/read response was not replayed.");
	expect(accountRead).toEqual({
		id: 3,
		result: { account: null, requiresOpenaiAuth: false },
	});
	const modelList = transcript.responses.find(response => response.id === 5);
	expect(modelList?.result).toEqual({ data: [], nextCursor: null });

	const violations = assertTranscript({ header: HEADER, ...transcript });
	expect(violations).toEqual([]);

	const actualGolden = transcript.responses.map(response => goldenBytes(response));
	const committedGolden: unknown = JSON.parse(readFileSync(GOLDEN_PATH, "utf8"));
	expect(Array.isArray(committedGolden)).toBe(true);
	expect(committedGolden).toEqual(actualGolden);
});

test("trace replay oracle rejects a response with its required identifier dropped", async () => {
	const transcript = await replayStartupSequence();
	const tampered = tamperRequiredIdentifier(transcript);
	const violations = assertTranscript({
		header: HEADER,
		requests: transcript.requests,
		responses: tampered.responses,
	});
	expect(violations.some(violation => violation.rule === tampered.expectedRule)).toBe(true);
});
