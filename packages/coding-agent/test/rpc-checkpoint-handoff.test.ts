import { afterEach, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@gajae-code/agent-core";
import type { RpcCommand, RpcResponse } from "@gajae-code/coding-agent/modes/rpc/rpc-types";
import {
	dispatchRpcCommand,
	type RpcCommandDispatchContext,
} from "@gajae-code/coding-agent/modes/shared/agent-wire/command-dispatch";
import { isRpcCommand } from "@gajae-code/coding-agent/modes/shared/agent-wire/command-validation";
import type { AgentSession } from "@gajae-code/coding-agent/session/agent-session";

type CheckpointCommand = Extract<RpcCommand, { type: "checkpoint_for_handoff" }>;
type CheckpointData = Extract<RpcResponse, { command: "checkpoint_for_handoff"; success: true }>["data"];

const temporaryDirectories: string[] = [];
const authority = {
	incarnationDigest: "a".repeat(64),
	epochRevision: 7,
	leaseId: 11,
	deploymentGeneration: 13,
};

async function transcript(contents = '{"id":"session-1"}\n'): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-checkpoint-handoff-"));
	temporaryDirectories.push(directory);
	const sessionFile = path.join(directory, "session.jsonl");
	await Bun.write(sessionFile, contents);
	return sessionFile;
}

function checkpointCommand(overrides: Partial<CheckpointCommand> = {}): CheckpointCommand {
	return {
		id: "checkpoint-1",
		type: "checkpoint_for_handoff",
		authority,
		lane: "main",
		...overrides,
	};
}

function checkpointSession(options: {
	sessionFile?: string | null;
	sessionId?: string;
	model?: { provider: string; id: string } | null;
	thinkingLevel?: ThinkingLevel;
	modelProfile?: string | null;
	defaultModelProfile?: string;
	flush?: () => Promise<void>;
	ensureOnDisk?: () => Promise<void>;
	isStreaming?: boolean;
	queuedMessageCount?: number;
}): AgentSession {
	return {
		sessionFile: options.sessionFile === null ? undefined : options.sessionFile,
		sessionId: options.sessionId ?? "session-1",
		model: options.model === null ? undefined : (options.model ?? { provider: "openai-codex", id: "gpt-5.6-sol" }),
		thinkingLevel: options.thinkingLevel ?? ThinkingLevel.XHigh,
		getActiveModelProfile: () => (options.modelProfile === null ? undefined : (options.modelProfile ?? "codex-pro")),
		settings: { get: () => options.defaultModelProfile },
		sessionManager: {
			ensureOnDisk: options.ensureOnDisk ?? (async () => {}),
			flush: options.flush ?? (async () => {}),
		},
		isStreaming: options.isStreaming ?? false,
		isCompacting: false,
		queuedMessageCount: options.queuedMessageCount ?? 0,
		hasPostPromptWork: false,
		isTtsrAbortPending: false,
		isPlanCompactAbortPending: false,
		isGeneratingHandoff: false,
		isRetrying: false,
		isBashRunning: false,
		isEvalRunning: false,
		hasPendingBashMessages: false,
		hasPendingPythonMessages: false,
	} as unknown as AgentSession;
}

function context(session: AgentSession): RpcCommandDispatchContext {
	return {
		session,
		output: () => {},
		hostToolRegistry: { setTools: () => [] },
		hostUriRegistry: { setSchemes: () => [] },
		createUiContext: () => ({ notify: () => {} }),
	};
}

