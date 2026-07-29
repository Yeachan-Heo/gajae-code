import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentEvent } from "@gajae-code/agent-core";
import type { AssistantMessage } from "@gajae-code/ai";
import { AsyncJobManager } from "../../src/async/job-manager";
import { kNoAuth } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import type { LoadExtensionsResult } from "../../src/extensibility/extensions/types";
import { ArtifactProtocolHandler } from "../../src/internal-urls/artifact-protocol";
import type { CreateAgentSessionResult } from "../../src/sdk";
import * as sdkModule from "../../src/sdk";
import type { AgentSession, AgentSessionEvent } from "../../src/session/agent-session";
import { ArtifactManager } from "../../src/session/artifacts";
import {
	ManagedSessionDescendantStore,
	managedDirectoryRoot,
} from "../../src/session/internal/managed-session-storage";
import { createManagedTaskPersistence, type ExecutorOptions, runSubprocess } from "../../src/task/executor";
import { buildTaskReceipt, findRawTaskLeakKeys } from "../../src/task/receipt";
import type { AgentDefinition, SingleResult } from "../../src/task/types";
import { EventBus } from "../../src/utils/event-bus";

const MAX_REVIEW_FINDINGS_BYTES = 16 * 1024 * 1024;
const REVIEW_FINDINGS_FAILURE = "Review findings artifact publication failed.";
const roots: string[] = [];

const agent: AgentDefinition = {
	name: "architect",
	description: "test reviewer",
	systemPrompt: "test",
	tools: ["report_finding", "yield"],
	source: "bundled",
};

const modelRegistry = {
	refresh: async () => {},
	getAvailable: () => [],
	getApiKey: async () => kNoAuth,
} as unknown as import("../../src/config/model-registry").ModelRegistry;

interface Finding {
	title: string;
	body: string;
	priority: "P0" | "P1" | "P2" | "P3";
	confidence: number;
	file_path: string;
	line_start: number;
	line_end: number;
}

interface CanonicalReviewPayload {
	version: 1;
	kind: "review-findings";
	taskId: string;
	findingCount: number;
	findings: Finding[];
}

function finding(index: number, body = `details ${index}`): Finding {
	return {
		title: `[P1] finding ${index}`,
		body,
		priority: "P1",
		confidence: 0.9,
		file_path: `/repo/src/example-${index}.ts`,
		line_start: index + 1,
		line_end: index + 2,
	};
}

function completion() {
	return {
		overall_correctness: "incorrect" as const,
		explanation: "Found review defects",
		confidence: 0.95,
	};
}

function outputSchema() {
	return {
		properties: {
			overall_correctness: { enum: ["correct", "incorrect"] },
			explanation: { type: "string" },
			confidence: { type: "float64" },
		},
	};
}

function createMessage(text = "review completed"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

interface ReviewSessionOptions {
	includeYield?: boolean;
	yieldStatus?: "success" | "aborted";
	messageText?: string;
	onDispose?: () => void;
	disposeRelease?: Promise<void>;
	onlyFirstPrompt?: boolean;
}

function createReviewSession(
	findings: Finding[],
	data = completion(),
	options: ReviewSessionOptions = {},
): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const message = createMessage(options.messageText);
	let promptCalls = 0;
	const emit = (event: AgentEvent) => {
		for (const listener of listeners) listener(event);
	};
	return {
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["report_finding", "yield"],
		setActiveToolsByName: async () => {},
		setConfiguredModelChain: () => {},
		getConfiguredModelChain: () => undefined,
		seedDefaultFallbackResolution: () => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async () => {
			promptCalls += 1;
			if (options.onlyFirstPrompt && promptCalls > 1) return;
			emit({ type: "message_end", message });
			for (const [index, details] of findings.entries()) {
				emit({
					type: "tool_execution_end",
					toolCallId: `finding-${index}`,
					toolName: "report_finding",
					result: { content: [{ type: "text", text: "Finding recorded" }], details },
					isError: false,
				});
			}
			if (options.includeYield !== false) {
				const details =
					options.yieldStatus === "aborted"
						? { status: "aborted" as const, error: "review aborted" }
						: { status: "success" as const, data };
				emit({
					type: "tool_execution_end",
					toolCallId: "yield-call",
					toolName: "yield",
					result: { content: [{ type: "text", text: "Result submitted" }], details },
					isError: false,
				});
			}
			emit({ type: "agent_end", messages: [message], stopReason: "completed" });
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => message,
		abort: async () => {},
		dispose: async () => {
			options.onDispose?.();
			if (options.disposeRelease) await options.disposeRelease;
		},
	} as unknown as AgentSession;
}

async function drainMicrotasks(): Promise<void> {
	for (let index = 0; index < 20; index++) await Promise.resolve();
}

function createSessionResult(session: AgentSession): CreateAgentSessionResult {
	return {
		session,
		extensionsResult: {} as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	};
}

async function tempRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-review-findings-"));
	roots.push(root);
	return root;
}

