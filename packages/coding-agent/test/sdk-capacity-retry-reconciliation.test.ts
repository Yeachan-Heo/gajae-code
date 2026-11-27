import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AttemptScope } from "@gajae-code/agent-core/attempt-scope";
import { type AssistantMessage, getBundledModel, type Model } from "@gajae-code/ai";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import type { AgentEndEvent } from "../src/extensibility/extensions/types";
import {
	type ReconciliationStoreDocument,
	reconciliationStorePath,
	resolveReconciliationSessionFile,
} from "../src/sdk/bus/reconciliation-store";
import { SdkClient, type SdkFrame } from "../src/sdk/client/client";
import { startProductionSdkHost } from "./helpers/sdk-production-host";

const CAPACITY =
	"The model is currently at capacity due to high demand. Please try again in a few minutes, or use a higher service tier for priority processing";

function providerResponse(model: Model, error?: string, errorStatus?: number): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const message: AssistantMessage = {
			role: "assistant",
			content: error ? [] : [{ type: "text", text: "capacity recovered" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: error ? "error" : "stop",
			...(error ? { errorMessage: error } : {}),
			...(errorStatus === undefined ? {} : { errorStatus }),
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial: message });
		if (error) stream.push({ type: "error", reason: "error", error: message });
		else stream.push({ type: "done", reason: "stop", message });
	});
	return stream;
}

interface AcceptedPrompt {
	ok: true;
	result: { commandId: string; turnId: string; accepted: true; clientRef: string };
}

async function fixture() {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-capacity-reconciliation-"));
	const host = await startProductionSdkHost(cwd);
	try {
		const model = getBundledModel("xai", "grok-4.7");
		host.session.modelRegistry.authStorage.setRuntimeApiKey(model.provider, "fake-key");
		await host.session.setModel(model);
		host.session.settings.set("retry.baseDelayMs", 1);
		host.session.settings.set("retry.maxDelayMs", 2);
		host.session.settings.set("retry.maxRetries", 12);
		host.session.settings.set("compaction.enabled", false);
		host.session.agent.getApiKey = () => "fake-key";
		const client = await SdkClient.connect(host.endpoint.url, host.endpoint.token, { reconnectAttempts: 0 });
		const frames: SdkFrame[] = [];
		client.onFrame(frame => frames.push(frame));
		await client.request({ type: "event_replay", sinceSeq: 0 });
		return {
			...host,
			client,
			frames,
			readRecords: async () => {
				const sessionFile = resolveReconciliationSessionFile(
					host.session.sessionManager.getSessionFile(),
					path.join(cwd, ".gjc", "state"),
					host.sessionId,
				);
				return (await Bun.file(
					reconciliationStorePath(sessionFile, host.sessionId),
				).json()) as ReconciliationStoreDocument;
			},
			stop: async () => {
				await client.close();
				await host.stop();
				await fs.rm(cwd, { recursive: true, force: true });
			},
		};
	} catch (error) {
		await host.stop();
		await fs.rm(cwd, { recursive: true, force: true });
		throw error;
	}
}

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!(await predicate())) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
		await Bun.sleep(10);
	}
}