function checkpointData(response: RpcResponse): CheckpointData {
	expect(response.success).toBe(true);
	if (!response.success || response.command !== "checkpoint_for_handoff") {
		throw new Error("Expected a checkpoint_for_handoff success response");
	}
	return response.data;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

describe("checkpoint_for_handoff RPC", () => {
	test("fsyncs the exact transcript and returns the version-1 handoff receipt without transcript text", async () => {
		const contents = '{"id":"session-1"}\n{"type":"message"}\n';
		const sessionFile = await transcript(contents);
		let flushCalls = 0;
		let ensureOnDiskCalls = 0;

		const response = await dispatchRpcCommand(
			checkpointCommand(),
			context(
				checkpointSession({
					sessionFile,
					ensureOnDisk: async () => {
						ensureOnDiskCalls += 1;
					},
					flush: async () => {
						flushCalls += 1;
					},
				}),
			),
		);
		const data = checkpointData(response);

		expect(flushCalls).toBe(1);
		expect(ensureOnDiskCalls).toBe(1);
		expect(data).toMatchObject({
			protocolVersion: 1,
			authority,
			lane: "main",
			cleanQuiesced: true,
			transcriptFsynced: true,
			sessionId: "session-1",
			sessionFile,
			provider: "openai-codex",
			model: "gpt-5.6-sol",
			thinking: ThinkingLevel.XHigh,
			modelProfile: "codex-pro",
			transcriptDigest: crypto.createHash("sha256").update(contents).digest("hex"),
			completedMarkerDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
		});
		expect(Object.keys(data).sort()).toEqual([
			"authority",
			"cleanQuiesced",
			"completedMarkerDigest",
			"lane",
			"model",
			"modelProfile",
			"protocolVersion",
			"provider",
			"sessionFile",
			"sessionId",
			"thinking",
			"transcriptDigest",
			"transcriptFsynced",
		]);
		expect(JSON.stringify(data)).not.toContain(contents);
		expect(data).not.toHaveProperty("childDisposition");
	});

	test.each([
		["streaming", { isStreaming: true }],
		["queued messages", { queuedMessageCount: 1 }],
	])("refuses a %s session before flushing", async (_name, busyState) => {
		let flushCalls = 0;
		const response = await dispatchRpcCommand(
			checkpointCommand(),
			context(
				checkpointSession({
					sessionFile: "/tmp/session.jsonl",
					...busyState,
					flush: async () => {
						flushCalls += 1;
					},
				}),
			),
		);

		expect(flushCalls).toBe(0);
		expect(response).toMatchObject({
			id: "checkpoint-1",
			command: "checkpoint_for_handoff",
			success: false,
			error: "Session is not quiescent for handoff checkpoint",
		});
	});

	test("refuses to issue a receipt when SessionManager fsync fails", async () => {
		const sessionFile = await transcript();
		const response = await dispatchRpcCommand(
			checkpointCommand(),
			context(
				checkpointSession({
					sessionFile,
					flush: async () => {
						throw new Error("fsync failed");
					},
				}),
			),
		);

		expect(response).toMatchObject({
			command: "checkpoint_for_handoff",
			success: false,
			error: "fsync failed",
		});
	});

	test.each([
		["missing persistent session", { sessionFile: null }],
		["missing model", { model: null }],
		["missing model profile", { modelProfile: null }],
	])("refuses a %s", async (_name, incompleteState) => {
		let flushCalls = 0;
		const response = await dispatchRpcCommand(
			checkpointCommand(),
			context(
				checkpointSession({
					...incompleteState,
					flush: async () => {
						flushCalls += 1;
					},
				}),
			),
		);

		expect(flushCalls).toBe(0);
		expect(response).toMatchObject({
			command: "checkpoint_for_handoff",
			success: false,
			error: "A persistent session and concrete model profile are required for handoff checkpoint",
		});
	});

	test("rejects malformed authority fences, ambiguous authority fields, and unknown lanes", () => {
		const malformed: unknown[] = [
			checkpointCommand({ authority: { ...authority, incarnationDigest: "A".repeat(64) } }),
			checkpointCommand({ authority: { ...authority, incarnationDigest: "a".repeat(63) } }),
			checkpointCommand({ authority: { ...authority, epochRevision: false } as unknown as typeof authority }),
			checkpointCommand({ authority: { ...authority, epochRevision: 0 } }),
			checkpointCommand({ authority: { ...authority, leaseId: -1 } }),
			checkpointCommand({ authority: { ...authority, deploymentGeneration: 0 } }),
			checkpointCommand({ authority: { ...authority, leaseId: 0 } }),
			checkpointCommand({ authority: { ...authority, deploymentGeneration: 1.5 } }),
			checkpointCommand({ authority: { ...authority, unexpected: "field" } as typeof authority }),
			checkpointCommand({ lane: "sidecar" as "main" }),
		];

		expect(malformed.map(isRpcCommand)).toEqual(malformed.map(() => false));
	});

	test("binds the completed marker deterministically to authority and lane", async () => {
		const sessionFile = await transcript();
		const session = checkpointSession({ sessionFile });

		const first = checkpointData(await dispatchRpcCommand(checkpointCommand(), context(session)));
		const expectedMarkerPayload = JSON.stringify({
			authority: {
				deploymentGeneration: authority.deploymentGeneration,
				epochRevision: authority.epochRevision,
				incarnationDigest: authority.incarnationDigest,
				leaseId: authority.leaseId,
			},
			domain: "gjc.checkpoint-for-handoff.completed-marker.v1",
			lane: "main",
			model: "gpt-5.6-sol",
			modelProfile: "codex-pro",
			provider: "openai-codex",
			sessionFileDigest: crypto.createHash("sha256").update(sessionFile).digest("hex"),
			sessionId: "session-1",
			thinking: ThinkingLevel.XHigh,
			transcriptDigest: first.transcriptDigest,
		});
		if (expectedMarkerPayload === undefined) {
			throw new Error("Checkpoint marker payload was not serializable");
		}
		const expectedCompletedMarkerDigest = crypto.createHash("sha256").update(expectedMarkerPayload).digest("hex");
		const repeated = checkpointData(await dispatchRpcCommand(checkpointCommand(), context(session)));
		const changedAuthority = checkpointData(
			await dispatchRpcCommand(
				checkpointCommand({ authority: { ...authority, epochRevision: authority.epochRevision + 1 } }),
				context(session),
			),
		);
		const changedLane = checkpointData(
			await dispatchRpcCommand(checkpointCommand({ lane: "self" }), context(session)),
		);

		expect(first.completedMarkerDigest).toBe(expectedCompletedMarkerDigest);
		expect(repeated.completedMarkerDigest).toBe(first.completedMarkerDigest);
		expect(changedAuthority.completedMarkerDigest).not.toBe(first.completedMarkerDigest);
		expect(changedLane.completedMarkerDigest).not.toBe(first.completedMarkerDigest);
		expect(changedAuthority.transcriptDigest).toBe(first.transcriptDigest);
		expect(changedLane.transcriptDigest).toBe(first.transcriptDigest);
	});
});