function baseOptions(id: string, root: string): ExecutorOptions {
	return {
		cwd: root,
		agent,
		task: "review fixture",
		index: 0,
		id,
		subagentId: id,
		artifactsDir: path.join(root, "artifacts"),
		settings: Settings.isolated(),
		modelRegistry,
		enableLsp: false,
		outputSchema: outputSchema(),
	};
}

function artifactId(result: SingleResult): string {
	const uri = result.reviewFindingsRef?.uri;
	if (!uri) throw new Error("Expected review findings reference");
	return uri.slice("artifact://".length);
}

async function readArtifact(manager: ArtifactManager, result: SingleResult): Promise<string> {
	const id = artifactId(result);
	const artifactPath = await manager.getPath(id);
	if (!artifactPath) throw new Error(`Missing artifact ${id}`);
	return fs.readFile(artifactPath, "utf8");
}

async function readManagedSelected(
	artifactsDir: string,
	taskId: string,
): Promise<{
	output: string;
	metadata: { id: string; kind: string; sizeBytes: number; lineCount: number; sha256: string; createdAt: string };
}> {
	const selector = JSON.parse(await fs.readFile(path.join(artifactsDir, `${taskId}.md.selector.json`), "utf8")) as {
		outputFilename: string;
		metadataFilename: string;
	};
	return {
		output: await fs.readFile(path.join(artifactsDir, selector.outputFilename), "utf8"),
		metadata: JSON.parse(await fs.readFile(path.join(artifactsDir, selector.metadataFilename), "utf8")) as {
			id: string;
			kind: string;
			sizeBytes: number;
			sha256: string;
			lineCount: number;
			createdAt: string;
		},
	};
}

function canonicalPayload(taskId: string, findings: Finding[]): CanonicalReviewPayload {
	return { version: 1, kind: "review-findings", taskId, findingCount: findings.length, findings };
}

function resolveContext(dir: string) {
	return { getArtifactsDir: () => dir, getAuthorizedArtifactsDirs: () => [dir] };
}

beforeEach(() => {
	AsyncJobManager.setInstance(new AsyncJobManager({ onJobComplete: async () => {} }));
});