// Real factory session, notification-bus host, native transport, and durable prompt
// records. No synthetic agent_end or reconciliation transitions in the regression.
test.each([0, 1, 4, 8])("SDK capacity retries (%s) settle the exact accepted prompt", async failures => {
	const host = await fixture();
	let calls = 0;
	const release = Promise.withResolvers<void>();
	const events: string[] = [];
	const starts: Array<{ scope: AttemptScope | undefined; handle: string | undefined }> = [];
	const runner = host.session.extensionRunner!;
	const emit = runner.emit.bind(runner);
	const observation = spyOn(runner, "emit").mockImplementation(async event => {
		if (event.type === "agent_start")
			starts.push({ scope: event.lifecycleScope, handle: host.session.activePromptHandle });
		return emit(event);
	});
	try {
		host.session.subscribe(event => {
			events.push(event.type);
		});
		host.session.agent.streamFn = async model => {
			calls++;
			if (calls === 1) await release.promise;
			return providerResponse(model, calls <= failures ? CAPACITY : undefined);
		};
		const clientRef = `capacity-${failures}`;
		const accepted = (await host.client.control("turn.prompt", {
			text: "recover from capacity",
			clientRef,
		})) as AcceptedPrompt;
		expect(accepted).toMatchObject({ ok: true, result: { accepted: true, clientRef } });
		expect((await host.readRecords()).records).toContainEqual(
			expect.objectContaining({ clientRef, status: expect.stringMatching(/accepted|in_flight/) }),
		);
		release.resolve();
		await waitFor(() => calls === failures + 1, "the successful provider call");
		await host.session.waitForIdle();
		// Prove the stop was reached BEFORE checking SDK terminalization (#7620).
		expect(calls).toBe(failures + 1);
		expect(host.session.agent.state.messages.at(-1)).toMatchObject({
			role: "assistant",
			provider: "xai",
			stopReason: "stop",
			content: [{ type: "text", text: "capacity recovered" }],
		});
		expect(events.filter(type => type === "auto_retry_start")).toHaveLength(failures);
		expect(starts).toHaveLength(failures + 1);
		const first = starts.at(0)!;
		expect(first.scope).toBeDefined();
		for (const start of starts) expect(start.scope).toBe(first.scope);
		expect(new Set(starts.map(start => start.handle)).size).toBe(failures + 1);
		const correlation = { commandId: accepted.result.commandId, turnId: accepted.result.turnId };
		await waitFor(
			() => host.frames.some(frame => frame.type === "agent_end" && frame.commandId === correlation.commandId),
			"the correlated terminal",
		);
		expect(await host.client.query("turn.prompt_status", { clientRef })).toMatchObject({
			result: { status: "terminal_ok", terminalAt: expect.any(Number), ...correlation },
		});
		expect(await host.client.query("turn.result", { kind: "prompt", clientRef })).toMatchObject({
			result: { status: "terminal_ok", content: { text: "capacity recovered" }, ...correlation },
		});
		expect((await host.readRecords()).records).toContainEqual(
			expect.objectContaining({ clientRef, status: "terminal_ok", terminalAt: expect.any(Number), ...correlation }),
		);
		expect(host.frames.filter(frame => frame.type === "agent_end")).toEqual([expect.objectContaining(correlation)]);
		expect(host.frames.filter(frame => frame.type === "event" && frame.kind === "agent_end")).toEqual([
			expect.objectContaining({ payload: expect.objectContaining(correlation) }),
		]);
	} finally {
		release.resolve();
		observation.mockRestore();
		await host.stop();
	}
}, 30_000);

test("SDK retry terminal replay cannot settle an independent successor", async () => {
	const host = await fixture();
	const release = Promise.withResolvers<void>();
	let calls = 0;
	let predecessor: AgentEndEvent | undefined;
	const runner = host.session.extensionRunner!;
	const emit = runner.emit.bind(runner);
	const observation = spyOn(runner, "emit").mockImplementation(async event => {
		if (event.type === "agent_end" && !predecessor) predecessor = event;
		return emit(event);
	});
	try {
		host.session.agent.streamFn = async model => {
			calls++;
			if (calls === 3) await release.promise;
			return providerResponse(model, calls === 1 ? CAPACITY : undefined);
		};
		const first = (await host.client.control("turn.prompt", {
			text: "retry first",
			clientRef: "predecessor",
		})) as AcceptedPrompt;
		await waitFor(() => calls === 2, "the predecessor recovery");
		await host.session.waitForIdle();
		await waitFor(
			() => host.frames.some(frame => frame.type === "agent_end" && frame.commandId === first.result.commandId),
			"the predecessor terminal",
		);
		const second = (await host.client.control("turn.prompt", {
			text: "independent successor",
			clientRef: "successor",
		})) as AcceptedPrompt;
		await waitFor(() => calls === 3, "the successor provider call");
		await waitFor(
			async () =>
				(await host.readRecords()).records.some(
					record => record.commandId === second.result.commandId && record.status === "in_flight",
				),
			"the successor's durable in_flight reconciliation",
		);
		expect(predecessor).toBeDefined();
		await emit(predecessor!);
		expect(await host.client.query("turn.prompt_status", { clientRef: "successor" })).toMatchObject({
			result: { status: "in_flight", commandId: second.result.commandId },
		});
		expect(
			host.frames.filter(frame => frame.type === "agent_end" && frame.commandId === second.result.commandId),
		).toHaveLength(0);
		release.resolve();
		await host.session.waitForIdle();
		await waitFor(
			() => host.frames.some(frame => frame.type === "agent_end" && frame.commandId === second.result.commandId),
			"the successor's own terminal",
		);
		for (const accepted of [first, second]) {
			const { commandId, turnId } = accepted.result;
			expect(host.frames.filter(frame => frame.type === "agent_end" && frame.commandId === commandId)).toEqual([
				expect.objectContaining({ commandId, turnId }),
			]);
		}
	} finally {
		release.resolve();
		observation.mockRestore();
		await host.stop();
	}
}, 30_000);

