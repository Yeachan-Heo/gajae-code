import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { streamAnthropic } from "@gajae-code/ai/providers/anthropic";
import type { Context, Model, TJsonSchema } from "@gajae-code/ai/types";

type CacheControl = { type: string; ttl?: string };
type ContentBlock = { type: string; cache_control?: CacheControl };
type PayloadMessage = { role: string; content: string | ContentBlock[] };
type Payload = { messages: PayloadMessage[]; system?: unknown[]; tools?: unknown[] };
type Placement = "oldPlacement" | "newPlacement";
type Anchor = { path: string; sha256: string; cacheableTokenEstimate: number; prefix: string[] };
type EvalArtifact = {
	schemaVersion: 3;
	issue: 2383;
	status: "pass";
	evidenceType: "deterministic-sequential-three-request-provider-payload-simulation";
	source: {
		url: string;
		retrievedAt: string;
		providerSourceBlobOid: string;
		providerSourceSha256: string;
		inputFixtureSha256: string;
	};
	derivationCommands: string[];
	perTurn: Record<
		Placement,
		Array<{ anchors: Array<{ path: string; sha256: string }>; cacheableTokenEstimateAtLeast: number }>
	>;
	simulatedExplicitBreakpointWriteTokensAtLeast: Record<Placement, number[]>;
	simulatedExplicitBreakpointReadTokensAtLeast: Record<Placement, number[]>;
	method: string;
	limitations: string[];
	testCommand: string;
};

const artifactPath = new URL("../../../artifacts/architecture-2383-eval.json", import.meta.url);
const repoRoot = path.resolve(import.meta.dir, "../../..");
const packageRoot = path.resolve(import.meta.dir, "..");
const providerSourceGitPath = "packages/ai/src/providers/anthropic.ts";
const providerSourcePath = path.resolve(import.meta.dir, "../src/providers/anthropic.ts");
const model: Model<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://proxy.example.test/anthropic",
	compat: { promptCacheMode: "explicit" },
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};
const fixture = {
	stablePrefix:
		"Follow the retrieval protocol exactly. Preserve cited facts and call lookup before answering. ".repeat(80),
	toolResultVariants: ["Result from source A", "Result from source B", "Result from source C"],
};

function sha256(value: string): Promise<string> {
	return crypto.subtle
		.digest("SHA-256", new TextEncoder().encode(value))
		.then(digest => Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join(""));
}

function cacheIdentityJson(value: unknown): string {
	return JSON.stringify(value, (key, nestedValue) => (key === "cache_control" ? undefined : nestedValue));
}

function git(args: string[], cwd = repoRoot): string {
	const result = Bun.spawnSync(["git", ...args], { cwd });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
	return result.stdout.toString().trim();
}

async function currentSourceIdentity(
	cwd = repoRoot,
): Promise<{ providerSourceBlobOid: string; providerSourceSha256: string }> {
	return {
		providerSourceBlobOid: git(["rev-parse", `HEAD:${providerSourceGitPath}`], cwd),
		providerSourceSha256: await sha256(await Bun.file(providerSourcePath).text()),
	};
}

function contextForTurn(turn: number): Context {
	const callId = "call_1";
	return {
		systemPrompt: [fixture.stablePrefix],
		tools: [
			{
				name: "lookup",
				description: "Looks up an answer.",
				parameters: { type: "object", properties: {} } as TJsonSchema,
			},
		],
		messages: [
			{ role: "user", content: "Find the answer", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: callId, name: "lookup", arguments: {} }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: model.id,
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
			},
			{
				role: "toolResult",
				toolCallId: callId,
				toolName: "lookup",
				content: [{ type: "text", text: fixture.toolResultVariants[turn]! }],
				isError: false,
				timestamp: 3,
			},
			{ role: "user", content: "Use the newest lookup result in the answer.", timestamp: 4 },
		],
	};
}