afterEach(async () => {
	vi.restoreAllMocks();
	const manager = AsyncJobManager.instance();
	if (manager) await manager.dispose({ timeoutMs: 100 });
	AsyncJobManager.setInstance(undefined);
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("review findings evidence separation", () => {
	it("keeps strict caller output separate from full canonical findings", async () => {
		const root = await tempRoot();
		const artifactsDir = path.join(root, "artifacts");
		const manager = new ArtifactManager(artifactsDir);
		const findings = Array.from({ length: 21 }, (_, index) =>
			finding(index, index === 20 ? "Unicode tail 한국어 😀 FULL-FINDING-TAIL-SENTINEL" : `details ${index}`),
		);
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(createReviewSession(findings)));

		const result = await runSubprocess({ ...baseOptions("0-Review", root), parentArtifactManager: manager });
		const receipt = buildTaskReceipt(result);
		const artifact = await readArtifact(manager, result);
		const ref = result.reviewFindingsRef!;

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.output)).toEqual(completion());
		expect(result.output).not.toContain("findings");
		expect(JSON.parse(artifact)).toEqual(canonicalPayload("0-Review", findings));
		expect(Buffer.byteLength(artifact)).toBe(ref.sizeBytes);
		expect(createHash("sha256").update(artifact).digest("hex")).toBe(ref.sha256);
		expect(ref.findingCount).toBe(21);
		expect(receipt.review?.findings).toHaveLength(20);
		expect(receipt.review?.findingsRef).toEqual(ref);
		expect(JSON.stringify(receipt)).not.toContain("FULL-FINDING-TAIL-SENTINEL");
		expect(JSON.stringify(receipt)).not.toContain("/repo/src/example-20.ts");
		expect(findRawTaskLeakKeys(receipt)).toEqual([]);

		const resolved = await new ArtifactProtocolHandler().resolve(
			new URL(ref.uri) as never,
			resolveContext(artifactsDir),
		);
		expect(resolved.content).toBe(artifact);
	});

	it("recovers fallback caller data while publishing findings separately", async () => {
		const root = await tempRoot();
		const manager = new ArtifactManager(path.join(root, "artifacts"));
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(
			createSessionResult(
				createReviewSession([finding(0)], completion(), {
					includeYield: false,
					messageText: JSON.stringify({ data: completion() }),
					onlyFirstPrompt: true,
				}),
			),
		);

		const result = await runSubprocess({ ...baseOptions("0-Fallback", root), parentArtifactManager: manager });

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.output)).toEqual(completion());
		expect(result.output).not.toContain("findings");
		expect(JSON.parse(await readArtifact(manager, result))).toEqual(canonicalPayload("0-Fallback", [finding(0)]));
	});

	it("fails closed without artifact authority while preserving caller output", async () => {
		const root = await tempRoot();
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(
			createSessionResult(createReviewSession([finding(0)])),
		);

		const result = await runSubprocess(baseOptions("0-NoAuthority", root));
		const receipt = buildTaskReceipt(result);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe(REVIEW_FINDINGS_FAILURE);
		expect(result.reviewFindingsRef).toBeUndefined();
		expect(JSON.parse(result.output)).toEqual(completion());
		expect(receipt.status).toBe("failed");
		expect(receipt.errorSummary).toBe("Error recorded.");
	});

	it("reports failed rather than aborted when evidence publication fails", async () => {
		const root = await tempRoot();
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(
			createSessionResult(createReviewSession([finding(0)], completion(), { yieldStatus: "aborted" })),
		);

		const result = await runSubprocess(baseOptions("0-AbortedPublicationFailure", root));
		const receipt = buildTaskReceipt(result);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe(REVIEW_FINDINGS_FAILURE);
		expect(result.aborted).toBe(false);
		expect(result.abortReason).toBeUndefined();
		expect(result.reviewFindingsRef).toBeUndefined();
		expect(receipt.status).toBe("failed");
	});

	it("serializes concurrent same-manager review publications and recovers after failure", async () => {
		const root = await tempRoot();
		const manager = new ArtifactManager(path.join(root, "artifacts"));
		const saveEntered = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const secondDisposeEntered = Promise.withResolvers<void>();
		const releaseSecondDispose = Promise.withResolvers<void>();
		const realSave = manager.save.bind(manager);
		let saveCalls = 0;
		const saveSpy = vi.spyOn(manager, "save").mockImplementation(async (...args) => {
			saveCalls += 1;
			if (saveCalls === 1) {
				saveEntered.resolve();
				await releaseFirst.promise;
				throw new Error("injected save failure");
			}
			return realSave(...args);
		});
		vi.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValueOnce(createSessionResult(createReviewSession([finding(0)])))
			.mockResolvedValueOnce(
				createSessionResult(
					createReviewSession([finding(1)], completion(), {
						onDispose: secondDisposeEntered.resolve,
						disposeRelease: releaseSecondDispose.promise,
					}),
				),
			);

		const first = runSubprocess({ ...baseOptions("0-First", root), parentArtifactManager: manager });
		await saveEntered.promise;
		const second = runSubprocess({ ...baseOptions("1-Second", root), parentArtifactManager: manager, index: 1 });
		await secondDisposeEntered.promise;
		releaseSecondDispose.resolve();
		await drainMicrotasks();
		expect(saveCalls).toBe(1);
		releaseFirst.resolve();
		const [firstResult, secondResult] = await Promise.all([first, second]);

		expect(firstResult.exitCode).toBe(1);
		expect(firstResult.stderr).toBe(REVIEW_FINDINGS_FAILURE);
		expect(secondResult.exitCode).toBe(0);
		expect(JSON.parse(await readArtifact(manager, secondResult))).toEqual(canonicalPayload("1-Second", [finding(1)]));
		expect(saveSpy).toHaveBeenCalledTimes(2);
	});

	it("keeps different artifact managers independent", async () => {
		const root = await tempRoot();
		const firstManager = new ArtifactManager(path.join(root, "first-artifacts"));
		const secondManager = new ArtifactManager(path.join(root, "second-artifacts"));
		const firstSaveEntered = Promise.withResolvers<void>();
		const releaseFirstSave = Promise.withResolvers<void>();
		const realFirstSave = firstManager.save.bind(firstManager);
		vi.spyOn(firstManager, "save").mockImplementation(async (...args) => {
			firstSaveEntered.resolve();
			await releaseFirstSave.promise;
			return realFirstSave(...args);
		});
		vi.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValueOnce(createSessionResult(createReviewSession([finding(0)])))
			.mockResolvedValueOnce(createSessionResult(createReviewSession([finding(1)])));

		const first = runSubprocess({
			...baseOptions("0-FirstManager", root),
			artifactsDir: path.join(root, "first-artifacts"),
			parentArtifactManager: firstManager,
		});
		await firstSaveEntered.promise;
		const secondResult = await runSubprocess({
			...baseOptions("1-SecondManager", root),
			index: 1,
			artifactsDir: path.join(root, "second-artifacts"),
			parentArtifactManager: secondManager,
		});

		releaseFirstSave.resolve();
		const firstResult = await first;
		expect(secondResult.exitCode).toBe(0);
		expect(JSON.parse(await readArtifact(secondManager, secondResult))).toEqual(
			canonicalPayload("1-SecondManager", [finding(1)]),
		);
		expect(firstResult.exitCode).toBe(0);
	});

	it("publishes at the reader limit and fails before save above it", async () => {
		const root = await tempRoot();
		const manager = new ArtifactManager(path.join(root, "artifacts"));
		const taskId = "0-AtLimit";
		const emptyFinding = finding(0, "");
		const baseSize = Buffer.byteLength(JSON.stringify(canonicalPayload(taskId, [emptyFinding]), null, 2));
		const atLimitFinding = finding(0, "x".repeat(MAX_REVIEW_FINDINGS_BYTES - baseSize));
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValueOnce(
			createSessionResult(createReviewSession([atLimitFinding])),
		);

		const atLimit = await runSubprocess({ ...baseOptions(taskId, root), parentArtifactManager: manager });
		const atLimitArtifact = await readArtifact(manager, atLimit);
		expect(atLimit.exitCode).toBe(0);
		expect(Buffer.byteLength(atLimitArtifact)).toBe(MAX_REVIEW_FINDINGS_BYTES);

		const overflowManager = new ArtifactManager(path.join(root, "overflow-artifacts"));
		const overflowTaskId = "1-OverLimit";
		const overflowBase = Buffer.byteLength(JSON.stringify(canonicalPayload(overflowTaskId, [emptyFinding]), null, 2));
		const overflowFinding = finding(0, "x".repeat(MAX_REVIEW_FINDINGS_BYTES - overflowBase + 1));
		const overflowSave = vi.spyOn(overflowManager, "save");
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValueOnce(
			createSessionResult(createReviewSession([overflowFinding])),
		);

		const overflow = await runSubprocess({
			...baseOptions(overflowTaskId, root),
			index: 1,
			artifactsDir: path.join(root, "overflow-artifacts"),
			parentArtifactManager: overflowManager,
		});
		const overflowReceipt = buildTaskReceipt(overflow);
		expect(overflow.exitCode).toBe(1);
		expect(overflow.stderr).toBe(REVIEW_FINDINGS_FAILURE);
		expect(overflow.reviewFindingsRef).toBeUndefined();
		expect(overflowSave).not.toHaveBeenCalled();
		expect(JSON.parse(overflow.output)).toEqual(completion());
		expect(overflow.output).not.toContain("findings");
		expect(overflowReceipt.status).toBe("failed");
		expect(overflowReceipt.errorSummary).toBe("Error recorded.");
	});
});

