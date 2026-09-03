import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { MANAGED_ATTEMPT_MAX_STAGED_BYTES } from "@gajae-code/agent-core/agent-loop";
import type { AssistantMessage } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { AsyncJobManager } from "../../src/async";
import { kNoAuth } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { getThemeByName } from "../../src/modes/theme/theme";
import * as sdkModule from "../../src/sdk";
import type { AgentSession, PromptOptions } from "../../src/session/agent-session";
import { subagentRunOutcomeFromSingleResult } from "../../src/task";
import { runSubprocess } from "../../src/task/executor";
import { buildTaskReceipt } from "../../src/task/receipt";
import type { AgentDefinition, AgentProgress } from "../../src/task/types";
import { createLocalErrorSummary, createSetupFailureSummary, type SingleResult } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";
import { capCodePointsAndBytes, SubagentTool } from "../../src/tools/implementations";
import type { SubagentToolDetails } from "../../src/tools/subagent";
import { subagentBodyCacheTestHooks, subagentToolRenderer } from "../../src/tools/subagent-render";

function createSession(agentId = "0-Main"): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getAgentId: () => agentId,
	} as ToolSession;
}

function createManager(): AsyncJobManager {
	const manager = new AsyncJobManager({
		onJobComplete: async () => {},
		retentionMs: 10_000,
	});
	AsyncJobManager.setInstance(manager);
	return manager;
}

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

/**
 * Trip a genuine staged-buffer overflow in the agent runtime (a single event
 * larger than the byte cap) and return the settled agent, so its real terminal
 * message can drive the executor chain (#4618).
 */
async function runOverflowAgent(): Promise<Agent> {
	const mock = createMockModel();
	const agent = new Agent({
		initialState: { model: mock.model, systemPrompt: ["test"], tools: [], messages: [] },
		streamFn: () => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const partial: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "x".repeat(MANAGED_ATTEMPT_MAX_STAGED_BYTES + 1) }],
					api: mock.model.api,
					provider: mock.model.provider,
					model: mock.model.id,
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
				stream.push({ type: "start", partial });
			});
			return stream;
		},
	});
	await agent.prompt("run", { fallbackManaged: true });
	await agent.waitForIdle();
	return agent;
}

const runSubprocessBaseOptions = {
	cwd: "/tmp",
	agent: { name: "planner", description: "test", systemPrompt: "test", source: "bundled" } as AgentDefinition,
	task: "read a large spec",
	index: 0,
	settings: Settings.isolated(),
	modelRegistry: {
		refresh: async () => {},
		getAvailable: () => [],
		getApiKey: async () => kNoAuth,
	} as never,
	enableLsp: false,
};