function capturePayload(turn: number): Promise<Payload> {
	const controller = new AbortController();
	controller.abort();
	const { promise, resolve } = Promise.withResolvers<Payload>();
	streamAnthropic(model, contextForTurn(turn), {
		apiKey: "sk-ant-api-test",
		isOAuth: false,
		signal: controller.signal,
		onPayload: payload => resolve(payload as Payload),
	});
	return promise;
}

function cachePaths(payload: Payload): string[] {
	const paths: string[] = [];
	for (const [messageIndex, message] of payload.messages.entries()) {
		if (!Array.isArray(message.content)) continue;
		for (const [blockIndex, block] of message.content.entries()) {
			if (block.cache_control) paths.push(`messages[${messageIndex}].content[${blockIndex}]`);
		}
	}
	return paths;
}

function isToolResultMessage(message: PayloadMessage): boolean {
	return (
		Array.isArray(message.content) &&
		message.content.length > 0 &&
		message.content.every(block => block.type === "tool_result")
	);
}

function oldPlacement(payload: Payload): Payload {
	const old = structuredClone(payload);
	for (const message of old.messages) {
		if (Array.isArray(message.content)) for (const block of message.content) delete block.cache_control;
	}
	const control = cachePaths(payload)
		.map(path => /messages\[(\d+)\]\.content\[(\d+)\]/.exec(path))
		.find(Boolean);
	if (!control) throw new Error("Provider payload lacks an explicit cache-control breakpoint");
	const cacheControl = (payload.messages[Number(control[1])]!.content as ContentBlock[])[Number(control[2])]!
		.cache_control;
	const toolIndex = old.messages.findLastIndex(isToolResultMessage);
	const humanIndex = old.messages.findLastIndex(message => message.role === "user" && !isToolResultMessage(message));
	if (!cacheControl || toolIndex < 0 || humanIndex < 0)
		throw new Error("Provider payload lacks expected tool-result/current-human blocks");
	(old.messages[toolIndex]!.content as ContentBlock[])[0]!.cache_control = cacheControl;
	const humanBlocks = old.messages[humanIndex]!.content;
	if (!Array.isArray(humanBlocks) || !humanBlocks[0]) throw new Error("Current human message is not cacheable");
	humanBlocks[0].cache_control = cacheControl;
	return old;
}

async function anchors(payload: Payload): Promise<Anchor[]> {
	return Promise.all(
		cachePaths(payload).map(async path => {
			const match = /messages\[(\d+)\]/.exec(path);
			if (!match) throw new Error(`Unknown cache breakpoint: ${path}`);
			const messageIndex = Number(match[1]);
			const prefix = [
				cacheIdentityJson(payload.tools ?? []),
				cacheIdentityJson(payload.system ?? []),
				...payload.messages.slice(0, messageIndex + 1).map(cacheIdentityJson),
			];
			const input = prefix.join("\n");
			return {
				path,
				sha256: await sha256(input),
				cacheableTokenEstimate: Math.floor(new TextEncoder().encode(input).byteLength / 4),
				prefix,
			};
		}),
	);
}

function isInclusivePrefix(candidate: Anchor, current: Anchor): boolean {
	return (
		candidate.prefix.length <= current.prefix.length &&
		candidate.prefix.every((part, index) => part === current.prefix[index])
	);
}

function simulateExplicitRetention(turns: Anchor[][]): { writes: number[]; reads: number[] } {
	const retained: Anchor[] = [];
	const writes: number[] = [];
	const reads: number[] = [];
	for (const turn of turns) {
		reads.push(
			Math.max(
				0,
				...turn.flatMap(current =>
					retained
						.filter(candidate => isInclusivePrefix(candidate, current))
						.map(candidate => candidate.cacheableTokenEstimate),
				),
			),
		);
		writes.push(Math.max(...turn.map(anchor => anchor.cacheableTokenEstimate)));
		retained.push(...turn);
	}
	return { writes, reads };
}