describe.skipIf(process.platform !== "linux")("managed review findings finalization", () => {
	it("serializes managed outputs by the persistence-owned manager", async () => {
		const root = await tempRoot();
		const artifactsDir = path.join(root, "artifacts");
		const manager = new ArtifactManager(new ManagedSessionDescendantStore(managedDirectoryRoot(root), artifactsDir));
		const firstPublishEntered = Promise.withResolvers<void>();
		const releaseFirstPublish = Promise.withResolvers<void>();
		const secondDisposeEntered = Promise.withResolvers<void>();
		const releaseSecondDispose = Promise.withResolvers<void>();
		const realPublish = manager.publishManagedOutputGeneration.bind(manager);
		let publishCalls = 0;
		vi.spyOn(manager, "publishManagedOutputGeneration").mockImplementation(async (...args) => {
			publishCalls += 1;
			if (publishCalls === 1) {
				firstPublishEntered.resolve();
				await releaseFirstPublish.promise;
			}
			return realPublish(...args);
		});
		vi.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValueOnce(createSessionResult(createReviewSession([])))
			.mockResolvedValueOnce(
				createSessionResult(
					createReviewSession([], completion(), {
						onDispose: secondDisposeEntered.resolve,
						disposeRelease: releaseSecondDispose.promise,
					}),
				),
			);

		const first = runSubprocess({
			...baseOptions("0-FirstOutput", root),
			artifactsDir,
			managedPersistence: createManagedTaskPersistence(manager, "0-FirstOutput"),
		});
		await firstPublishEntered.promise;
		const second = runSubprocess({
			...baseOptions("1-SecondOutput", root),
			index: 1,
			artifactsDir,
			managedPersistence: createManagedTaskPersistence(manager, "1-SecondOutput"),
		});
		await secondDisposeEntered.promise;
		releaseSecondDispose.resolve();
		await drainMicrotasks();
		const serializedBeforeRelease = publishCalls === 1;
		releaseFirstPublish.resolve();
		const [firstResult, secondResult] = await Promise.all([first, second]);

		expect(serializedBeforeRelease).toBe(true);
		expect([firstResult.exitCode, secondResult.exitCode]).toEqual([0, 0]);
		expect(publishCalls).toBe(2);
	});
	it("orders review saves with managed output generation on one shared manager", async () => {
		const root = await tempRoot();
		const artifactsDir = path.join(root, "artifacts");
		const manager = new ArtifactManager(new ManagedSessionDescendantStore(managedDirectoryRoot(root), artifactsDir));
		const firstSaveEntered = Promise.withResolvers<void>();
		const releaseFirstSave = Promise.withResolvers<void>();
		const bDisposeEntered = Promise.withResolvers<void>();
		const cDisposeEntered = Promise.withResolvers<void>();
		const releaseBDispose = Promise.withResolvers<void>();
		const releaseCDispose = Promise.withResolvers<void>();
		const realSave = manager.save.bind(manager);
		let saveCalls = 0;
		vi.spyOn(manager, "save").mockImplementation(async (...args) => {
			saveCalls += 1;
			if (saveCalls === 1) {
				firstSaveEntered.resolve();
				await releaseFirstSave.promise;
			}
			return realSave(...args);
		});
		const outputSpy = vi.spyOn(manager, "publishManagedOutputGeneration");
		vi.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValueOnce(createSessionResult(createReviewSession([finding(0)])))
			.mockResolvedValueOnce(
				createSessionResult(
					createReviewSession([finding(0)], completion(), {
						onDispose: bDisposeEntered.resolve,
						disposeRelease: releaseBDispose.promise,
					}),
				),
			)
			.mockResolvedValueOnce(
				createSessionResult(
					createReviewSession([finding(0)], completion(), {
						onDispose: cDisposeEntered.resolve,
						disposeRelease: releaseCDispose.promise,
					}),
				),
			);

		const a = runSubprocess({
			...baseOptions("0-A", root),
			artifactsDir,
			parentArtifactManager: manager,
			managedPersistence: createManagedTaskPersistence(manager, "0-A"),
		});
		await firstSaveEntered.promise;
		const b = runSubprocess({
			...baseOptions("1-B", root),
			index: 1,
			artifactsDir,
			parentArtifactManager: manager,
			managedPersistence: createManagedTaskPersistence(manager, "1-B"),
		});
		const c = runSubprocess({
			...baseOptions("2-C", root),
			index: 2,
			artifactsDir,
			parentArtifactManager: manager,
			managedPersistence: createManagedTaskPersistence(manager, "2-C"),
		});
		await Promise.all([bDisposeEntered.promise, cDisposeEntered.promise]);
		releaseBDispose.resolve();
		releaseCDispose.resolve();
		await drainMicrotasks();
		expect(outputSpy).not.toHaveBeenCalled();
		expect(saveCalls).toBe(1);
		releaseFirstSave.resolve();
		const [aResult, bResult, cResult] = await Promise.all([a, b, c]);

		expect([aResult.exitCode, bResult.exitCode, cResult.exitCode]).toEqual([0, 0, 0]);
		expect(new Set([artifactId(aResult), artifactId(bResult), artifactId(cResult)]).size).toBe(3);
		expect(JSON.parse(await readArtifact(manager, aResult))).toEqual(canonicalPayload("0-A", [finding(0)]));
		expect(JSON.parse(await readArtifact(manager, bResult))).toEqual(canonicalPayload("1-B", [finding(0)]));
		expect(JSON.parse(await readArtifact(manager, cResult))).toEqual(canonicalPayload("2-C", [finding(0)]));
		const managedResults: Array<[string, SingleResult]> = [
			["0-A", aResult],
			["1-B", bResult],
			["2-C", cResult],
		];
		for (const [taskId, result] of managedResults) {
			const selected = await readManagedSelected(artifactsDir, taskId);
			expect(selected.output).toBe(result.output);
			const sha256 = result.outputMeta?.sha256;
			if (!sha256) throw new Error(`Missing output hash for ${taskId}`);
			expect(selected.metadata).toEqual({
				id: taskId,
				kind: "agent-output",
				sizeBytes: Buffer.byteLength(result.output),
				lineCount: result.output.split("\n").length,
				sha256,
				createdAt: expect.any(String),
			});
		}
		expect(outputSpy).toHaveBeenCalledTimes(3);
	});
});