/** Session stub whose last assistant message is the real overflow terminal. */
function mockCreateAgentSessionWithTerminal(terminal: AssistantMessage) {
	const session = {
		agent: { state: { systemPrompt: ["test"] } },
		sessionManager: { appendSessionInit: () => {} },
		extensionRunner: undefined,
		get messages() {
			return [terminal];
		},
		state: { messages: [terminal] },
		getActiveToolNames: () => ["read", "yield"],
		setActiveToolsByName: async () => {},
		setConfiguredModelChain: () => {},
		seedDefaultFallbackResolution: () => {},
		subscribe: () => () => {},
		prompt: async (_text: string, options?: PromptOptions) => {
			await options?.onPreflightAcceptCommit?.();
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => terminal,
		abort: async () => {},
		dispose: async () => {},
	} as unknown as AgentSession;
	return vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({ session } as never);
}

const PREVIEW_TIERS = [
	{ name: "receipt", bytes: 1_024, codePoints: 280, verbosity: "receipt" },
	{ name: "preview", bytes: 8_192, codePoints: 2_000, verbosity: "preview" },
	{ name: "full", bytes: 49_152, codePoints: 12_000, verbosity: "full" },
] as const;

function multibytePayload(bytes: number): string {
	const prefix = "\u200b\u0301";
	const remaining = bytes - Buffer.byteLength(prefix);
	return `${prefix}${"\u{e0100}".repeat(Math.floor(remaining / 4))}${
		remaining % 4 === 0 ? "" : remaining % 4 === 1 ? "a" : remaining % 4 === 2 ? "\u0301" : "\u200b"
	}`;
}

async function inspectCompletedSubagent(
	text: string,
	verbosity: "receipt" | "preview" | "full",
): Promise<{ resultPreview?: string; label: string; assignment?: string; truncated?: boolean }> {
	const manager = createManager();
	const tool = new SubagentTool(createSession());
	const jobId = manager.register("task", text, async () => text, {
		id: `job-${verbosity}`,
		ownerId: "0-Main",
		metadata: {
			subagent: {
				id: `0-${verbosity}`,
				agent: "executor",
				agentSource: "bundled",
				assignment: text,
			},
		},
	});
	await manager.getJob(jobId)?.promise;
	const result = await tool.execute(`subagent-${verbosity}`, {
		action: "inspect",
		ids: [`0-${verbosity}`],
		verbosity,
	});
	const snapshot = result.details?.subagents[0];
	await manager.dispose({ timeoutMs: 100 });
	if (!snapshot) throw new Error("Expected completed subagent snapshot");
	return snapshot;
}

describe("SubagentTool", () => {
	afterEach(() => {
		AsyncJobManager.resetForTests();
	});

	it("keeps a failed subagent's public structured output visible to inspect and await", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		const publicReview = '{"overall_correctness":"incorrect","summary":"Public review"}';
		const jobId = manager.register("task", "stalled review", async () => ({ kind: "failed", text: publicReview }), {
			id: "job-stalled-review",
			ownerId: "0-Main",
			metadata: {
				subagent: {
					id: "0-StalledReview",
					agent: "architect",
					agentSource: "bundled",
					assignment: "Review the change.",
				},
			},
		});
		await manager.getJob(jobId)?.promise;

		for (const action of ["inspect", "await"] as const) {
			const result = await tool.execute(`subagent-${action}-failed-review`, {
				action,
				ids: ["0-StalledReview"],
				verbosity: "full",
			});
			const snapshot = result.details?.subagents[0];
			expect(snapshot?.status).toBe("failed");
			expect(snapshot?.errorText).toBe(publicReview);
			expect(getText(result)).toContain("Error preview:");
			expect(getText(result)).toContain(publicReview);
		}
	});

	it("does not expose live provider thinking through await progress", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		const gate = Promise.withResolvers<string>();
		manager.register("task", "live subagent", async () => gate.promise, {
			id: "job-private-progress",
			ownerId: "0-Main",
			metadata: {
				subagent: { id: "0-PrivateProgress", agent: "executor", agentSource: "bundled", assignment: "Work." },
			},
		});
		const progress: AgentProgress = {
			index: 0,
			id: "0-PrivateProgress",
			agent: "executor",
			agentSource: "bundled",
			status: "running",
			task: "Work.",
			recentTools: [],
			recentOutput: ["PRIVATE_THINKING_MUST_NOT_ESCAPE"],
			toolCount: 0,
			tokens: 0,
			cost: 0,
			durationMs: 0,
		};
		manager.recordSubagentProgress("0-PrivateProgress", progress);
		manager.registerLiveHandle("0-PrivateProgress", {
			requestPause: () => {},
			injectMessage: async () => {},
		});

		const result = await tool.execute("subagent-await-private-progress", {
			action: "await",
			ids: ["0-PrivateProgress"],
			timeout_ms: 1,
		});
		const snapshot = result.details?.subagents[0];
		expect(snapshot?.progress).toBeUndefined();
		expect(getText(result)).not.toContain("PRIVATE_THINKING_MUST_NOT_ESCAPE");
		gate.resolve("done");
		await manager.getJob("job-private-progress")?.promise;
	});

	it("lists only visible task jobs with subagent metadata", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession("0-Main"));
		manager.register(
			"task",
			"visible subagent",
			async () => {
				await Bun.sleep(50);
				return "visible done";
			},
			{
				id: "job-visible",
				ownerId: "0-Main",
				metadata: {
					subagent: {
						id: "0-Visible",
						agent: "executor",
						agentSource: "bundled",
						description: "visible task",
						assignment: "Do visible work.",
					},
				},
			},
		);
		manager.register("task", "hidden subagent", async () => "hidden done", {
			id: "job-hidden",
			ownerId: "1-Other",
			metadata: {
				subagent: {
					id: "1-Hidden",
					agent: "executor",
					agentSource: "bundled",
				},
			},
		});
		manager.register("bash", "generic job", async () => "generic done", { id: "job-bash", ownerId: "0-Main" });

		const result = await tool.execute("subagent-list", { action: "list" });

		expect(result.details?.subagents.map(subagent => subagent.id)).toEqual(["0-Visible"]);
		expect(getText(result)).toContain("0-Visible");
		expect(getText(result)).not.toContain("job-bash");
		await manager.dispose({ timeoutMs: 100 });
	});

	it("await retrieves completed subagent results and acknowledges delivery", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		const jobId = manager.register("task", "finished subagent", async () => "subagent result", {
			id: "job-done",
			ownerId: "0-Main",
			metadata: {
				subagent: {
					id: "0-Done",
					agent: "executor",
					agentSource: "project",
					description: "done task",
					assignment: "Return a result.",
				},
			},
		});
		await manager.getJob(jobId)?.promise;

		const result = await tool.execute("subagent-await", { action: "await", ids: ["0-Done"], timeout_ms: 100 });

		expect(result.details?.subagents[0]?.status).toBe("completed");
		expect(result.details?.subagents[0]?.resultText).toContain("subagent result");
		expect(getText(result)).toContain("subagent result");
		expect(manager.hasPendingDeliveries()).toBe(false);
		await manager.dispose({ timeoutMs: 100 });
	});
	it("retains a bounded, redacted executor setup failure in async subagent receipts", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		const secret = "TOP_SECRET_DO_NOT_LEAK";
		const setupFailure = createSetupFailureSummary(
			new Error(
				`Agent session initialization failed: token=${secret} at /tmp/${secret}/session.jsonl ${"x".repeat(400)}`,
			),
		);
		const singleResult = {
			aborted: false,
			exitCode: 1,
			setupFailure,
		} satisfies Pick<SingleResult, "aborted" | "exitCode" | "setupFailure">;
		const jobId = manager.register(
			"task",
			"launching subagent",
			async () => subagentRunOutcomeFromSingleResult("Subagent failed.", singleResult),
			{
				id: "job-setup-failure",
				ownerId: "0-Main",
				metadata: { subagent: { id: "0-SetupFailure", agent: "executor", agentSource: "bundled" } },
			},
		);

		await manager.getJob(jobId)?.promise;
		const result = await tool.execute("subagent-setup-failure", { action: "inspect", ids: ["0-SetupFailure"] });
		const snapshot = result.details?.subagents[0];

		expect(snapshot?.status).toBe("failed");
		expect(snapshot?.setupFailureSummary).toContain("Agent session initialization failed");
		expect(snapshot?.setupFailureSummary).toContain("token=[redacted]");
		expect(snapshot?.setupFailureSummary).not.toContain(secret);
		expect(snapshot?.setupFailureSummary).not.toContain("/tmp/");
		expect(snapshot?.setupFailureSummary?.length ?? 0).toBeLessThanOrEqual(280);
		expect(getText(result)).toContain(`Setup failure: ${snapshot?.setupFailureSummary}`);
		await manager.dispose({ timeoutMs: 100 });
	});
	it("propagates and renders a structured local_buffer_overflow through the full async path (#4618)", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		const marker = "FORGED-MESSAGE-must-not-render";
		const singleResult = {
			aborted: false,
			exitCode: 1,
			localErrorSummary: createLocalErrorSummary("local_buffer_overflow", `cover ${marker} text`, {
				stage: "overflow.staged",
				exceeded: "events",
				stagedEventCount: 10_000,
				stagedBytes: 1_048_576,
				incomingEventBytes: 512,
				maxStagedEvents: 10_000,
				maxStagedBytes: 16 * 1024 * 1024,
			}),
		} satisfies Pick<SingleResult, "aborted" | "exitCode" | "localErrorSummary">;
		const jobId = manager.register(
			"task",
			"launching subagent",
			async () => subagentRunOutcomeFromSingleResult("Subagent failed.", singleResult),
			{
				id: "job-local-overflow",
				ownerId: "0-Main",
				metadata: { subagent: { id: "0-Overflow", agent: "executor", agentSource: "bundled" } },
			},
		);

		await manager.getJob(jobId)?.promise;
		const result = await tool.execute("subagent-overflow", { action: "inspect", ids: ["0-Overflow"] });
		const snapshot = result.details?.subagents[0];

		// Full async propagation: SingleResult -> outcome -> AsyncJob -> snapshot.
		expect(snapshot?.status).toBe("failed");
		expect(snapshot?.localErrorSummary?.kind).toBe("local_buffer_overflow");
		expect(snapshot?.localErrorSummary?.summary).toContain("overflow.staged");
		expect(snapshot?.localErrorSummary?.summary).toContain("10000/10000 events");
		// Free-form message text never reaches the snapshot.
		expect(snapshot?.localErrorSummary?.summary).not.toContain(marker);

		// Tool output names the kind with kind-conditional guidance.
		const text = getText(result);
		expect(text).toContain("Local failure (local_buffer_overflow)");
		expect(text).toContain("staging-buffer limit");

		// Cached renderer path: body renders the summary and the await cache
		// signature participates (rendering twice must not break).
		const theme = await getThemeByName("red-claw");
		if (!theme) throw new Error("Expected test theme");
		const render = (value: SubagentToolDetails) =>
			Bun.stripANSI(
				subagentToolRenderer
					.renderResult(
						{ content: [{ type: "text", text: "" }], details: value },
						{ expanded: true, isPartial: false },
						theme,
					)
					.render(160)
					.join("\n"),
			);
		subagentBodyCacheTestHooks.reset();
		const details = result.details as SubagentToolDetails;
		const rendered1 = render(details);
		expect(rendered1).toContain("Local failure (local_buffer_overflow)");
		expect(rendered1).toContain("overflow.staged");
		expect(rendered1).not.toContain(marker);
		const rendered2 = render(details);
		expect(rendered2).toBe(rendered1);
		await manager.dispose({ timeoutMs: 100 });
	});

	it("pins the full chain with a REAL staged-buffer overflow, including streaming render and width bounding (#4618)", async () => {
		// A genuine overflow tripped by the agent runtime's own staging
		// machinery (single event larger than the byte cap) — not a fabricated
		// terminal shape — driven through the REAL chain: runSubprocess ->
		// SingleResult -> buildTaskReceipt -> outcome -> AsyncJob -> snapshot ->
		// renderer.
		const agent = await runOverflowAgent();
		const terminal = agent.state.messages.at(-1) as AssistantMessage;
		expect(terminal.errorKind).toBe("local_buffer_overflow");
		expect(terminal.bufferOverflow?.exceeded).toBe("bytes");

		const spy = mockCreateAgentSessionWithTerminal(terminal);
		let singleResult: SingleResult;
		try {
			singleResult = (await runSubprocess({
				...runSubprocessBaseOptions,
				id: "0-RealOverflow",
			})) as SingleResult;
		} finally {
			spy.mockRestore();
		}

		// Executor trust boundary: the real producer shape validates and renders
		// real counters instead of the generic "error recorded" preview.
		expect(singleResult.exitCode).toBe(1);
		expect(singleResult.localErrorSummary?.kind).toBe("local_buffer_overflow");
		expect(singleResult.localErrorSummary?.summary).toContain("overflow.preMeasure");
		expect(singleResult.localErrorSummary?.summary).toContain("exceeded=bytes");

		// Receipt construction: the parent-visible preview names the local kind.
		const receipt = buildTaskReceipt(singleResult);
		expect(receipt.status).toBe("failed");
		expect(receipt.preview).toContain("local failure (local_buffer_overflow)");
		expect(receipt.preview).not.toContain("Task failed; error recorded.");

		const manager = createManager();
		const tool = new SubagentTool(createSession());
		const jobId = manager.register(
			"task",
			"launching subagent",
			async () => subagentRunOutcomeFromSingleResult("Subagent failed.", singleResult),
			{
				id: "job-real-overflow",
				ownerId: "0-Main",
				metadata: { subagent: { id: "0-RealOverflow", agent: "planner", agentSource: "bundled" } },
			},
		);
		await manager.getJob(jobId)?.promise;
		const result = await tool.execute("subagent-real-overflow", { action: "inspect", ids: ["0-RealOverflow"] });
		const snapshot = result.details?.subagents[0];
		expect(snapshot?.status).toBe("failed");
		expect(snapshot?.localErrorSummary?.summary).toContain("overflow.preMeasure");
		expect(snapshot?.localErrorSummary?.summary).toContain(`${MANAGED_ATTEMPT_MAX_STAGED_BYTES}`);

		// Streaming/dynamic render (isPartial: true) and terminal cached render
		// both carry the real summary; every rendered line stays within the
		// requested width and contains no raw tabs.
		const theme = await getThemeByName("red-claw");
		if (!theme) throw new Error("Expected test theme");
		const details = result.details as SubagentToolDetails;
		for (const isPartial of [true, false]) {
			const width = 64;
			const rendered = Bun.stripANSI(
				subagentToolRenderer
					.renderResult({ content: [{ type: "text", text: "" }], details }, { expanded: true, isPartial }, theme)
					.render(width)
					.join("\n"),
			);
			expect(rendered).toContain("Local failure (local_buffer_overflow)");
			for (const line of rendered.split("\n")) {
				expect(line).not.toContain("\t");
				expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
			}
		}
		await manager.dispose({ timeoutMs: 100 });
	});

	it("renders local_snapshot_failure with serialization-defect guidance, not staging-limit guidance (#4618)", async () => {
		const theme = await getThemeByName("red-claw");
		if (!theme) throw new Error("Expected test theme");
		const details: SubagentToolDetails = {
			subagents: [
				{
					id: "0-SnapshotFailure",
					jobId: "job-snapshot-failure",
					status: "failed",
					label: "launching subagent",
					agent: "executor",
					agentSource: "bundled",
					durationMs: 1,
					localErrorSummary: { kind: "local_snapshot_failure", summary: "serializer rejected the event" },
				},
			],
		};
		const rendered = Bun.stripANSI(
			subagentToolRenderer
				.renderResult(
					{ content: [{ type: "text", text: "" }], details },
					{ expanded: true, isPartial: false },
					theme,
				)
				.render(160)
				.join("\n"),
		);
		expect(rendered).toContain("Local failure (local_snapshot_failure): serializer rejected the event");
		expect(rendered).toContain("event-serialization defect");
		expect(rendered).toContain("safe to retry");
		expect(rendered).not.toContain("staging-buffer limit");
	});
	it("renders setup failures and invalidates the static body cache when the cause changes", async () => {
		const theme = await getThemeByName("red-claw");
		if (!theme) throw new Error("Expected test theme");
		const details = (setupFailureSummary: string): SubagentToolDetails => ({
			subagents: [
				{
					id: "0-SetupFailure",
					jobId: "job-setup-failure",
					status: "failed",
					label: "launching subagent",
					agent: "executor",
					agentSource: "bundled",
					durationMs: 1,
					setupFailureSummary,
				},
			],
		});
		const render = (value: SubagentToolDetails) =>
			Bun.stripANSI(
				subagentToolRenderer
					.renderResult(
						{ content: [{ type: "text", text: "" }], details: value },
						{ expanded: true, isPartial: false },
						theme,
					)
					.render(160)
					.join("\n"),
			);

		subagentBodyCacheTestHooks.reset();
		expect(render(details("Session setup rejected."))).toContain("Setup failure: Session setup rejected.");
		expect(subagentBodyCacheTestHooks.bodyRenders).toBe(1);
		expect(render(details("Session setup rejected after credentials refresh."))).toContain(
			"Setup failure: Session setup rejected after credentials refresh.",
		);
		expect(subagentBodyCacheTestHooks.bodyRenders).toBe(2);
	});
	it("marks requests only after the real prompt preflight accepts in every run mode", async () => {
		const agent: AgentDefinition = { name: "executor", description: "test", systemPrompt: "test", source: "bundled" };
		const modes = ["initial", "resume", "message"] as const;
		const run = async (runMode: (typeof modes)[number], accept: boolean) => {
			const promptOptions: PromptOptions[] = [];
			const session = {
				agent: { state: { systemPrompt: ["test"] } },
				sessionManager: { appendSessionInit: () => {} },
				extensionRunner: undefined,
				get messages() {
					return [];
				},
				getActiveToolNames: () => ["read", "yield"],
				setActiveToolsByName: async () => {},
				setConfiguredModelChain: () => {},
				seedDefaultFallbackResolution: () => {},
				subscribe: () => () => {},
				prompt: async (_text: string, options?: PromptOptions) => {
					if (options) promptOptions.push(options);
					if (accept) await options?.onPreflightAcceptCommit?.();
					throw new Error(
						accept ? "request failed after acceptance" : "preflight rejected: token=preflight-secret",
					);
				},
				waitForIdle: async () => {},
				getLastAssistantMessage: () => undefined,
				abort: async () => {},
				dispose: async () => {},
			} as unknown as AgentSession;
			const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({ session } as never);
			try {
				const result = await runSubprocess({
					cwd: "/tmp",
					agent,
					task: "do work",
					index: 0,
					id: `0-${runMode}-${accept ? "accepted" : "rejected"}`,
					settings: Settings.isolated(),
					modelRegistry: {
						refresh: async () => {},
						getAvailable: () => [],
						getApiKey: async () => kNoAuth,
					} as never,
					enableLsp: false,
					runMode,
					resumeMessage: "continue",
				});
				expect(promptOptions).toHaveLength(1);
				expect(promptOptions[0]?.onPreflightAccepted).toBeFunction();
				expect(promptOptions[0]?.onPreflightAcceptCommit).toBeFunction();
				return result;
			} finally {
				spy.mockRestore();
			}
		};

		for (const mode of modes) {
			const rejected = await run(mode, false);
			expect(rejected.setupFailure?.summary).toContain("preflight rejected: token=[redacted]");
			const accepted = await run(mode, true);
			expect(accepted.setupFailure).toBeUndefined();
		}
	});
	it("redacts complete authorization header values and query credentials", () => {
		const secrets = [
			"bearer-secret",
			"basic-secret",
			"arbitrary-secret",
			"query-token",
			"query-key",
			"#GJC1_opaque_secret#",
		];
		const summary = createSetupFailureSummary(
			new Error(
				[
					"Request failed",
					"Authorization: Bearer bearer-secret",
					"Authorization: Basic basic-secret",
					"Authorization: Digest arbitrary-secret",
					"GET /callback?access_token=query-token&api_key=query-key",
					"token=[redacted]",
					"credential=#GJC1_opaque_secret#",
					"status=401",
				].join("\n"),
			),
		).summary;

		expect(summary).toBe(
			"Request failed Authorization: [redacted] Authorization: [redacted] Authorization: [redacted] GET /callback?access_token=[redacted]&api_key=[redacted] token=[redacted] credential=[redacted] status=401",
		);
		for (const secret of secrets) expect(summary).not.toContain(secret);
	});
	it("redacts cookies, URL credentials, compound keys, and Unicode-obfuscated secrets within byte bounds", () => {
		const secrets = ["cookie-secret", "url-secret", "client-secret", "unicode-secret"];
		const summary = createSetupFailureSummary(
			new Error(
				`Cookie: session=cookie-secret; theme=dark\nGET https://user:url-secret@example.test/path clientSecret=client-secret to\u200bken=unicode-secret cache_key=ordinary ${"🧪".repeat(400)}`,
			),
		).summary;

		expect(summary).toContain("Cookie: [redacted]");
		expect(summary).toContain("https://[redacted]@example.test/path");
		expect(summary).toContain("clientSecret=[redacted]");
		expect(summary).toContain("token=[redacted]");
		expect(summary).toContain("cache_key=ordinary");
		expect(Buffer.byteLength(summary, "utf8")).toBeLessThanOrEqual(1_024);
		expect(Array.from(summary).length).toBeLessThanOrEqual(281);
		for (const secret of secrets) expect(summary).not.toContain(secret);
	});
	it("redacts underscore-delimited credential names and local paths without hiding prose", () => {
		const secrets = ["github-token-secret", "openai-api-key-secret", "backup-token-secret"];
		const summary = createSetupFailureSummary(
			new Error(
				[
					"GITHUB_TOKEN=github-token-secret",
					"OPENAI_API_KEY=openai-api-key-secret",
					"GITHUB_TOKEN_BACKUP=backup-token-secret",
					"failed opening /var/folders/zz/T/gjc/openai-api-key-secret/session.jsonl",
					"and /opt/gjc/openai-api-key-secret/config.json",
					"plain prose keeps / callback, 1/2, and /single",
					"GET /callback?access_token=query-token&api_key=query-key",
				].join("\n"),
			),
		).summary;

		expect(summary).toBe(
			"GITHUB_TOKEN=[redacted] OPENAI_API_KEY=[redacted] GITHUB_TOKEN_BACKUP=[redacted] failed opening <path>/session.jsonl and <path>/config.json plain prose keeps / callback, 1/2, and /single GET /callback?access_token=[redacted]&api_key=[redacted]",
		);
		for (const secret of secrets) expect(summary).not.toContain(secret);
	});
	it("redacts sensitive path basenames, local file URIs, and control-fragmented credential values", () => {
		const pathSecret = "ghp_PATH_SECRET_DO_NOT_LEAK";
		const valueSecret = "SECRET_SUFFIX_DO_NOT_LEAK";
		const summary = createSetupFailureSummary(
			new Error(
				[
					`wrote /Users/alice/${pathSecret}`,
					`at file:///Users/alice/.config/${valueSecret}`,
					`and file://localhost/private/${valueSecret}`,
					"ordinary /Users/alice/project/config.json and file:///Users/alice/project/report.txt",
					`token=prefix\u001b[31m${valueSecret}`,
					`api_key=prefix\u0000${valueSecret}`,
				].join("\n"),
			),
		).summary;

		expect(summary).toContain("wrote <path>/[redacted]");
		expect(summary).toContain("file://<path>/[redacted]");
		expect(summary).toContain("ordinary <path>/config.json and file://<path>/report.txt");
		expect(summary).toContain("token=[redacted]");
		expect(summary).toContain("api_key=[redacted]");
		expect(summary).not.toContain(pathSecret);
		expect(summary).not.toContain("alice");
		expect(summary).not.toContain(valueSecret);
		expect(summary).not.toContain("prefix");
	});
	it("redacts spaced API-key labels, high-confidence provider tokens, Windows paths, and secret basenames", () => {
		const providerToken = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";
		const summary = createSetupFailureSummary(
			new Error(
				`API key: api-key-secret provider ${providerToken} paths C:\\Users\\Alice\\secrets.json and C:\\work\\report.txt ordinary prose remains visible`,
			),
		).summary;

		expect(summary).toBe(
			"API key: [redacted] provider [redacted] paths <path>/[redacted] and <path>/report.txt ordinary prose remains visible",
		);
		expect(summary).not.toContain("api-key-secret");
		expect(summary).not.toContain(providerToken);
	});
	it("prioritizes a setup failure in receipt delivery over a model substitution warning", () => {
		const receipt = buildTaskReceipt({
			index: 0,
			id: "0-SetupFailure",
			agent: "executor",
			agentSource: "bundled",
			task: "start",
			exitCode: 1,
			output: "",
			stderr: "",
			truncated: false,
			durationMs: 0,
			tokens: 0,
			setupFailure: { summary: "Credential bootstrap rejected." },
			modelSubstitutionWarning: {
				requested: "openai-codex/gpt-5.3-codex",
				effective: "openai-codex/gpt-5.5",
				reason: "auth_unavailable",
			},
		} satisfies SingleResult);

		expect(receipt.preview).toBe("Task failed during setup: Credential bootstrap rejected.");
	});
	it("maps initial and resumed producer failures identically without exposing post-request causes", () => {
		const setupFailure = createSetupFailureSummary(new Error("Session initialization failed: token=secret"));
		const preRequestFailure = {
			aborted: false,
			exitCode: 1,
			setupFailure,
		} satisfies Pick<SingleResult, "aborted" | "exitCode" | "setupFailure">;

		const initial = subagentRunOutcomeFromSingleResult("Subagent failed.", preRequestFailure);
		const resumed = subagentRunOutcomeFromSingleResult("Subagent failed.", preRequestFailure);
		const postRequest = subagentRunOutcomeFromSingleResult("Subagent failed.", {
			aborted: false,
			exitCode: 1,
		});

		expect(initial).toEqual({
			kind: "failed",
			text: "Subagent failed.",
			setupFailureSummary: "Session initialization failed: token=[redacted]",
		});
		expect(resumed).toEqual(initial);
		expect(postRequest).toEqual({ kind: "failed", text: "Subagent failed." });
	});

	it("maps an exit-zero merge_failed receipt to a failed async job outcome", () => {
		expect(
			subagentRunOutcomeFromSingleResult("Recovery required.", {
				aborted: false,
				exitCode: 0,
				status: "merge_failed",
			}),
		).toEqual({ kind: "failed", text: "Recovery required." });
	});

	it("maps a missing task receipt to a failed async job outcome", () => {
		expect(subagentRunOutcomeFromSingleResult("Task result unavailable.", undefined)).toEqual({
			kind: "failed",
			text: "Task result unavailable.",
		});
	});

	it("consumes a watched completion before unwatch can redeliver it", async () => {
		const delivered: string[] = [];
		const manager = new AsyncJobManager({
			onJobComplete: async jobId => {
				delivered.push(jobId);
			},
			retentionMs: 10_000,
		});
		AsyncJobManager.setInstance(manager);
		const tool = new SubagentTool(createSession());
		const gate = Promise.withResolvers<string>();
		manager.register("task", "live completion", async () => gate.promise, {
			id: "job-live-completion",
			ownerId: "0-Main",
			metadata: {
				subagent: {
					id: "0-LiveCompletion",
					agent: "executor",
					agentSource: "bundled",
					description: "live completion",
					assignment: "Complete while watched.",
				},
			},
		});
		setTimeout(() => gate.resolve("completed while watched"), 5);

		const result = await tool.execute("subagent-await-live-completion", {
			action: "await",
			ids: ["0-LiveCompletion"],
			timeout_ms: 100,
		});
		await Bun.sleep(10);

		expect(result.details?.awaitOutcome).toBe("completed");
		expect(result.details?.subagents[0]?.resultText).toContain("completed while watched");
		expect(delivered).toEqual([]);
		await manager.dispose({ timeoutMs: 100 });
	});

	it("ends a live await when user steering arrives and leaves the child running", async () => {
		const manager = createManager();
		let steeringResolve: (() => void) | undefined;
		const toolSession = {
			...createSession(),
			waitForUserSteering: (signal: AbortSignal) => {
				const steering = Promise.withResolvers<number | undefined>();
				const onAbort = () => steering.resolve(undefined);
				steeringResolve = () => steering.resolve(1);
				if (signal.aborted) steering.resolve(undefined);
				else signal.addEventListener("abort", onAbort, { once: true });
				return steering.promise;
			},
		} as ToolSession;
		const tool = new SubagentTool(toolSession);
		const child = Promise.withResolvers<string>();
		const jobId = manager.register("task", "steer-interruptible subagent", async () => child.promise, {
			id: "job-steer-wait",
			ownerId: "0-Main",
			metadata: { subagent: { id: "0-SteerWait", agent: "executor", agentSource: "bundled" } },
		});

		const awaiting = tool.execute("subagent-await-steer", {
			action: "await",
			ids: ["0-SteerWait"],
			timeout_ms: 1_500,
		});
		const deadline = Date.now() + 1_000;
		while (!steeringResolve) {
			if (Date.now() >= deadline) throw new Error("await never registered the steering waiter");
			await Bun.sleep(2);
		}
		steeringResolve();
		const receipt = await awaiting;

		expect(receipt.details?.awaitOutcome).toBe("interrupted");
		expect(receipt.details?.subagents[0]?.status).toBe("running");
		expect(manager.getJob(jobId)?.status).toBe("running");

		child.resolve("child finished after the user steer");
		await manager.getJob(jobId)?.promise;
		expect(manager.getJob(jobId)?.status).toBe("completed");
		await manager.dispose({ timeoutMs: 100 });
	});

	it("interrupts only a live parent await and leaves the child running", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		const acknowledgeDeliveries = vi.spyOn(manager, "acknowledgeDeliveries");
		const child = Promise.withResolvers<string>();
		const jobId = manager.register("task", "interruptible subagent", async () => child.promise, {
			id: "job-interruptible",
			ownerId: "0-Main",
			metadata: { subagent: { id: "0-Interruptible", agent: "executor", agentSource: "bundled" } },
		});
		const terminalJobId = manager.register("task", "already complete subagent", async () => "already complete", {
			id: "job-already-complete",
			ownerId: "0-Main",
			metadata: { subagent: { id: "0-AlreadyComplete", agent: "executor", agentSource: "bundled" } },
		});
		await manager.getJob(terminalJobId)?.promise;

		const controller = new AbortController();
		const awaiting = tool.execute(
			"subagent-await-interrupt",
			{ action: "await", ids: ["0-Interruptible", "0-AlreadyComplete"], timeout_ms: 10_000 },

			controller.signal,
		);
		controller.abort();
		const receipt = await awaiting;

		expect(receipt.details?.awaitOutcome).toBe("interrupted");
		expect(receipt.details?.interrupted).toBe(true);
		expect(receipt.details?.subagents[0]?.status).toBe("running");
		expect(receipt.details?.subagents[0]?.guidance).toContain("continues");
		expect(receipt.details?.subagents.find(snapshot => snapshot.id === "0-AlreadyComplete")?.status).toBe(
			"completed",
		);
		expect(
			receipt.details?.subagents.find(snapshot => snapshot.id === "0-AlreadyComplete")?.guidance,
		).toBeUndefined();
		expect(getText(receipt)).toContain("Subagent await interrupted");
		expect(manager.getJob(jobId)?.status).toBe("running");
		expect(acknowledgeDeliveries).not.toHaveBeenCalled();

		child.resolve("child finished after parent interruption");
		await manager.getJob(jobId)?.promise;
		expect(manager.getJob(jobId)?.status).toBe("completed");
		await manager.dispose({ timeoutMs: 100 });
	});

	it("treats pre-aborted live awaits as interrupted but terminal-only awaits as ordinary", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		const child = Promise.withResolvers<string>();
		const liveJobId = manager.register("task", "live subagent", async () => child.promise, {
			id: "job-pre-aborted-live",
			ownerId: "0-Main",
			metadata: { subagent: { id: "0-PreAbortedLive", agent: "executor", agentSource: "bundled" } },
		});
		const terminalJobId = manager.register("task", "terminal subagent", async () => "done", {
			id: "job-pre-aborted-terminal",
			ownerId: "0-Main",
			metadata: { subagent: { id: "0-PreAbortedTerminal", agent: "executor", agentSource: "bundled" } },
		});
		await manager.getJob(terminalJobId)?.promise;
		const controller = new AbortController();
		controller.abort();

		const live = await tool.execute(
			"subagent-await-pre-aborted-live",
			{ action: "await", ids: ["0-PreAbortedLive"], timeout_ms: 10_000 },
			controller.signal,
		);
		const terminal = await tool.execute(
			"subagent-await-pre-aborted-terminal",
			{ action: "await", ids: ["0-PreAbortedTerminal"], timeout_ms: 10_000 },
			controller.signal,
		);

		expect(live.details?.awaitOutcome).toBe("interrupted");
		expect(live.details?.interrupted).toBe(true);
		expect(manager.getJob(liveJobId)?.status).toBe("running");
		expect(terminal.details?.awaitOutcome).toBeUndefined();
		expect(terminal.details?.interrupted).toBeUndefined();

		child.resolve("done");
		await manager.getJob(liveJobId)?.promise;
		await manager.dispose({ timeoutMs: 100 });
	});

	it("uses the final stable-id snapshot when completion wins the await race", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		const child = Promise.withResolvers<string>();
		const jobId = manager.register("task", "race subagent", async () => child.promise, {
			id: "job-race",
			ownerId: "0-Main",
			metadata: { subagent: { id: "0-Race", agent: "executor", agentSource: "bundled" } },
		});
		const controller = new AbortController();
		const awaiting = tool.execute(
			"subagent-await-race",
			{ action: "await", ids: ["0-Race"], timeout_ms: 10_000 },
			controller.signal,
		);
		child.resolve("final result");
		await manager.getJob(jobId)?.promise;
		const receipt = await awaiting;
		controller.abort();

		expect(receipt.details?.awaitOutcome).toBe("completed");
		expect(receipt.details?.interrupted).toBeUndefined();
		expect(receipt.details?.subagents[0]?.status).toBe("completed");
		expect(receipt.details?.subagents[0]?.resultText).toContain("final result");
		await manager.dispose({ timeoutMs: 100 });
	});

	it("accepts terminal wait conditions and heartbeat bounds while retaining child status on timeout", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		const gate = Promise.withResolvers<string>();
		const jobId = manager.register("task", "heartbeat child", async () => gate.promise, {
			id: "job-heartbeat-bounds",
			ownerId: "0-Main",
			metadata: { subagent: { id: "0-HeartbeatBounds", agent: "executor", agentSource: "bundled" } },
		});
		const updates: unknown[] = [];
		const timedOut = await tool.execute(
			"await-heartbeat-bounds",
			{ action: "await", ids: ["0-HeartbeatBounds"], condition: "any_terminal", heartbeat_ms: 0, timeout_ms: 1 },
			undefined,
			update => updates.push(update),
		);
		expect(timedOut.details?.condition).toBe("any_terminal");
		expect(timedOut.details?.awaitOutcome).toBe("timed_out");
		expect(manager.getJob(jobId)?.status).toBe("running");
		expect(updates).toHaveLength(1);
		gate.resolve("done");
		await manager.getJob(jobId)?.promise;
		await manager.dispose({ timeoutMs: 100 });
	});

	it("await timeout is non-terminal and guides continued observation instead of shutdown", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		manager.register(
			"task",
			"slow subagent",
			async () => {
				await Bun.sleep(60);
				return "slow result";
			},
			{
				id: "job-slow",
				ownerId: "0-Main",
				metadata: {
					subagent: {
						id: "0-Slow",
						agent: "executor",
						agentSource: "bundled",
						description: "slow task",
						assignment: "Keep working slowly.",
					},
				},
			},
		);

		const result = await tool.execute("subagent-await-timeout", {
			action: "await",
			ids: ["0-Slow"],
			timeout_ms: 1,
		});
		const guidance = result.details?.subagents[0]?.guidance ?? "";

		expect(result.details?.subagents[0]?.status).toBe("running");
		expect(result.details?.awaitOutcome).toBe("timed_out");
		expect(result.details?.interrupted).toBeUndefined();
		expect(guidance).toContain("Still running");
		expect(guidance).toContain("not a failure");
		expect(guidance).toContain("never cancel just because an await timed out");
		expect(guidance).toContain("cancel only if the subagent has actually failed");
		expect(guidance).not.toContain("steer");
		expect(guidance).not.toContain("shutdown");

		await Bun.sleep(80);
		const completed = await tool.execute("subagent-await-completed", {
			action: "await",
			ids: ["0-Slow"],
			timeout_ms: 100,
		});

		expect(completed.details?.subagents[0]?.status).toBe("completed");
		expect(completed.details?.subagents[0]?.resultText).toContain("slow result");
		expect(manager.getJob("job-slow")?.status).toBe("completed");
		await manager.dispose({ timeoutMs: 100 });
	});

	it("cancel stops a selected known-bad running subagent by subagent id", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		manager.register(
			"task",
			"known-bad cancel subagent",
			async ({ signal }) => {
				while (!signal.aborted) await Bun.sleep(5);
				throw new Error("cancelled");
			},
			{
				id: "job-cancel",
				ownerId: "0-Main",
				metadata: {
					subagent: {
						id: "0-Cancel",
						agent: "executor",
						agentSource: "bundled",
					},
				},
			},
		);

		const result = await tool.execute("subagent-cancel", { action: "cancel", ids: ["0-Cancel"] });

		expect(result.details?.subagents[0]?.status).toBe("cancelled");
		expect(manager.getJob("job-cancel")?.status).toBe("cancelled");
		await manager.dispose({ timeoutMs: 100 });
	});

	it("pause requests a running registered subagent and returns a running snapshot", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		let pauseRequested = false;
		manager.registerSubagentRecord({
			subagentId: "0-Pause",
			ownerId: "0-Main",
			currentJobId: null,
			historicalJobIds: [],
			status: "running",
			sessionFile: "/tmp/0-Pause.jsonl",
			resumable: true,
		});
		manager.registerLiveHandle("0-Pause", {
			requestPause() {
				pauseRequested = true;
			},
			async injectMessage() {},
		});

		const result = await tool.execute("subagent-pause", { action: "pause", ids: ["0-Pause"] });

		expect(pauseRequested).toBe(true);
		expect(result.details?.subagents[0]?.status).toBe("running");
		expect(getText(result)).toContain("0-Pause");
		await manager.dispose({ timeoutMs: 100 });
	});

	it("resume starts a paused subagent through the manager runner", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		manager.setResumeRunner(subagentId =>
			manager.register("task", subagentId, async () => "resumed", {
				id: "job-resumed",
				ownerId: "0-Main",
				metadata: { subagent: { id: subagentId, agent: "executor", agentSource: "bundled" } },
			}),
		);
		manager.registerSubagentRecord({
			subagentId: "0-Resume",
			ownerId: "0-Main",
			currentJobId: "job-paused",
			historicalJobIds: [],
			status: "paused",
			sessionFile: "/tmp/0-Resume.jsonl",
			resumable: true,
		});

		const result = await tool.execute("subagent-resume", { action: "resume", ids: ["0-Resume"] });

		expect(result.details?.subagents[0]?.status).toBe("running");
		expect(result.details?.subagents[0]?.jobId).toBe("job-resumed");
		await manager.dispose({ timeoutMs: 100 });
	});

	it("resume surfaces a manager failure reason instead of returning the stale terminal record", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		// Terminal, resumable record with a session file but NO resume runner:
		// resumeSubagent() returns { ok: false, reason: "no_runner" }. The resume
		// action must surface that reason, not silently return the stale record
		// (which made ralplan believe the Planner had resumed when it had not).
		manager.registerSubagentRecord({
			subagentId: "0-NoRunner",
			ownerId: "0-Main",
			currentJobId: null,
			historicalJobIds: [],
			status: "completed",
			sessionFile: "/tmp/0-NoRunner.jsonl",
			resumable: true,
		});

		await expect(
			tool.execute("subagent-resume", { action: "resume", id: "0-NoRunner", message: "revision pass" }),
		).rejects.toThrow("no_runner");
		await manager.dispose({ timeoutMs: 100 });
	});

	it("resume surfaces resume_failed when the runner yields no job", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		manager.setResumeRunner(() => undefined);
		manager.registerSubagentRecord({
			subagentId: "0-ResumeFailed",
			ownerId: "0-Main",
			currentJobId: null,
			historicalJobIds: [],
			status: "completed",
			sessionFile: "/tmp/0-ResumeFailed.jsonl",
			resumable: true,
		});

		await expect(
			tool.execute("subagent-resume", { action: "resume", id: "0-ResumeFailed", message: "revision pass" }),
		).rejects.toThrow("resume_failed");
		await manager.dispose({ timeoutMs: 100 });
	});

	it("resume accepts id and rejects multi-id message broadcast", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		const resumed: string[] = [];
		manager.setResumeRunner(subagentId => {
			resumed.push(subagentId);
			return manager.register("task", subagentId, async () => "resumed", {
				id: `job-${subagentId}`,
				ownerId: "0-Main",
				metadata: { subagent: { id: subagentId, agent: "executor", agentSource: "bundled" } },
			});
		});
		for (const subagentId of ["0-ResumeA", "0-ResumeB"]) {
			manager.registerSubagentRecord({
				subagentId,
				ownerId: "0-Main",
				currentJobId: null,
				historicalJobIds: [],
				status: "paused",
				sessionFile: `/tmp/${subagentId}.jsonl`,
				resumable: true,
			});
		}

		await expect(
			tool.execute("subagent-resume-broadcast", {
				action: "resume",
				ids: ["0-ResumeA", "0-ResumeB"],
				message: "resume only one",
			}),
		).rejects.toThrow("accepts exactly one target");
		expect(resumed).toEqual([]);

		const result = await tool.execute("subagent-resume-id", { action: "resume", id: "0-ResumeA" });

		expect(resumed).toEqual(["0-ResumeA"]);
		expect(result.details?.subagents[0]?.status).toBe("running");
		expect(result.details?.subagents[0]?.jobId).toBe("job-0-ResumeA");
		await manager.dispose({ timeoutMs: 100 });
	});

	it("steer running injects a message and optionally requests pause", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		let injected: string | undefined;
		let injectedFrom: string | undefined;
		let pauseRequested = false;
		manager.registerSubagentRecord({
			subagentId: "0-Steer",
			ownerId: "0-Main",
			currentJobId: null,
			historicalJobIds: [],
			status: "running",
			sessionFile: "/tmp/0-Steer.jsonl",
			resumable: true,
		});
		manager.registerLiveHandle("0-Steer", {
			requestPause() {
				pauseRequested = true;
			},
			async injectMessage(content, _deliverAs, opts) {
				injected = content;
				injectedFrom = opts?.fromAgentId;
			},
		});

		const result = await tool.execute("subagent-steer", {
			action: "steer",
			ids: ["0-Steer"],
			message: "tighten scope",
			pause: true,
		});

		expect(injected).toBe("tighten scope");
		expect(injectedFrom).toBe("0-Main");
		expect(pauseRequested).toBe(true);
		const steerSnap = result.details?.subagents[0];
		expect(steerSnap?.status).toBe("running");
		expect(steerSnap?.steerMessage).toBe("tighten scope");
		expect(steerSnap?.steerState).toBe("queued");
		expect(steerSnap?.steerPauseRequested).toBe(true);
		const steerText = getText(result).toLowerCase();
		expect(steerText).toContain("tighten scope");
		expect(steerText).toContain("queued");
		expect(steerText).not.toContain("consumed");
		expect(steerText).not.toContain("acted on");
		await manager.dispose({ timeoutMs: 100 });
	});
	it("steer running injects through the live handle even when the record has no session file (regression)", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		let injected: string | undefined;
		// The task tool registers SubagentRecords with sessionFile: null
		// (subtask session files are carried by the resume descriptor), so the
		// steer path must not demand record.sessionFile for a running subagent.
		manager.registerSubagentRecord({
			subagentId: "0-SteerNoSession",
			ownerId: "0-Main",
			currentJobId: null,
			historicalJobIds: [],
			status: "running",
			sessionFile: null,
			resumable: true,
		});
		manager.registerLiveHandle("0-SteerNoSession", {
			requestPause() {},
			async injectMessage(content) {
				injected = content;
			},
		});

		const result = await tool.execute("subagent-steer-no-session", {
			action: "steer",
			id: "0-SteerNoSession",
			message: "course correction",
		});

		expect(injected).toBe("course correction");
		expect(result.details?.subagents[0]?.steerMessage).toBe("course correction");
		expect(result.details?.subagents[0]?.steerState).toBe("queued");
		await manager.dispose({ timeoutMs: 100 });
	});

	it("steer attributes the caller (nested parent) id, not main or the child id", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession("1-Parent"));
		let injectedFrom: string | undefined;
		manager.registerSubagentRecord({
			subagentId: "2-Child",
			ownerId: "1-Parent",
			currentJobId: null,
			historicalJobIds: [],
			status: "running",
			sessionFile: "/tmp/2-Child.jsonl",
			resumable: true,
		});
		manager.registerLiveHandle("2-Child", {
			requestPause() {},
			async injectMessage(_content, _deliverAs, opts) {
				injectedFrom = opts?.fromAgentId;
			},
		});

		await tool.execute("subagent-steer-nested", {
			action: "steer",
			ids: ["2-Child"],
			message: "nested steer",
		});

		expect(injectedFrom).toBe("1-Parent");
		expect(injectedFrom).not.toBe("0-Main");
		expect(injectedFrom).not.toBe("2-Child");
		await manager.dispose({ timeoutMs: 100 });
	});

	it("steer accepts id and rejects multi-id message broadcast", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		const injected: string[] = [];
		for (const subagentId of ["0-SteerA", "0-SteerB"]) {
			manager.registerSubagentRecord({
				subagentId,
				ownerId: "0-Main",
				currentJobId: null,
				historicalJobIds: [],
				status: "running",
				sessionFile: `/tmp/${subagentId}.jsonl`,
				resumable: true,
			});
			manager.registerLiveHandle(subagentId, {
				requestPause() {},
				async injectMessage(content) {
					injected.push(`${subagentId}:${content}`);
				},
			});
		}

		await expect(
			tool.execute("subagent-steer-broadcast", {
				action: "steer",
				ids: ["0-SteerA", "0-SteerB"],
				message: "steer only one",
			}),
		).rejects.toThrow("accepts exactly one target");
		expect(injected).toEqual([]);

		const result = await tool.execute("subagent-steer-id", {
			action: "steer",
			id: "0-SteerA",
			message: "steer one",
		});

		expect(injected).toEqual(["0-SteerA:steer one"]);
		expect(result.details?.subagents[0]?.status).toBe("running");
		await manager.dispose({ timeoutMs: 100 });
	});

	it("steer non-active auto-resumes with message and ignores pause flag", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		let resumedMessage: string | undefined;
		manager.setResumeRunner((subagentId, message) => {
			resumedMessage = message;
			return manager.register("task", subagentId, async () => "resumed", {
				id: "job-auto-resumed",
				ownerId: "0-Main",
				metadata: { subagent: { id: subagentId, agent: "executor", agentSource: "bundled" } },
			});
		});
		manager.registerSubagentRecord({
			subagentId: "0-Auto",
			ownerId: "0-Main",
			currentJobId: "job-completed",
			historicalJobIds: [],
			status: "completed",
			sessionFile: "/tmp/0-Auto.jsonl",
			resumable: true,
		});

		const result = await tool.execute("subagent-steer-auto", {
			action: "steer",
			ids: ["0-Auto"],
			message: "follow up",
			pause: true,
		});

		expect(resumedMessage).toBe("follow up");
		expect(result.details?.subagents[0]?.status).toBe("running");
		expect(result.details?.subagents[0]?.jobId).toBe("job-auto-resumed");
		expect(result.details?.subagents[0]?.steerMessage).toBe("follow up");
		expect(result.details?.subagents[0]?.steerState).toBe("resume_started");
		await manager.dispose({ timeoutMs: 100 });
	});

	it("steer a queued subagent labels steerState resume_queued", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		manager.registerSubagentRecord({
			subagentId: "0-Queued",
			ownerId: "0-Main",
			currentJobId: null,
			historicalJobIds: [],
			status: "queued",
			sessionFile: "/tmp/0-Queued.jsonl",
			resumable: true,
			queued: { ownerId: "0-Main", seq: 1, createdAt: Date.now() },
		});

		const result = await tool.execute("subagent-steer-queued", {
			action: "steer",
			ids: ["0-Queued"],
			message: "requeue",
		});

		expect(result.details?.subagents[0]?.steerState).toBe("resume_queued");
		expect(result.details?.subagents[0]?.steerMessage).toBe("requeue");
		await manager.dispose({ timeoutMs: 100 });
	});

	it("steer throws ToolError when a non-running resume fails (no runner)", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		manager.registerSubagentRecord({
			subagentId: "0-NoRunner",
			ownerId: "0-Main",
			currentJobId: "job-done",
			historicalJobIds: [],
			status: "completed",
			sessionFile: "/tmp/0-NoRunner.jsonl",
			resumable: true,
		});

		await expect(
			tool.execute("subagent-steer-norunner", {
				action: "steer",
				ids: ["0-NoRunner"],
				message: "go",
			}),
		).rejects.toThrow("no_runner");
		await manager.dispose({ timeoutMs: 100 });
	});
	describe("subagent preview byte caps", () => {
		it("keeps cap-1 and exact multibyte payloads unchanged and caps cap+1 payloads per tier", () => {
			for (const tier of PREVIEW_TIERS) {
				for (const size of [tier.bytes - 1, tier.bytes]) {
					const input = multibytePayload(size);
					expect(capCodePointsAndBytes(input, tier.bytes + 1, tier.bytes), tier.name).toBe(input);
				}

				const capped = capCodePointsAndBytes(multibytePayload(tier.bytes + 1), tier.bytes + 1, tier.bytes);
				expect(capped, tier.name).toEndWith("…");
				expect(
					[...capped].filter(codePoint => codePoint === "…"),
					tier.name,
				).toHaveLength(1);
				expect(Buffer.byteLength(capped), tier.name).toBeLessThanOrEqual(tier.bytes);
			}
		});

		it("caps output previews and sanitized fields after width truncation", async () => {
			for (const tier of PREVIEW_TIERS) {
				const snapshot = await inspectCompletedSubagent(multibytePayload(tier.bytes + 1), tier.verbosity);
				expect(snapshot.resultPreview, tier.name).toEndWith("…");
				expect(snapshot.truncated, tier.name).toBe(true);
				expect(Buffer.byteLength(snapshot.resultPreview ?? ""), tier.name).toBeLessThanOrEqual(tier.bytes);
				expect(Buffer.byteLength(snapshot.label), "receipt label").toBeLessThanOrEqual(1_024);
				if (tier.verbosity === "full") {
					expect(Buffer.byteLength(snapshot.assignment ?? ""), tier.name).toBeLessThanOrEqual(49_152);
				}
			}
		});

		it("collapses an existing truncation ellipsis before applying its own marker", () => {
			const capped = capCodePointsAndBytes(`${"a".repeat(1_023)}……`, 2_000, 1_024);
			expect(capped).toEndWith("…");
			expect([...capped].filter(codePoint => codePoint === "…")).toHaveLength(1);
			expect(Buffer.byteLength(capped)).toBeLessThanOrEqual(1_024);
		});

		it("handles zero-width and combining-mark boundary payloads without double ellipses", async () => {
			for (const character of ["\u200b", "\u0301"]) {
				for (const tier of PREVIEW_TIERS) {
					// Exercise cap-1/cap/cap+1 byte budgets directly with a pure payload.
					for (const byteBudget of [tier.bytes - 1, tier.bytes, tier.bytes + 1]) {
						const input = character.repeat(tier.bytes * 2);
						const capped = capCodePointsAndBytes(input, Number.MAX_SAFE_INTEGER, byteBudget);
						expect(Buffer.byteLength(capped), `${character} ${tier.name} ${byteBudget}`).toBeLessThanOrEqual(
							byteBudget,
						);
						expect(capped, `${character} ${tier.name} ${byteBudget}`).toEndWith("…");
						expect(
							[...capped].filter(codePoint => codePoint === "…"),
							`${character} ${tier.name} ${byteBudget}`,
						).toHaveLength(1);
					}

					// previewJobOutput runs after truncateToWidth for every verbosity tier.
					const snapshot = await inspectCompletedSubagent(character.repeat(tier.codePoints + 1), tier.verbosity);
					const preview = snapshot.resultPreview ?? "";
					expect(Buffer.byteLength(preview), `${character} ${tier.name} preview`).toBeLessThanOrEqual(tier.bytes);
					expect(preview, `${character} ${tier.name} preview`).toEndWith("…");
					expect(
						[...preview].filter(codePoint => codePoint === "…"),
						`${character} ${tier.name} preview`,
					).toHaveLength(1);
					// sanitizeText is used for every snapshot label and for full assignments.
					expect(Buffer.byteLength(snapshot.label), `${character} ${tier.name} label`).toBeLessThanOrEqual(1_024);
					expect(snapshot.label, `${character} ${tier.name} label`).toEndWith("…");
					expect(
						[...snapshot.label].filter(codePoint => codePoint === "…"),
						`${character} ${tier.name} label`,
					).toHaveLength(1);
					if (tier.verbosity === "full") {
						const assignment = snapshot.assignment ?? "";
						expect(Buffer.byteLength(assignment), `${character} full assignment`).toBeLessThanOrEqual(tier.bytes);
						expect(assignment, `${character} full assignment`).toEndWith("…");
						expect(
							[...assignment].filter(codePoint => codePoint === "…"),
							`${character} full assignment`,
						).toHaveLength(1);
					}
				}
			}
		});
	});

	it("list and inspect default terminal subagents return receipt previews without bulk output and no unverified ref", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		const leak = "LEAK_SENTINEL_DO_NOT_DIGEST";
		const bulk = `${"a".repeat(300)}${leak}${"b".repeat(64 * 1024)}`;
		const jobId = manager.register("task", "leaky subagent", async () => bulk, {
			id: "0-Leaky",
			ownerId: "0-Main",
			metadata: { subagent: { id: "0-Leaky", agent: "executor", agentSource: "bundled" } },
		});
		manager.registerSubagentRecord({
			subagentId: "0-Leaky",
			ownerId: "0-Main",
			currentJobId: jobId,
			historicalJobIds: [],
			status: "running",
			sessionFile: "/tmp/0-Leaky.jsonl",
			resumable: true,
		});
		await manager.getJob(jobId)?.promise;

		const listed = await tool.execute("subagent-list-leak", { action: "list" });
		const inspected = await tool.execute("subagent-inspect-leak", { action: "inspect", ids: ["0-Leaky"] });

		for (const result of [listed, inspected]) {
			const snapshot = result.details?.subagents[0];
			expect(snapshot?.resultPreview?.length ?? 0).toBeLessThanOrEqual(281);
			expect(snapshot?.resultText).toBe(snapshot?.resultPreview);
			expect(snapshot?.outputRef).toBeUndefined();
			expect(snapshot?.truncated).toBe(true);
			expect(getText(result)).not.toContain(leak);
			expect(getText(result).length).toBeLessThan(2_000);
		}
		await manager.dispose({ timeoutMs: 100 });
	});

	it("supports preview and explicit full verbosity bounds without unverified refs", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		const bulk = "x".repeat(5_000);
		const jobId = manager.register("task", "verbose subagent", async () => bulk, {
			id: "0-Verbose",
			ownerId: "0-Main",
			metadata: { subagent: { id: "0-Verbose", agent: "executor", agentSource: "bundled" } },
		});
		manager.registerSubagentRecord({
			subagentId: "0-Verbose",
			ownerId: "0-Main",
			currentJobId: jobId,
			historicalJobIds: [],
			status: "running",
			sessionFile: "/tmp/0-Verbose.jsonl",
			resumable: true,
		});
		await manager.getJob(jobId)?.promise;

		const preview = await tool.execute("subagent-preview", {
			action: "inspect",
			ids: ["0-Verbose"],
			verbosity: "preview",
		});
		expect(preview.details?.subagents[0]?.resultPreview?.length ?? 0).toBeLessThanOrEqual(2_001);
		expect(preview.details?.subagents[0]?.truncated).toBe(true);

		await expect(tool.execute("subagent-full-bare", { action: "inspect", verbosity: "full" })).rejects.toThrow(
			"requires explicit `ids`",
		);
		await expect(
			tool.execute("subagent-full-list", { action: "list", ids: ["0-Verbose"], verbosity: "full" }),
		).rejects.toThrow("cannot be used with `list`");

		const full = await tool.execute("subagent-full", {
			action: "inspect",
			ids: ["0-Verbose"],
			verbosity: "full",
		});
		expect(full.details?.subagents[0]?.resultPreview?.length).toBe(5_000);
		expect(full.details?.subagents[0]?.outputRef).toBeUndefined();
		await manager.dispose({ timeoutMs: 100 });
	});

	it("await default returns bounded preview with output ref instead of full retained text", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		const leak = "LEAK_SENTINEL_DO_NOT_DIGEST";
		const bulk = `${"a".repeat(300)}${leak}${"b".repeat(64 * 1024)}`;
		const jobId = manager.register("task", "await leaky subagent", async () => bulk, {
			id: "0-AwaitLeaky",
			ownerId: "0-Main",
			metadata: { subagent: { id: "0-AwaitLeaky", agent: "executor", agentSource: "bundled" } },
		});
		manager.registerSubagentRecord({
			subagentId: "0-AwaitLeaky",
			ownerId: "0-Main",
			currentJobId: jobId,
			historicalJobIds: [],
			status: "running",
			sessionFile: "/tmp/0-AwaitLeaky.jsonl",
			resumable: true,
		});

		const result = await tool.execute("subagent-await-leak", {
			action: "await",
			ids: ["0-AwaitLeaky"],
			timeout_ms: 100,
		});

		const snapshot = result.details?.subagents[0];
		expect(snapshot?.resultPreview?.length ?? 0).toBeLessThanOrEqual(281);
		expect(snapshot?.outputRef).toBeUndefined();
		expect(snapshot?.truncated).toBe(true);
		expect(getText(result)).not.toContain(leak);
		await manager.dispose({ timeoutMs: 100 });
	});

	it("includes output ref only when an agent output sidecar exists in the subagent artifact dir", async () => {
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-output-ref-"));
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		const jobId = manager.register("task", "artifact-backed subagent", async () => "artifact backed result", {
			id: "0-ArtifactBacked",
			ownerId: "0-Main",
			metadata: { subagent: { id: "0-ArtifactBacked", agent: "executor", agentSource: "bundled" } },
		});
		manager.registerSubagentRecord({
			subagentId: "0-ArtifactBacked",
			ownerId: "0-Main",
			currentJobId: jobId,
			historicalJobIds: [],
			status: "running",
			sessionFile: path.join(artifactsDir, "0-ArtifactBacked.jsonl"),
			resumable: true,
		});
		await manager.getJob(jobId)?.promise;
		await Bun.write(path.join(artifactsDir, "0-ArtifactBacked.md"), "artifact backed result");
		await Bun.write(path.join(artifactsDir, "0-ArtifactBacked.md.meta.json"), "{}");

		const result = await tool.execute("subagent-artifact-backed", {
			action: "inspect",
			ids: ["0-ArtifactBacked"],
		});

		expect(result.details?.subagents[0]?.outputRef).toBe("agent://0-ArtifactBacked");
		expect(getText(result)).toContain("Output: agent://0-ArtifactBacked");
		await manager.dispose({ timeoutMs: 100 });
		await fs.rm(artifactsDir, { recursive: true, force: true });
	});

	it("freezes durationMs once a subagent completes instead of counting forever", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		const jobId = manager.register("task", "quick subagent", async () => "done", {
			id: "job-frozen",
			ownerId: "0-Main",
			metadata: {
				subagent: { id: "0-Frozen", agent: "executor", agentSource: "bundled" },
			},
		});
		await manager.getJob(jobId)?.promise;

		const first = await tool.execute("subagent-list", { action: "list" });
		const d1 = first.details?.subagents[0]?.durationMs ?? -1;
		expect(first.details?.subagents[0]?.status).toBe("completed");

		await Bun.sleep(40);
		const second = await tool.execute("subagent-list", { action: "list" });
		const d2 = second.details?.subagents[0]?.durationMs ?? -1;

		// Duration is frozen at completion, so it must not grow on a later read.
		expect(d2).toBe(d1);
		await manager.dispose({ timeoutMs: 100 });
	});
});

