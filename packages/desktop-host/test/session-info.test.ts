import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@gajae-code/agent-core";
import type { AssistantMessage, Model, Usage } from "@gajae-code/ai/core";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { AsyncJobManager } from "@gajae-code/coding-agent/async/job-manager";
import { setModelPresetRegistryDisabled } from "@gajae-code/coding-agent/config/model-preset-registry";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import * as pythonExecutor from "@gajae-code/coding-agent/eval/py/executor";
import * as bashExecutor from "@gajae-code/coding-agent/exec/bash-executor";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { DESKTOP_SESSION_INFO_LIMITS, readDesktopSessionInfo } from "../src/session-info";
import type { DesktopSessionInfo, DesktopSessionInfoUnavailable, DesktopSessionInfoUsage } from "../src/session-info-protocol";

const secret = "session-info-private-secret";
const catalogSessionId = "desktop-catalog-session";
const model: Model = {
	id: "local-session-info", name: "Local session info", provider: "desktop-info-fixture", api: "openai-completions",
	baseUrl: `https://example.invalid/${secret}`, reasoning: true, input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.5 }, contextWindow: 32_768, maxTokens: 1024,
};
const recordedUsage: Usage = {
	input: 100, output: 10, cacheRead: 20, cacheWrite: 5, totalTokens: 135,
	cost: { input: 0.75, output: 0.25, cacheRead: 0.15, cacheWrite: 0.1, total: 1.25 },
};
const partialUsage: Usage = {
	input: 17, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 20,
	cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
};
const finalUsage: Usage = {
	input: 29, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 36,
	cost: { input: 0.04, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.06 },
};
const zeroUsage: Usage = {
	input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(usage = recordedUsage, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: 1_700_000_000_000,
		content: [{ type: "text", text: `private response ${secret}` }], stopReason: "stop", usage: structuredClone(usage), ...overrides,
	};
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	while (cleanups.length) await cleanups.pop()?.();
});

/** Every SDK object is real and uses captured, owned temporary state; only the transport is local. */
async function fixture(options: {
	model?: Model | null;
	persisted?: boolean;
	seed?: (manager: SessionManager) => void;
	partial?: Usage;
	sdkIdentity?: string;
	credentialIdentity?: string;
} = {}) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-desktop-info-"));
	await setModelPresetRegistryDisabled({ agentDir: directory, disabled: true });
	const auth = await AuthStorage.create(path.join(directory, "auth.db"));
	auth.setRuntimeApiKey(model.provider, secret);
	const settings = Settings.isolated({ "compaction.enabled": false, "retry.enabled": false, "todo.enabled": false, shellPath: "/bin/sh" });
	const registry = new ModelRegistry(auth, path.join(directory, "models.yml"), settings, { agentDir: directory });
	const manager = options.persisted
		? SessionManager.create(directory, SessionManager.explicitDestination(path.join(directory, "sessions")))
		: SessionManager.inMemory(directory);
	options.seed?.(manager);
	await manager.flush();
	const jobs = new AsyncJobManager({ onJobComplete: () => {} });
	const started = Promise.withResolvers<void>();
	let settle: (() => void) | undefined;
	let providerCalls = 0;
	const selectedModel = options.model === null ? undefined : options.model ?? model;
	const agent = new Agent({
		initialState: {
			model: selectedModel, messages: manager.buildSessionContext().messages, tools: [],
			systemPrompt: [`Do not expose this system prompt ${secret}`],
		},
		getApiKey: () => secret,
		streamFn: (_model, _context, streamOptions) => {
			providerCalls++;
			const stream = new AssistantMessageEventStream();
			const message = assistant(options.partial ?? partialUsage, { timestamp: Date.now(), content: [{ type: "text", text: `working ${secret}` }] });
			let done = false;
			const finish = (aborted: boolean) => {
				if (done) return;
				done = true;
				streamOptions?.signal?.removeEventListener("abort", abort);
				if (aborted) {
					message.stopReason = "aborted";
					stream.push({ type: "error", reason: "aborted", error: message });
				} else {
					message.usage = structuredClone(finalUsage);
					message.content = [{ type: "text", text: `finished ${secret}` }];
					stream.push({ type: "done", reason: "stop", message });
				}
			};
			const abort = () => finish(true);
			settle = () => finish(false);
			streamOptions?.signal?.addEventListener("abort", abort, { once: true });
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "text_delta", contentIndex: 0, delta: "working", partial: message });
				if (streamOptions?.signal?.aborted) abort();
			});
			return stream;
		},
	});
	const session = new AgentSession({
		agent, sessionManager: manager, settings, modelRegistry: registry, agentDir: directory,
		ownedAsyncJobManager: jobs, agentId: crypto.randomUUID(), thinkingLevel: ThinkingLevel.High, workflowGatePublication: "local",
		providerSessionId: options.sdkIdentity, credentialSessionId: options.credentialIdentity,
	});
	const unsubscribe = agent.subscribe(event => { if (event.type === "message_update") started.resolve(); });
	cleanups.push(async () => {
		unsubscribe();
		await session.dispose();
		await registry.dispose();
		await settings.close();
		auth.close();
		await fs.rm(directory, { recursive: true, force: true });
	});
	const redact = (value: string): string => value.replaceAll(secret, "[secret]").replaceAll(directory, "[project]").replaceAll(session.sessionId, "[session]");
	return {
		directory, auth, settings, registry, manager, jobs, agent, session, redact, started: started.promise,
		get providerCalls() { return providerCalls; },
		finish() { if (!settle) throw new Error("No local stream is active"); settle(); },
	};
}