test("SDK abort during capacity backoff terminalizes without starting a retry", async () => {
	const host = await fixture();
	let calls = 0;
	let retrying = false;
	try {
		host.session.settings.set("retry.baseDelayMs", 10_000);
		host.session.settings.set("retry.maxDelayMs", 10_000);
		host.session.subscribe(event => {
			if (event.type === "auto_retry_start") retrying = true;
		});
		host.session.agent.streamFn = model => {
			calls++;
			return providerResponse(model, CAPACITY);
		};
		const accepted = (await host.client.control("turn.prompt", {
			text: "cancel retry",
			clientRef: "cancel",
		})) as AcceptedPrompt;
		await waitFor(() => retrying, "the capacity backoff");
		expect(await host.client.control("turn.abort")).toMatchObject({ ok: true });
		await host.session.waitForIdle();
		expect(calls).toBe(1);
		const status = await host.client.query("turn.prompt_status", { clientRef: "cancel" });
		expect(status).toMatchObject({
			result: {
				status: "terminal_ok",
				outcome: { kind: "stopped", reason: "cancelled", provenance: "client_cancel" },
				terminalAt: expect.any(Number),
				commandId: accepted.result.commandId,
			},
		});
	} finally {
		await host.stop();
	}
}, 30_000);

test("SDK retries transfer only the exact joined prompt cohort", async () => {
	const host = await fixture();
	const release = Promise.withResolvers<void>();
	const delivery = Promise.withResolvers<void>();
	let calls = 0;
	const send = host.session.sendUserMessage.bind(host.session);
	const promotion = spyOn(host.session, "sendUserMessage").mockImplementation(async (content, options) => {
		if (options?.deliverAs !== "followUp") return send(content, options);
		// Exercise the producer's in-run consumption callback deterministically;
		// an ordinary queued follow-up starts an independent public lifecycle.
		await options.onPreflightAcceptCommit?.();
		options.onQueuedPromoted?.({ startsOwnRun: false });
		await delivery.promise;
	});
	try {
		host.session.agent.streamFn = async model => {
			calls++;
			if (calls === 1) await release.promise;
			return providerResponse(model, calls === 1 ? CAPACITY : undefined);
		};
		const root = (await host.client.control("turn.prompt", { text: "root", clientRef: "root" })) as AcceptedPrompt;
		await waitFor(() => calls === 1, "the root provider call");
		const joined = (await host.client.control("turn.follow_up", {
			text: "join this run",
			clientRef: "joined",
		})) as AcceptedPrompt;
		expect(joined.ok).toBe(true);
		release.resolve();
		await waitFor(() => calls === 2, "the joined cohort's recovery");
		await host.session.waitForIdle();
		expect(calls).toBe(2);
		for (const accepted of [root, joined]) {
			const { commandId, turnId } = accepted.result;
			await waitFor(
				() => host.frames.some(frame => frame.type === "agent_end" && frame.commandId === commandId),
				`terminal ${commandId}`,
			);
			if (accepted === root)
				expect(await host.client.query("turn.prompt_status", { clientRef: "root" })).toMatchObject({
					result: { status: "terminal_ok", commandId, turnId, terminalAt: expect.any(Number) },
				});
			expect(host.frames.filter(frame => frame.type === "agent_end" && frame.commandId === commandId)).toEqual([
				expect.objectContaining({ commandId, turnId }),
			]);
		}
	} finally {
		release.resolve();
		delivery.resolve();
		promotion.mockRestore();
		await host.stop();
	}
}, 30_000);