describe("await liveness (#4465)", () => {
	it("force-re-emits an update when the liveness interval elapses even if the signature is stable", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		const gate = Promise.withResolvers<string>();
		manager.register("task", "long silent subagent", async () => gate.promise, {
			id: "job-liveness",
			ownerId: "0-Main",
			metadata: {
				subagent: {
					id: "0-Liveness",
					agent: "executor",
					agentSource: "bundled",
					description: "stable",
				},
			},
		});

		// Virtual clock: starts at 0, advances manually between ticks.
		let clock = 0;
		const restore = tool.withLivenessClock(() => clock);

		const updates: unknown[] = [];
		// heartbeat_ms=100 → liveness interval = max(15000, 100*30) = 15000.
		// The real timer ticks every 100ms; the virtual clock controls the
		// liveness decision, so a 15s liveness interval is exercised in ~200ms.
		const awaiting = tool.execute(
			"await-liveness",
			{ action: "await", ids: ["0-Liveness"], heartbeat_ms: 100, timeout_ms: 500 },
			undefined,
			update => updates.push(update),
		);

		// Wait for the initial forced emit + at least one non-liveness tick.
		await Bun.sleep(60);
		const updatesAfterWarmup = updates.length;

		// Advance the virtual clock past the liveness interval.
		clock = 16_000;
		await Bun.sleep(120);
		const updatesAfterLiveness = updates.length;
		expect(updatesAfterLiveness).toBeGreaterThan(updatesAfterWarmup);

		// Advance again and confirm another liveness re-emit.
		clock = 31_000;
		await Bun.sleep(120);
		expect(updates.length).toBeGreaterThan(updatesAfterLiveness);

		gate.resolve("done");
		await awaiting;
		restore();
		await manager.dispose({ timeoutMs: 100 });
	});

	it("does not re-emit more than once per liveness interval when the signature is stable", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		const gate = Promise.withResolvers<string>();
		manager.register("task", "stable subagent", async () => gate.promise, {
			id: "job-liveness-bounded",
			ownerId: "0-Main",
			metadata: {
				subagent: {
					id: "0-LivenessBounded",
					agent: "executor",
					agentSource: "bundled",
					description: "stable",
				},
			},
		});

		let clock = 0;
		const restore = tool.withLivenessClock(() => clock);

		const updates: unknown[] = [];
		const awaiting = tool.execute(
			"await-liveness-bounded",
			{ action: "await", ids: ["0-LivenessBounded"], heartbeat_ms: 100, timeout_ms: 500 },
			undefined,
			update => updates.push(update),
		);

		// Initial emit.
		await Bun.sleep(60);
		const initial = updates.length;

		// Advance clock by only 5s (below the 15s interval) and wait for ticks.
		clock = 5_000;
		await Bun.sleep(150);
		// No liveness re-emit should have fired (no signature change either).
		expect(updates.length).toBe(initial);

		gate.resolve("done");
		await awaiting;
		restore();
		await manager.dispose({ timeoutMs: 100 });
	});
	it("does not emit liveness after the await resolves (no timer leak)", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		const gate = Promise.withResolvers<string>();
		manager.register("task", "race subagent", async () => gate.promise, {
			id: "job-race",
			ownerId: "0-Main",
			metadata: {
				subagent: {
					id: "0-Race",
					agent: "executor",
					agentSource: "bundled",
					description: "stable",
				},
			},
		});

		let clock = 0;
		const restore = tool.withLivenessClock(() => clock);
		const updates: unknown[] = [];
		const awaiting = tool.execute(
			"await-race",
			{ action: "await", ids: ["0-Race"], heartbeat_ms: 100, timeout_ms: 500 },
			undefined,
			update => updates.push(update),
		);

		await Bun.sleep(200);
		const warmup = updates.length;
		expect(warmup).toBeGreaterThan(0);

		// Resolve the subagent; the await should complete promptly (same
		// macrotask turn), and clearInterval runs in the finally.
		gate.resolve("done");
		await awaiting;
		const countAtCompletion = updates.length;

		// Keep ticking the real 100ms timer for 300ms with the virtual clock
		// far past the liveness interval. Any surviving progressTimer would
		// fire a liveness re-emit here — proving a leak/race.
		clock = 100_000;
		await Bun.sleep(300);
		// No additional updates after completion — the timer was cleared.
		expect(updates.length).toBe(countAtCompletion);

		restore();
		await manager.dispose({ timeoutMs: 100 });
	});

	it("heartbeat_ms=0 disables both progress timer and liveness", async () => {
		const manager = createManager();
		const tool = new SubagentTool(createSession());
		const gate = Promise.withResolvers<string>();
		manager.register("task", "silent subagent", async () => gate.promise, {
			id: "job-hb0",
			ownerId: "0-Main",
			metadata: {
				subagent: {
					id: "0-Hb0",
					agent: "executor",
					agentSource: "bundled",
					description: "silent",
				},
			},
		});

		let clock = 0;
		const restore = tool.withLivenessClock(() => clock);
		const updates: unknown[] = [];
		const awaiting = tool.execute(
			"await-hb0",
			{ action: "await", ids: ["0-Hb0"], heartbeat_ms: 0, timeout_ms: 120 },
			undefined,
			update => updates.push(update),
		);

		await Bun.sleep(200);
		const initial = updates.length;
		clock = 100_000;
		await Bun.sleep(100);
		expect(updates.length).toBe(initial);

		gate.resolve("done");
		await awaiting;
		restore();
		await manager.dispose({ timeoutMs: 100 });
	});
});