function validateSource(
	artifact: EvalArtifact,
	identity: { providerSourceBlobOid: string; providerSourceSha256: string },
	fixtureSha256: string,
): void {
	if (artifact.source.providerSourceBlobOid !== identity.providerSourceBlobOid)
		throw new Error("Provider source blob OID does not match committed evidence");
	if (artifact.source.providerSourceSha256 !== identity.providerSourceSha256)
		throw new Error("Provider source SHA-256 does not match committed evidence");
	if (artifact.source.inputFixtureSha256 !== fixtureSha256)
		throw new Error("Input fixture SHA-256 does not match committed evidence");
}

async function deriveEvidence(): Promise<{
	payloads: Record<Placement, Payload[]>;
	anchors: Record<Placement, Anchor[][]>;
	retention: Record<Placement, { writes: number[]; reads: number[] }>;
}> {
	const newPayloads: Payload[] = [];
	for (let turn = 0; turn < fixture.toolResultVariants.length; turn++) newPayloads.push(await capturePayload(turn));
	const payloads = { newPlacement: newPayloads, oldPlacement: newPayloads.map(oldPlacement) };
	const captured = {
		newPlacement: await Promise.all(payloads.newPlacement.map(anchors)),
		oldPlacement: await Promise.all(payloads.oldPlacement.map(anchors)),
	};
	const retention = {
		newPlacement: simulateExplicitRetention(captured.newPlacement),
		oldPlacement: simulateExplicitRetention(captured.oldPlacement),
	};
	return { payloads, anchors: captured, retention };
}

async function buildArtifact(): Promise<EvalArtifact> {
	const identity = await currentSourceIdentity();
	const fixtureSha256 = await sha256(JSON.stringify(fixture));
	const evidence = await deriveEvidence();
	const perTurn = async (placement: Placement) =>
		Promise.all(
			evidence.anchors[placement].map(async turn => {
				const estimate = Math.max(...turn.map(anchor => anchor.cacheableTokenEstimate));
				if (estimate < 1024) throw new Error(`Turn is below the documented 1,024-token cache minimum: ${estimate}`);
				return {
					anchors: await Promise.all(
						turn.map(async anchor => ({ path: anchor.path, sha256: await sha256(anchor.path) })),
					),
					cacheableTokenEstimateAtLeast: 1024,
				};
			}),
		);
	const lowerBounds = (values: number[]) => values.map(value => (value === 0 ? 0 : Math.min(value, 1024)));
	return {
		schemaVersion: 3,
		issue: 2383,
		status: "pass",
		evidenceType: "deterministic-sequential-three-request-provider-payload-simulation",
		source: {
			url: "https://platform.claude.com/docs/en/build-with-claude/prompt-caching",
			retrievedAt: "2026-07-18",
			...identity,
			inputFixtureSha256: fixtureSha256,
		},
		derivationCommands: [
			"git rev-parse HEAD:packages/ai/src/providers/anthropic.ts",
			"git hash-object packages/ai/src/providers/anthropic.ts",
			"sha256sum packages/ai/src/providers/anthropic.ts",
			"WRITE_ARCHITECTURE_2383_EVAL=1 bun test packages/ai/test/anthropic-cache-eval.integration.test.ts",
			"bun test packages/ai/test/anthropic-cache-eval.integration.test.ts",
		],
		perTurn: { oldPlacement: await perTurn("oldPlacement"), newPlacement: await perTurn("newPlacement") },
		simulatedExplicitBreakpointWriteTokensAtLeast: {
			oldPlacement: lowerBounds(evidence.retention.oldPlacement.writes),
			newPlacement: lowerBounds(evidence.retention.newPlacement.writes),
		},
		simulatedExplicitBreakpointReadTokensAtLeast: {
			oldPlacement: lowerBounds(evidence.retention.oldPlacement.reads),
			newPlacement: lowerBounds(evidence.retention.newPlacement.reads),
		},
		method:
			"The test sequentially builds three real explicit-mode streamAnthropic onPayload requests over the same agentic turn shape, with a distinct newest tool result on each request and a stable prefix above the documented 1,024-token minimum. It models documented explicit cache writes at each provider-built cache_control breakpoint and reads using inclusive structural prefix lookback over the actual built tools, system, and message sequence. Cache-control metadata is excluded from prefix identity because it designates the breakpoint rather than prompt content. The old comparator places the assistant breakpoint on the volatile tool-result wire message plus the current human message; the provider payload is the new comparator, with the stable previous assistant boundary plus current human message. All token quantities are structural simulated estimates, not billed or provider-reported usage.",
		limitations: [
			"This is deterministic local simulation over provider-built payloads; it does not send Anthropic API requests.",
			"Structural simulated token estimates use floor(UTF-8 bytes / 4), not provider tokenization or billing telemetry.",
			"The cited prompt-caching documentation was retrieved on 2026-07-18; cache retention, pricing, and provider usage are not asserted.",
		],
		testCommand: "bun test packages/ai/test/anthropic-cache-eval.integration.test.ts",
	};
}