function info(session: AgentSession, redact: (text: string) => string = text => text): Extract<DesktopSessionInfo, { available: true }> {
	const result = readDesktopSessionInfo(session, { redact, catalogSessionId });
	if (!result.available) throw new Error(result.reason);
	return result;
}

function measured(value: DesktopSessionInfoUsage | DesktopSessionInfoUnavailable): DesktopSessionInfoUsage {
	if (!value.available) throw new Error(value.reason);
	return value;
}

async function beginStream(f: StreamingFixture): Promise<[Promise<void>]> {
	const running = f.session.prompt("Read only local fixture prompt");
	await Promise.race([f.started, running.then(() => { throw new Error("Prompt finished before the held local stream"); })]);
	return [running];
}

interface StreamingFixture {
	session: AgentSession;
	started: Promise<void>;
}

describe("desktop public session information", () => {
	test("requires a bounded host catalog identity without falling back to SDK ownership identity", async () => {
		const f = await fixture();
		const stats = vi.spyOn(f.session, "getSessionStats");
		for (const invalid of [undefined, null, {}, 1, "", " ", "catalog/path", "catalog\nidentity", "catalog\n", "x".repeat(129)]) {
			const result: DesktopSessionInfo = Reflect.apply(readDesktopSessionInfo, undefined, [f.session, { redact: (text: string) => text, catalogSessionId: invalid }]);
			expect(result).toMatchObject({ available: false, code: "invalid_catalog_session" });
			expect(JSON.stringify(result)).not.toContain(f.session.sessionId);
		}
		expect(stats).not.toHaveBeenCalled();
		expect(Reflect.apply(readDesktopSessionInfo, undefined, [f.session, { redact: (text: string) => text }])).toMatchObject({ available: false, code: "invalid_catalog_session" });
		expect(Reflect.apply(readDesktopSessionInfo, undefined, [f.session, undefined])).toMatchObject({ available: false, code: "invalid_catalog_session" });
		expect(readDesktopSessionInfo(f.session, { redact: text => text, catalogSessionId: f.session.sessionId })).toMatchObject({ available: false, code: "invalid_catalog_session" });
	});

	test("keeps SDK session, manager, credential and agent-owner identities out of display metadata even without host identity masking", async () => {
		const sdkIdentity = crypto.randomUUID();
		const credentialIdentity = crypto.randomUUID();
		const f = await fixture({ persisted: true, sdkIdentity, credentialIdentity });
		const managerIdentity = f.manager.getSessionId();
		const ownerIdentity = f.session.getAgentId();
		if (!ownerIdentity) throw new Error("Expected the fixture's actual SDK owner identity");
		expect(sdkIdentity).not.toBe(managerIdentity);
		await f.manager.setSessionName(`Session ${sdkIdentity} ${managerIdentity} ${credentialIdentity} ${ownerIdentity}`, "user");
		const result = info(f.session);
		expect(result.metadata.catalogSessionId).toBe(catalogSessionId);
		expect(result.metadata.name).toBe("Session [session] [session] [session] [session]");
		expect(result.metadata.cwd).toBe(f.directory);
		expect(result.metadata.sessionFileDisplay).toContain("[session]");
		expect(result.metadata).not.toHaveProperty("sessionId");
		expect(result.metadata).not.toHaveProperty("sessionFile");
		for (const identity of [sdkIdentity, managerIdentity, credentialIdentity, ownerIdentity]) expect(JSON.stringify(result)).not.toContain(identity);
		expect(result.metadata).not.toHaveProperty("ownerId");
		expect(result.metadata).not.toHaveProperty("agentId");
		// Catalog identity is supplied by the host, unchanged by display redaction.
		const replaced = info(f.session, () => sdkIdentity);
		expect(replaced.metadata.catalogSessionId).toBe(catalogSessionId);
		for (const value of Object.values(replaced.metadata)) expect(value).not.toBe(sdkIdentity);
		expect(JSON.stringify(replaced)).not.toContain(sdkIdentity);
		const ownerReintroduced = info(f.session, () => ownerIdentity);
		expect(ownerReintroduced.metadata.catalogSessionId).toBe(catalogSessionId);
		expect(JSON.stringify(ownerReintroduced)).not.toContain(ownerIdentity);
		expect(readDesktopSessionInfo(f.session, { catalogSessionId: ownerIdentity, redact: text => text })).toMatchObject({ available: false, code: "invalid_catalog_session" });
		expect(result.model).toEqual({ provider: model.provider, id: model.id, name: model.name });
	});

	test("rejects an owner identity change during metadata redaction instead of returning a stale snapshot", async () => {
		const f = await fixture();
		const getAgentId = f.session.getAgentId.bind(f.session);
		let successor = false;
		vi.spyOn(f.session, "getAgentId").mockImplementation(() => successor ? "successor-owner" : getAgentId());
		const result = readDesktopSessionInfo(f.session, { catalogSessionId, redact(value) {
			successor = true;
			return value;
		} });
		expect(result).toMatchObject({ available: false, code: "stale_session" });
		expect(JSON.stringify(result)).not.toContain("successor-owner");
	});

	test("projects seeded transcript usage, task costs and active tool counts without raw content", async () => {
		const taskUsage: Usage = { ...structuredClone(recordedUsage), input: 20, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 22,
			cost: { input: 0.3, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.5 } };
		const f = await fixture({ persisted: true, seed(manager) {
			manager.appendMessage({ role: "user", content: `user private ${secret}`, timestamp: 1 });
			manager.appendMessage(assistant(recordedUsage, { content: [{ type: "toolCall", id: `call-${secret}`, name: "task", arguments: { secret } }] }));
			manager.appendMessage({ role: "toolResult", toolCallId: `call-${secret}`, toolName: "task", content: [{ type: "text", text: secret }],
				isError: false, timestamp: 2, details: { usage: taskUsage, usageCostBreakdownComplete: true, owner: secret } });
		} });
		await f.manager.setSessionName(`Session ${secret}`, "user");
		const result = info(f.session, f.redact);
		expect(result.metadata).toMatchObject({ catalogSessionId, name: "Session [secret]", cwd: "[project]", persisted: true });
		expect(result.metadata.sessionFileDisplay).toStartWith("[project]");
		expect(result.model).toEqual({ provider: model.provider, id: model.id, name: model.name });
		expect(result.thinkingLevel).toBe("high");
		expect(result.tools).toEqual({ available: 0, pending: 0, calls: 1, results: 1 });
		expect(measured(result.recordedTotals).tokens).toEqual({ input: 120, output: 12, cacheRead: 20, cacheWrite: 5, total: 157 });
		expect(measured(result.activeTotals).cost).toMatchObject({ amount: 1.75, source: "sdk_recorded_cost" });
		expect(measured(result.recordedTotals).source).toBe("transcript_aggregate");
		expect(measured(result.activeTotals).source).toBe("active_messages");
		expect(result.actualBilledCost).toMatchObject({ available: false });
		expect(result.accountQuota).toMatchObject({ available: false });
		expect(JSON.stringify(result)).not.toContain(secret);
		expect(JSON.stringify(result)).not.toContain("system prompt");
		expect(JSON.stringify(result)).not.toContain("baseUrl");
		expect(JSON.stringify(result)).not.toContain("owner");
	});

	test("keeps all-transcript totals distinct from active branch totals", async () => {
		const f = await fixture({ seed(manager) {
			const root = manager.appendMessage({ role: "user", content: "branch root", timestamp: 1 });
			manager.appendMessage(assistant({ ...structuredClone(zeroUsage), input: 11, totalTokens: 11 }));
			manager.branch(root);
			manager.appendMessage(assistant({ ...structuredClone(zeroUsage), input: 23, totalTokens: 23 }));
		} });
		const result = info(f.session);
		expect(measured(result.recordedTotals).tokens.input).toBe(34);
		expect(measured(result.activeTotals).tokens.input).toBe(23);
		expect(measured(result.recordedTotals).note).toContain("inactive branches");
		expect(result.context.source).toBe("provider_anchor");
		expect(result.context.note).toContain("heuristic trailing");
	});

	test("reads a genuine held stream without waiting or taking a control mutation lease", async () => {
		const f = await fixture({ seed: manager => { manager.appendMessage(assistant()); } });
		const [running] = await beginStream(f);
		const lease = vi.spyOn(f.session, "withSdkControlMutation");
		const wait = vi.spyOn(f.session, "waitForIdle");
		const quota = vi.spyOn(f.session, "fetchUsageReports");
		const controlQuota = vi.spyOn(f.session, "fetchUsageReportsForControl");
		try {
			const result = info(f.session, f.redact);
			expect(f.session.isStreaming).toBe(true);
			expect(result.run).toMatchObject({ state: "running", streaming: true, bashRunning: false, pythonRunning: false });
			expect(result.metadata.catalogSessionId).toBe(catalogSessionId);
			expect(JSON.stringify(result)).not.toContain(f.session.sessionId);
			expect(JSON.stringify(result)).not.toContain(f.manager.getSessionId());
			expect(measured(result.recordedTotals).tokens.total).toBe(135);
			expect(measured(result.activeTotals).tokens.total).toBe(135);
			expect(measured(result.liveProgress)).toMatchObject({ source: "stream_partial", tokens: { input: 17, output: 3, total: 20 }, cost: { amount: 0.03, source: "live_partial_cost" } });
			expect(measured(result.liveProgress).note).toContain("Not billed");
			expect(lease).not.toHaveBeenCalled();
			expect(wait).not.toHaveBeenCalled();
			expect(quota).not.toHaveBeenCalled();
			expect(controlQuota).not.toHaveBeenCalled();
			expect(f.providerCalls).toBe(1);
			f.finish();
			await running;
			await f.session.awaitSessionSettlement();
			const completed = info(f.session);
			expect(completed.run.streaming).toBe(false);
			expect(measured(completed.recordedTotals).tokens).toEqual({ input: 129, output: 17, cacheRead: 20, cacheWrite: 5, total: 171 });
			expect(completed.liveProgress.available).toBe(false);
			// Returned values are snapshots, not aliases to the SDK partial.
			expect(measured(result.liveProgress).tokens.total).toBe(20);
		} finally { f.finish(); await running; }
	});

	test("observes real SDK bash admission while a delegating executor is held, without a read lease or billing inference", async () => {
		const f = await fixture({ seed: manager => { manager.appendMessage(assistant()); } });
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const execute = bashExecutor.executeBash;
		const executor = vi.spyOn(bashExecutor, "executeBash").mockImplementation(async (command, options) => {
			entered.resolve();
			await release.promise;
			return execute(command, options);
		});
		const running = f.session.executeBash("printf 'session-info-local-shell\\n'");
		try {
			await Promise.race([entered.promise, running.then(() => { throw new Error("Executor settled before the held seam"); })]);
			const lease = vi.spyOn(f.session, "withSdkControlMutation");
			const wait = vi.spyOn(f.session, "waitForIdle");
			const revisions = f.manager.revisionSnapshot();
			const observed = info(f.session, f.redact);
			expect(observed.run).toMatchObject({ state: "running", streaming: false, bashRunning: true, pythonRunning: false });
			expect(f.session.isBashRunning).toBe(true);
			expect(measured(observed.recordedTotals).tokens.total).toBe(135);
			expect(observed.liveProgress.available).toBe(false);
			expect(observed.actualBilledCost.available).toBe(false);
			expect(observed.metadata.catalogSessionId).toBe(catalogSessionId);
			expect(JSON.stringify(observed)).not.toContain(f.session.sessionId);
			expect(f.manager.revisionSnapshot()).toEqual(revisions);
			expect(lease).not.toHaveBeenCalled();
			expect(wait).not.toHaveBeenCalled();
			expect(executor).toHaveBeenCalledTimes(1);
		} finally { release.resolve(); await running; }
		expect(info(f.session).run).toMatchObject({ state: "idle", streaming: false, bashRunning: false, pythonRunning: false });
		expect(f.agent.state.messages.at(-1)).toMatchObject({ role: "bashExecution", exitCode: 0 });
		expect(f.providerCalls).toBe(0);
	}, 20_000);

	test("observes real SDK Python tracking until its delegated kernel settles, not merely until abort is requested", async () => {
		const f = await fixture();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(pythonExecutor, "executePython").mockImplementation((code, options) => {
			if (!options?.kernelOwnerId || !options.signal) throw new Error("Expected SDK-owned Python execution");
			return pythonExecutor.executePythonWithKernel({ execute: async () => {
				entered.resolve();
				await release.promise;
				return { status: "ok", cancelled: false, timedOut: false, stdinRequested: false };
			} }, code, options);
		});
		const running = f.session.executePython("local_fixture_execution()");
		try {
			await Promise.race([entered.promise, running.then(() => { throw new Error("Executor settled before the held seam"); })]);
			const lease = vi.spyOn(f.session, "withSdkControlMutation");
			const wait = vi.spyOn(f.session, "waitForIdle");
			const revisions = f.manager.revisionSnapshot();
			const observed = info(f.session, f.redact);
			expect(observed.run).toMatchObject({ state: "running", streaming: false, bashRunning: false, pythonRunning: true });
			expect(observed.recordedTotals.available).toBe(false);
			expect(observed.liveProgress.available).toBe(false);
			expect(observed.actualBilledCost.available).toBe(false);
			f.session.abortEval();
			// SDK tracking remains active until the held work settles. This is not
			// a claim about kernel/process termination or resource-ledger sealing.
			expect(info(f.session).run).toMatchObject({ state: "running", pythonRunning: true });
			expect(f.session.isEvalRunning).toBe(true);
			expect(f.manager.revisionSnapshot()).toEqual(revisions);
			expect(lease).not.toHaveBeenCalled();
			expect(wait).not.toHaveBeenCalled();
		} finally { release.resolve(); await running; }
		expect(info(f.session).run).toMatchObject({ state: "idle", streaming: false, bashRunning: false, pythonRunning: false });
		expect(f.providerCalls).toBe(0);
	});

	test("does not present provider-initialized stream zero counters as measured usage", async () => {
		const f = await fixture({ partial: zeroUsage });
		const [running] = await beginStream(f);
		try {
			const result = info(f.session);
			expect(result.run.streaming).toBe(true);
			expect(result.liveProgress).toMatchObject({ available: false, reason: expect.stringContaining("zero defaults") });
			expect(result.recordedTotals.available).toBe(false);
			expect(result.context.source).toBe("heuristic");
		} finally { f.finish(); await running; }
	});

	test("leaves missing model, usage, quota and billing unavailable rather than synthesizing zeros", async () => {
		const f = await fixture({ model: null });
		const result = info(f.session);
		expect(result.model).toBeNull();
		expect(result.context).toMatchObject({ tokens: null, contextWindow: null, percent: null, source: "unknown" });
		expect(result.recordedTotals.available).toBe(false);
		expect(result.activeTotals.available).toBe(false);
		expect(result.actualBilledCost.available).toBe(false);
		expect(result.accountQuota.available).toBe(false);
	});

	test("retains unknown post-compaction context despite positive recorded history", async () => {
		const f = await fixture({ seed(manager) {
			manager.appendMessage(assistant());
			const kept = manager.appendMessage({ role: "user", content: "retained recent question", timestamp: 2 });
			manager.appendCompaction("Earlier history summarized", undefined, kept, 135);
		} });
		const result = info(f.session);
		expect(result.context).toMatchObject({ tokens: null, contextWindow: 32_768, percent: null, source: "unknown" });
		expect(result.context.note).toContain("after compaction");
		expect(measured(result.recordedTotals).tokens.total).toBe(135);
	});

	test("does not infer cost or premium-request counts from SDK zero defaults", async () => {
		const unpriced: Usage = { ...structuredClone(recordedUsage), cost: structuredClone(zeroUsage.cost) };
		const f = await fixture({ seed: manager => { manager.appendMessage(assistant(unpriced)); } });
		const result = info(f.session);
		for (const value of [result.activeTotals, result.recordedTotals]) {
			expect(measured(value).cost).toMatchObject({ amount: null, reason: expect.stringContaining("unknown") });
			expect(measured(value).premiumRequests).toBeNull();
			expect(measured(value).tokens.total).toBe(135);
		}
	});

	test("preserves an actual fractional premium-request counter without inferring account quotas", async () => {
		const f = await fixture({ seed: manager => {
			manager.appendMessage(assistant({ ...structuredClone(zeroUsage), premiumRequests: 1.5 }));
		} });
		const result = info(f.session);
		expect(measured(result.recordedTotals).premiumRequests).toBe(1.5);
		expect(measured(result.activeTotals).premiumRequests).toBe(1.5);
		expect(measured(result.recordedTotals).cost.amount).toBeNull();
		expect(result.accountQuota.available).toBe(false);
	});

	test("keeps unsafe numeric counters and nonfinite costs unknown rather than serializing invented precision", async () => {
		const oversized: Usage = {
			...structuredClone(recordedUsage), input: Number.MAX_SAFE_INTEGER + 1,
			totalTokens: Number.MAX_SAFE_INTEGER + 1,
			cost: { ...recordedUsage.cost, total: Number.NaN },
		};
		const f = await fixture({ seed: manager => { manager.appendMessage(assistant(oversized)); } });
		const result = info(f.session);
		const active = measured(result.activeTotals);
		expect(active.tokens.input).toBeNull();
		expect(active.tokens.total).toBeNull();
		expect(active.tokens.output).toBe(10);
		expect(active.cost.amount).toBeNull();
		// The real SessionManager rejects the malformed cost record rather than aggregating it.
		expect(result.recordedTotals.available).toBe(false);
		expect(JSON.stringify(result)).not.toContain("NaN");
		expect(JSON.stringify(result)).not.toContain("Infinity");
	});

	test("does not mistake partial/error usage for final billing or a context anchor", async () => {
		const f = await fixture({ seed: manager => { manager.appendMessage(assistant(recordedUsage, { stopReason: "aborted" })); } });
		const result = info(f.session);
		expect(measured(result.activeTotals).tokens.total).toBe(135);
		expect(measured(result.activeTotals).note).toContain("partial/error");
		expect(result.context.source).toBe("heuristic");
		expect(result.actualBilledCost.available).toBe(false);
	});

	test("redacts complete fields before truncation and keeps Unicode well formed", async () => {
		const longName = `${"😀".repeat(DESKTOP_SESSION_INFO_LIMITS.fieldChars - 1)}${secret}\u001b\u202e`;
		const f = await fixture({ model: { ...model, name: longName } });
		const seen: string[] = [];
		const result = info(f.session, value => { seen.push(value); return f.redact(value); });
		expect(seen).toContain(longName);
		expect(result.model?.name.isWellFormed()).toBe(true);
		expect([...(result.model?.name ?? "")].length).toBeLessThanOrEqual(DESKTOP_SESSION_INFO_LIMITS.fieldChars + 1);
		expect(result.model?.name).toEndWith("…");
		expect(JSON.stringify(result)).not.toContain(secret);
		expect(JSON.stringify(result)).not.toContain(f.directory);
		const controls = await fixture({ model: { ...model, name: "safe\u001b\u0000\u202e\ud800😀" } });
		const safe = info(controls.session).model!.name;
		expect(safe).toBe("safe   �😀");
		expect(safe.isWellFormed()).toBe(true);
	});

	test("withholds oversized fields instead of truncating secrets or returning unbounded metadata", async () => {
		const oversized = secret.repeat(DESKTOP_SESSION_INFO_LIMITS.inputChars);
		const f = await fixture({ model: { ...model, name: oversized } });
		const seen: string[] = [];
		const result = info(f.session, value => { seen.push(value); return value; });
		expect(result.model?.name).toBe("[withheld: display limit]");
		expect(seen).not.toContain(oversized);
		expect(JSON.stringify(result).length).toBeLessThan(16_384);
		const expanded = info(f.session, () => oversized);
		expect(expanded.metadata.catalogSessionId).toBe(catalogSessionId);
		expect(expanded.metadata.cwd).toBe("[withheld: display limit]");
	});

	test("fails closed on throwing or invalid redactors without leaking their exceptions", async () => {
		const f = await fixture();
		const throwing = readDesktopSessionInfo(f.session, { catalogSessionId, redact: () => { throw new Error(secret); } });
		expect(throwing).toMatchObject({ available: false, code: "redaction_failed" });
		expect(JSON.stringify(throwing)).not.toContain(secret);
		const invalid: DesktopSessionInfo = Reflect.apply(readDesktopSessionInfo, undefined, [f.session, { catalogSessionId, redact: () => null }]);
		expect(invalid).toMatchObject({ available: false, code: "redaction_failed" });
	});

	test("contains backend failures and preserves independent readable metrics", async () => {
		const f = await fixture({ seed: manager => { manager.appendMessage(assistant()); } });
		vi.spyOn(f.session, "getSessionStats").mockImplementation(() => { throw new Error(secret); });
		vi.spyOn(f.session, "getContextUsage").mockImplementation(() => { throw new Error(secret); });
		const result = info(f.session);
		expect(result.activeTotals.available).toBe(false);
		expect(result.tools.calls).toBeNull();
		expect(result.context).toMatchObject({ tokens: null, source: "unknown" });
		expect(measured(result.recordedTotals).tokens.total).toBe(135);
		expect(JSON.stringify(result)).not.toContain(secret);
		vi.spyOn(f.manager, "getCwd").mockImplementation(() => { throw new Error(secret); });
		const failed = readDesktopSessionInfo(f.session, { catalogSessionId, redact: text => text });
		expect(failed).toMatchObject({ available: false, code: "backend_failure" });
		expect(JSON.stringify(failed)).not.toContain(secret);
	});

	test("rejects real lifecycle transitions and disposal, including reentrant disposal from redaction", async () => {
		const f = await fixture();
		const transitioning = f.session.newSession();
		expect(readDesktopSessionInfo(f.session, { catalogSessionId, redact: f.redact })).toMatchObject({ available: false, code: "transitioning" });
		await transitioning;
		expect(info(f.session).run.state).toBe("idle");
		let disposal: Promise<void> | undefined;
		const result = readDesktopSessionInfo(f.session, { catalogSessionId, redact(value) { disposal ??= f.session.dispose(); return value; } });
		expect(result).toMatchObject({ available: false, code: "disposed" });
		await disposal;
		expect(readDesktopSessionInfo(f.session, { catalogSessionId, redact: f.redact })).toMatchObject({ available: false, code: "disposed" });
	});

	test("is read-only for transcript, settings, ownership and provider state; DTO edits cannot mutate SDK state", async () => {
		const f = await fixture({ persisted: true, seed: manager => { manager.appendMessage(assistant()); } });
		const before = await Bun.file(f.session.sessionFile!).text();
		const revisions = f.manager.revisionSnapshot();
		const messages = structuredClone(f.session.state.messages);
		const flush = vi.spyOn(f.manager, "flush");
		const append = vi.spyOn(f.manager, "appendMessage");
		const settings = vi.spyOn(f.settings, "set");
		const refresh = vi.spyOn(f.registry, "refresh");
		const globalManager = vi.spyOn(AsyncJobManager, "instance");
		const mutation = vi.spyOn(f.session, "withSdkControlMutation");
		const events: string[] = [];
		const unsubscribe = f.session.subscribe(event => { events.push(event.type); });
		const result = info(f.session, f.redact);
		result.metadata.cwd = "tampered";
		result.model!.id = "tampered";
		measured(result.activeTotals).tokens.input = 999;
		const next = info(f.session, f.redact);
		unsubscribe();
		expect(next.metadata.cwd).toBe("[project]");
		expect(next.model?.id).toBe(model.id);
		expect(measured(next.activeTotals).tokens.input).toBe(100);
		expect(f.session.state.messages).toEqual(messages);
		expect(f.manager.revisionSnapshot()).toEqual(revisions);
		expect(await Bun.file(f.session.sessionFile!).text()).toBe(before);
		for (const spy of [flush, append, settings, refresh, globalManager, mutation]) expect(spy).not.toHaveBeenCalled();
		expect(events).toEqual([]);
		expect(f.providerCalls).toBe(0);
	});
});