test("SDK capacity recovery ending in an authentication error terminalizes as failed", async () => {
	const host = await fixture();
	let calls = 0;
	try {
		host.session.agent.streamFn = model => {
			calls++;
			return providerResponse(model, calls === 1 ? CAPACITY : "Invalid API key", calls === 1 ? undefined : 401);
		};
		const accepted = (await host.client.control("turn.prompt", {
			text: "retry then fail",
			clientRef: "failed",
		})) as AcceptedPrompt;
		await waitFor(() => calls === 2, "the terminal provider error");
		await host.session.waitForIdle();
		expect(calls).toBe(2);
		const { commandId, turnId } = accepted.result;
		await waitFor(
			() => host.frames.some(frame => frame.type === "agent_failed" && frame.commandId === commandId),
			"the failed terminal",
		);
		expect(await host.client.query("turn.prompt_status", { clientRef: "failed" })).toMatchObject({
			result: { status: "failed", terminalAt: expect.any(Number), commandId, turnId },
		});
		expect(host.frames.filter(frame => frame.type === "agent_failed")).toEqual([
			expect.objectContaining({ commandId, turnId }),
		]);
	} finally {
		await host.stop();
	}
}, 30_000);

test.each([
	"foreign",
	"missing",
] as const)("SDK %s lifecycle scope cannot transfer a prompt to another resource run", async identity => {
	const host = await fixture();
	let calls = 0;
	let starts = 0;
	let terminals = 0;
	const runner = host.session.extensionRunner!;
	const emit = runner.emit.bind(runner);
	const fault = spyOn(runner, "emit").mockImplementation(async event => {
		if (event.type === "agent_end") terminals++;
		if (event.type === "agent_start" && ++starts === 2) {
			event.lifecycleScope = identity === "missing" ? undefined : { ...event.lifecycleScope! };
		}
		return emit(event);
	});
	try {
		host.session.agent.streamFn = model => providerResponse(model, ++calls === 1 ? CAPACITY : undefined);
		const accepted = (await host.client.control("turn.prompt", {
			text: "do not borrow ownership",
			clientRef: identity,
		})) as AcceptedPrompt;
		await waitFor(() => calls === 2, "the independently scoped resource run");
		await host.session.waitForIdle();
		expect(calls).toBe(2);
		// The final event really arrived, but has no proof of ownership of this
		// prompt. This is deliberately the fail-closed counterpart to the regression.
		expect(terminals).toBe(1);
		await waitFor(
			() => host.frames.some(frame => frame.type === "event" && frame.kind === "agent_end"),
			"the observer lifecycle terminal",
		);
		expect(host.frames.filter(frame => frame.type === "event" && frame.kind === "agent_end")).toEqual([
			expect.objectContaining({ payload: { type: "agent_end", sessionId: host.sessionId } }),
		]);
		expect(
			host.frames.filter(frame => frame.type === "agent_end" && frame.commandId === accepted.result.commandId),
		).toHaveLength(0);
		expect(await host.client.query("turn.prompt_status", { clientRef: identity })).toMatchObject({
			result: { status: "in_flight" },
		});
	} finally {
		fault.mockRestore();
		await host.stop();
	}
}, 30_000);