describe("Anthropic cache placement eval (deterministic sequential three-request integration)", () => {
	it("resolves the immutable provider identity from repo and package working directories", async () => {
		expect(await currentSourceIdentity(packageRoot)).toEqual(await currentSourceIdentity(repoRoot));
	});
	it("binds immutable source/fixture evidence and simulates documented explicit cache retention", async () => {
		const derivedArtifact = await buildArtifact();
		if (process.env.WRITE_ARCHITECTURE_2383_EVAL === "1")
			await Bun.write(artifactPath, `${JSON.stringify(derivedArtifact, null, "\t")}\n`);
		const artifact = (await Bun.file(artifactPath).json()) as EvalArtifact;
		expect(artifact).toEqual(derivedArtifact);
		const identity = await currentSourceIdentity();
		const fixtureSha256 = await sha256(JSON.stringify(fixture));
		validateSource(artifact, identity, fixtureSha256);
		expect(() =>
			validateSource(
				{ ...artifact, source: { ...artifact.source, providerSourceBlobOid: "0".repeat(40) } },
				identity,
				fixtureSha256,
			),
		).toThrow();
		expect(() =>
			validateSource(
				{ ...artifact, source: { ...artifact.source, inputFixtureSha256: "0".repeat(64) } },
				identity,
				fixtureSha256,
			),
		).toThrow();

		const evidence = await deriveEvidence();
		for (const placement of ["oldPlacement", "newPlacement"] as const) {
			expect(evidence.payloads[placement]).toHaveLength(3);
			expect(evidence.anchors[placement].map(turn => turn.map(anchor => anchor.path))).toEqual(
				artifact.perTurn[placement].map(turn => turn.anchors.map(anchor => anchor.path)),
			);
			for (const [turnIndex, turn] of evidence.anchors[placement].entries()) {
				const estimate = Math.max(...turn.map(anchor => anchor.cacheableTokenEstimate));
				expect(estimate).toBeGreaterThanOrEqual(
					artifact.perTurn[placement][turnIndex]!.cacheableTokenEstimateAtLeast,
				);
				for (const anchor of artifact.perTurn[placement][turnIndex]!.anchors)
					expect(await sha256(anchor.path)).toBe(anchor.sha256);
			}
		}
		expect(await sha256(`${artifact.perTurn.newPlacement[0]!.anchors[0]!.path}!`)).not.toBe(
			artifact.perTurn.newPlacement[0]!.anchors[0]!.sha256,
		);
		for (const [turn, oldRead] of evidence.retention.oldPlacement.reads.entries()) {
			expect(evidence.retention.newPlacement.reads[turn]).toBeGreaterThanOrEqual(oldRead);
			for (const placement of ["oldPlacement", "newPlacement"] as const) {
				expect(evidence.retention[placement].writes[turn]).toBeGreaterThanOrEqual(
					artifact.simulatedExplicitBreakpointWriteTokensAtLeast[placement][turn]!,
				);
				expect(evidence.retention[placement].reads[turn]).toBeGreaterThanOrEqual(
					artifact.simulatedExplicitBreakpointReadTokensAtLeast[placement][turn]!,
				);
			}
		}
		expect(evidence.retention.newPlacement.reads.slice(1).every(value => value >= 1024)).toBe(true);
	});
});
