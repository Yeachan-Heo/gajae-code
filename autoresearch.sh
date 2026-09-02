#!/usr/bin/env bash
# Autoresearch harness (research-only). Materializes a bun test file in a temp
# directory OUTSIDE the repo tree, runs it, and prints METRIC lines.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
TMP="$ROOT/artifacts/autoresearch-steer-model"; mkdir -p "$TMP"
TEST="$TMP/repro.test.ts"
cat >"$TEST" <<'EOF'
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@gajae-code/agent-core";
import { getBundledModel, z } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";

function userMessage(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}
const metrics: string[] = [];
function metric(name: string, value: string | number | boolean) {
	metrics.push(`METRIC ${name}=${value}`);
}
function userTexts(agent: Agent): string[] {
	return agent.state.messages
		.filter(m => m.role === "user")
		.map(m => (typeof m.content === "string" ? m.content : (m.content as any[]).map(c => c.text ?? "").join("")));
}

describe("core Agent steer/turn model", () => {
	afterEach(() => {
		for (const line of metrics.splice(0)) console.log(line);
	});

	it("S1: steer() after turn end is accepted and orphaned", async () => {
		const mock = createMockModel({ responses: [{ content: ["done"] }, { content: ["never"] }] });
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["t"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		await agent.prompt("first");
		agent.steer(userMessage("late steer"));
		await agent.waitForIdle();
		await Bun.sleep(20);
		metric("s1_orphaned_after_turn_end", agent.hasQueuedSteering());
		metric("s1_model_calls", mock.calls.length);
	});

	it("S2: orphan consumed by NEXT unrelated prompt", async () => {
		const mock = createMockModel({ responses: [{ content: ["done"] }, { content: ["second"] }] });
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["t"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		await agent.prompt("first");
		agent.steer(userMessage("orphan"));
		await agent.prompt("second prompt");
		const secondCallUsers = mock.calls[1]!.context.messages.filter(m => m.role === "user").length;
		metric("s2_orphan_consumed_by_next_prompt", !agent.hasQueuedSteering());
		metric("s2_user_messages_in_second_call", secondCallUsers);
		metric("s2_history_order", userTexts(agent).join("|"));
	});

	it("S3: one-at-a-time: N orphans leak across N turns", async () => {
		const mock = createMockModel({ responses: Array.from({ length: 8 }, (_, i) => ({ content: [`r${i}`] })) });
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["t"], tools: [], messages: [] },
			streamFn: mock.stream,
			steeringMode: "one-at-a-time",
		});
		await agent.prompt("p0");
		agent.steer(userMessage("o1"));
		agent.steer(userMessage("o2"));
		agent.steer(userMessage("o3"));
		await agent.prompt("p1");
		metric("s3_left_after_p1", agent.snapshotSteering().length);
		await agent.prompt("p2");
		metric("s3_left_after_p2", agent.snapshotSteering().length);
		await agent.prompt("p3");
		metric("s3_left_after_p3", agent.snapshotSteering().length);
		metric("s3_history", userTexts(agent).join("|"));
	});

	it("S3b: steeringMode=all drains all orphans into next prompt", async () => {
		const mock = createMockModel({ responses: Array.from({ length: 4 }, (_, i) => ({ content: [`r${i}`] })) });
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["t"], tools: [], messages: [] },
			streamFn: mock.stream,
			steeringMode: "all",
		});
		await agent.prompt("p0");
		agent.steer(userMessage("o1"));
		agent.steer(userMessage("o2"));
		agent.steer(userMessage("o3"));
		await agent.prompt("p1");
		metric("s3b_left_after_p1", agent.snapshotSteering().length);
		metric("s3b_history", userTexts(agent).join("|"));
	});

	it("S4: interruptMode=wait: steer during a tool", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const waitTool: AgentTool = {
			name: "wait", label: "Wait", description: "parks", parameters: z.object({}),
			execute: async () => { entered.resolve(); await release.promise; return { content: [{ type: "text", text: "ok" }] }; },
		};
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", name: "wait", arguments: {} }] },
				{ content: ["after tool"] },
				{ content: ["steered"] },
			],
		});
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["t"], tools: [waitTool], messages: [] },
			streamFn: mock.stream,
			toolInterruptPolicy: "finish_tools",
		});
		const run = agent.prompt("go");
		await entered.promise;
		agent.steer(userMessage("mid-tool steer"));
		release.resolve();
		await run;
		metric("s4_wait_consumed_at_tool_boundary", !agent.hasQueuedSteering());
		metric("s4_model_calls", mock.calls.length);
		metric("s4_history", userTexts(agent).join("|"));
	});

	it("S4b: interruptMode=wait, steer during tool, then assistant goes idle in the same run? (two tools)", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const tool: AgentTool = {
			name: "wait", label: "Wait", description: "parks", parameters: z.object({}),
			execute: async () => { entered.resolve(); await release.promise; return { content: [{ type: "text", text: "ok" }] }; },
		};
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", name: "wait", arguments: {} }, { type: "toolCall", name: "wait", arguments: {} }] },
				{ content: ["after tools"] },
				{ content: ["steered"] },
			],
		});
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["t"], tools: [tool], messages: [] },
			streamFn: mock.stream,
			toolInterruptPolicy: "finish_tools",
		});
		const run = agent.prompt("go");
		await entered.promise;
		agent.steer(userMessage("mid-batch steer"));
		release.resolve();
		await run;
		const toolResults = agent.state.messages.filter(m => m.role === "toolResult").length;
		metric("s4b_wait_both_tools_ran", toolResults);
		metric("s4b_consumed", !agent.hasQueuedSteering());
		metric("s4b_history", agent.state.messages.map(m => m.role).join(","));
	});

	it("S5: continue() with assistant tail + steeringMode=all takes all", async () => {
		const mock = createMockModel({ responses: [{ content: ["a"] }, { content: ["b"] }] });
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["t"], tools: [], messages: [] },
			streamFn: mock.stream,
			steeringMode: "all",
		});
		await agent.prompt("p0");
		agent.steer(userMessage("o1"));
		agent.steer(userMessage("o2"));
		await agent.continue();
		metric("s5_users_in_continue_call", mock.calls[1]!.context.messages.filter(m => m.role === "user").length);
	});

	it("S6: steer during a no-tool stream is orphaned", async () => {
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>(r => (releaseFirst = r));
		const mock = createMockModel({
			responses: [async () => { await firstGate; return { content: ["first"] }; }, { content: ["second"] }],
		});
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["t"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		const run = agent.prompt("p0");
		await Bun.sleep(5);
		agent.steer(userMessage("during-first-model-call"));
		releaseFirst();
		await run;
		metric("s6_steer_during_no_tool_stream_orphaned", agent.hasQueuedSteering());
	});

	it("S7: abort() mid-stream with queued steer: steer survives, no owner", async () => {
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>(r => (releaseFirst = r));
		const mock = createMockModel({
			responses: [async (_c, o) => { await Promise.race([firstGate, new Promise(r => o?.signal?.addEventListener("abort", r))]); return { content: ["first"] }; }, { content: ["second"] }],
		});
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["t"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		const run = agent.prompt("p0");
		await Bun.sleep(5);
		agent.steer(userMessage("steer-then-abort"));
		agent.abort();
		releaseFirst();
		await run.catch(() => {});
		await agent.waitForIdle();
		metric("s7_steer_survives_abort", agent.hasQueuedSteering());
		metric("s7_last_role", agent.state.messages.at(-1)?.role ?? "none");
	});
});

describe("AgentSession steer/turn model", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@ar-steer-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});
	afterEach(async () => {
		for (const line of metrics.splice(0)) console.log(line);
		if (session) { await session.dispose(); session = undefined; }
		authStorage.close();
		tempDir.removeSync();
	});

	function build(responses: any[], opts?: { steeringMode?: "all" | "one-at-a-time"; interruptMode?: "immediate" | "wait"; tools?: AgentTool[] }) {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ responses });
		const agent = new Agent({
			getApiKey: p => `${p}-key`,
			initialState: { model, systemPrompt: ["t"], tools: opts?.tools ?? [], messages: [] },
			streamFn: mock.stream,
			steeringMode: opts?.steeringMode,
			toolInterruptPolicy: opts?.interruptMode === "wait" ? "finish_tools" : opts?.interruptMode === "immediate" ? "abort_tools" : undefined,
		});
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const s = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		return { s, mock, agent };
	}
	async function promptDone(s: AgentSession, text: string) { await s.prompt(text); await s.waitForIdle(); }
	async function settle(s: AgentSession) { for (let i = 0; i < 5; i++) { await s.waitForIdle(); await Bun.sleep(30); } await s.waitForIdle(); }

	it("A1: session.steer() on idle session — one-at-a-time", async () => {
		const { s, mock } = build([{ content: ["a"] }, { content: ["b"] }, { content: ["c"] }]);
		session = s;
		await promptDone(s, "p0");
		await s.steer("idle steer 1");
		await s.steer("idle steer 2");
		await settle(s);
		metric("a1_left_after_idle_steers", s.agent.snapshotSteering().length);
		metric("a1_display_left", s.pendingMessageCounts.steering);
		metric("a1_model_calls", mock.calls.length);
		metric("a1_history", userTexts(s.agent).join("|"));
	});

	it("A2: session.prompt(streamingBehavior=steer) on IDLE session", async () => {
		const { s, mock } = build([{ content: ["a"] }, { content: ["b"] }]);
		session = s;
		await promptDone(s, "p0");
		let err: unknown;
		try { await s.prompt("late", { streamingBehavior: "steer" }); } catch (e) { err = e; }
		await settle(s);
		metric("a2_idle_steer_prompt_threw", err !== undefined);
		metric("a2_model_calls", mock.calls.length);
		metric("a2_queued_steering", s.agent.snapshotSteering().length);
	});

	it("A3: raw agent.steer() after turn end — visible to session?", async () => {
		const { s } = build([{ content: ["a"] }, { content: ["b"] }]);
		session = s;
		await promptDone(s, "p0");
		s.agent.steer(userMessage("raw orphan"));
		await settle(s);
		metric("a3_agent_queue_len", s.agent.snapshotSteering().length);
		metric("a3_session_display_len", s.pendingMessageCounts.steering);
		metric("a3_session_hasQueuedSteering", s.hasQueuedSteering);
	});

	it("A4: wait + all: steers during no-tool stream via session", async () => {
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>(r => (releaseFirst = r));
		const { s, mock } = build(
			[async () => { await firstGate; return { content: ["first"] }; }, { content: ["second"] }, { content: ["third"] }, { content: ["fourth"] }],
			{ steeringMode: "all", interruptMode: "wait" },
		);
		session = s;
		const run = s.prompt("p0");
		await Bun.sleep(10);
		await s.prompt("steer-A", { streamingBehavior: "steer" });
		await s.prompt("steer-B", { streamingBehavior: "steer" });
		metric("a4_display_during_stream", s.pendingMessageCounts.steering);
		releaseFirst();
		await run;
		await settle(s);
		metric("a4_steer_left_after_p0", s.agent.snapshotSteering().length);
		metric("a4_display_left_after_p0", s.pendingMessageCounts.steering);
		metric("a4_calls_after_p0", mock.calls.length);
		metric("a4_history_after_p0", userTexts(s.agent).join("|"));
		metric("a4_roles_after_p0", s.agent.state.messages.map(m => m.role).join(","));
		await promptDone(s, "p1");
		await settle(s);
		metric("a4_steer_left_after_p1", s.agent.snapshotSteering().length);
		metric("a4_history_after_p1", userTexts(s.agent).join("|"));
		metric("a4_calls_after_p1", mock.calls.length);
		metric("a4_roles_after_p1", s.agent.state.messages.map(m => m.role).join(","));
	});

	it("A5: wait + one-at-a-time: steers during no-tool stream via session", async () => {
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>(r => (releaseFirst = r));
		const { s, mock } = build(
			[async () => { await firstGate; return { content: ["first"] }; }, { content: ["second"] }, { content: ["third"] }, { content: ["fourth"] }, { content: ["fifth"] }],
			{ steeringMode: "one-at-a-time", interruptMode: "wait" },
		);
		session = s;
		const run = s.prompt("p0");
		await Bun.sleep(10);
		await s.prompt("steer-A", { streamingBehavior: "steer" });
		await s.prompt("steer-B", { streamingBehavior: "steer" });
		releaseFirst();
		await run;
		await settle(s);
		metric("a5_steer_left_after_p0", s.agent.snapshotSteering().length);
		metric("a5_calls_after_p0", mock.calls.length);
		metric("a5_history_after_p0", userTexts(s.agent).join("|"));
		metric("a5_roles_after_p0", s.agent.state.messages.map(m => m.role).join(","));
		await promptDone(s, "p1");
		await settle(s);
		metric("a5_steer_left_after_p1", s.agent.snapshotSteering().length);
		metric("a5_history_after_p1", userTexts(s.agent).join("|"));
		metric("a5_calls_after_p1", mock.calls.length);
		metric("a5_roles_after_p1", s.agent.state.messages.map(m => m.role).join(","));
	});

	it("A6: wait + all + tool: steer during tool then abort during tool", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const tool: AgentTool = {
			name: "wait", label: "Wait", description: "parks", parameters: z.object({}),
			execute: async (_a, signal) => { entered.resolve(); await Promise.race([release.promise, new Promise(r => signal?.addEventListener("abort", r))]); return { content: [{ type: "text", text: "ok" }] }; },
		};
		const { s, mock } = build(
			[{ content: [{ type: "toolCall", name: "wait", arguments: {} }] }, { content: ["after"] }, { content: ["steered"] }, { content: ["x"] }],
			{ steeringMode: "all", interruptMode: "wait", tools: [tool] },
		);
		session = s;
		const run = s.prompt("p0");
		await entered.promise;
		await s.prompt("steer-A", { streamingBehavior: "steer" });
		await s.abort({ cause: "user_interrupt" });
		release.resolve();
		await run.catch(() => {});
		await settle(s);
		metric("a6_steer_left_after_abort", s.agent.snapshotSteering().length);
		metric("a6_calls", mock.calls.length);
		metric("a6_history", userTexts(s.agent).join("|"));
		metric("a6_roles", s.agent.state.messages.map(m => m.role).join(","));
	});


	it("A8: sendCustomMessage(deliverAs=steer) during post-prompt unwind window (isStreaming true, agent idle)", async () => {
		const { s, mock } = build([{ content: ["p0"] }, { content: ["p1"] }, { content: ["p2"] }]);
		session = s;
		// Capture the moment agent_end fires but session.isStreaming may still be true.
		let sawEnd = false; let steeredInWindow = false; let agentStreamingAtEnd: boolean | undefined; let sessionStreamingAtEnd: boolean | undefined;
		const unsub = s.subscribe(ev => {
			if (ev.type === "agent_end" && !sawEnd) {
				sawEnd = true;
				agentStreamingAtEnd = s.agent.state.isStreaming;
				sessionStreamingAtEnd = s.isStreaming;
				void s.sendCustomMessage({ customType: "ar-test", content: "custom-steer-in-unwind", display: false, attribution: "agent" }, { deliverAs: "steer" }).then(() => { steeredInWindow = true; });
			}
		});
		await promptDone(s, "p0");
		await settle(s);
		unsub();
		metric("a8_agent_streaming_at_end", String(agentStreamingAtEnd));
		metric("a8_session_streaming_at_end", String(sessionStreamingAtEnd));
		metric("a8_sent", steeredInWindow);
		metric("a8_steer_left", s.agent.snapshotSteering().length);
		metric("a8_calls", mock.calls.length);
		metric("a8_roles", s.agent.state.messages.map(m => m.role).join(","));
	});

	it("A9: raw agent orphan + steer-on-interrupt Esc: orphan silently drains", async () => {
		const { s, mock } = build([{ content: ["p0"] }, { content: ["p1"] }, { content: ["p2"] }]);
		session = s;
		await promptDone(s, "p0");
		s.agent.steer(userMessage("orphan-1"));
		s.agent.steer(userMessage("orphan-2"));
		metric("a9_session_hasQueuedSteering_before_esc", s.hasQueuedSteering);
		metric("a9_display_count_before_esc", s.pendingMessageCounts.steering);
		await s.abort({ cause: "user_interrupt" });
		await settle(s);
		metric("a9_left_after_esc", s.agent.snapshotSteering().length);
		metric("a9_calls_after_esc", mock.calls.length);
		metric("a9_history_after_esc", userTexts(s.agent).join("|"));
	});

	it("A10: steeringMode=all vs one-at-a-time: session.steer twice while idle", async () => {
		const { s, mock } = build([{ content: ["p0"] }, { content: ["p1"] }, { content: ["p2"] }, { content: ["p3"] }], { steeringMode: "all" });
		session = s;
		await promptDone(s, "p0");
		const a = s.steer("idle-A");
		const b = s.steer("idle-B");
		await Promise.all([a, b]);
		await settle(s);
		metric("a10_all_calls", mock.calls.length);
		metric("a10_all_history", userTexts(s.agent).join("|"));
		metric("a10_all_left", s.agent.snapshotSteering().length);
	});


	it("A11: sendCustomMessage(deliverAs=steer) in the agent_end→prompt-finally unwind window", async () => {
		const { s, mock } = build([{ content: ["p0"] }, { content: ["p1"] }, { content: ["p2"] }]);
		session = s;
		let sessionStreamingAtAgentEnd: boolean | undefined; let agentStreamingAtAgentEnd: boolean | undefined; let sent = false; let sendErr = "";
		const unsub = s.agent.subscribe(ev => {
			if (ev.type === "agent_end" && sessionStreamingAtAgentEnd === undefined) {
				agentStreamingAtAgentEnd = s.agent.state.isStreaming;
				sessionStreamingAtAgentEnd = s.isStreaming;
				s.sendCustomMessage({ customType: "ar-test", content: "custom-steer-in-unwind", display: false, attribution: "agent" }, { deliverAs: "steer" }).then(() => { sent = true; }, e => { sendErr = String(e); });
			}
		});
		await promptDone(s, "p0");
		await settle(s);
		unsub();
		metric("a11_agent_streaming_at_agent_end", String(agentStreamingAtAgentEnd));
		metric("a11_session_streaming_at_agent_end", String(sessionStreamingAtAgentEnd));
		metric("a11_sent", sent);
		metric("a11_send_err", sendErr || "none");
		metric("a11_steer_left_orphaned", s.agent.snapshotSteering().length);
		metric("a11_display_count", s.pendingMessageCounts.steering);
		metric("a11_calls", mock.calls.length);
		metric("a11_roles", s.agent.state.messages.map(m => m.role).join(","));
	});

	it("A12: session.steer() in the same unwind window (for contrast)", async () => {
		const { s, mock } = build([{ content: ["p0"] }, { content: ["p1"] }, { content: ["p2"] }]);
		session = s;
		let sessionStreamingAtAgentEnd: boolean | undefined; let sent = false; let sendErr = "";
		const unsub = s.agent.subscribe(ev => {
			if (ev.type === "agent_end" && sessionStreamingAtAgentEnd === undefined) {
				sessionStreamingAtAgentEnd = s.isStreaming;
				s.steer("public-steer-in-unwind").then(() => { sent = true; }, e => { sendErr = String(e); });
			}
		});
		await promptDone(s, "p0");
		await settle(s);
		unsub();
		metric("a12_session_streaming_at_agent_end", String(sessionStreamingAtAgentEnd));
		metric("a12_sent", sent);
		metric("a12_send_err", sendErr || "none");
		metric("a12_steer_left", s.agent.snapshotSteering().length);
		metric("a12_calls", mock.calls.length);
		metric("a12_roles", s.agent.state.messages.map(m => m.role).join(","));
	});

	it("A13: SDK-style custom steer (sdk/session.ts pattern) after turn end", async () => {
		const { s, mock } = build([{ content: ["p0"] }, { content: ["p1"] }]);
		session = s;
		await promptDone(s, "p0");
		s.agent.steer({ role: "custom", customType: "sdk-inject", content: "sdk-custom-steer", display: false, timestamp: Date.now() } as any);
		await settle(s);
		metric("a13_orphaned", s.agent.snapshotSteering().length);
		metric("a13_display", s.pendingMessageCounts.steering);
		metric("a13_hasQueuedSteering", s.hasQueuedSteering);
		metric("a13_calls", mock.calls.length);
	});


	it("A14: cancelAndSubmit with queued steers: steers become follow-ups drained turn after turn", async () => {
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>(r => (releaseFirst = r));
		const { s, mock } = build(
			[async (_c: any, o: any) => { await Promise.race([firstGate, new Promise(r => o?.signal?.addEventListener("abort", r))]); return { content: ["first"] }; }, { content: ["new"] }, { content: ["fA"] }, { content: ["fB"] }, { content: ["x"] }],
			{ steeringMode: "all", interruptMode: "wait" },
		);
		session = s;
		const run = s.prompt("p0");
		await Bun.sleep(200); // let the agent loop actually start (past preflight)
		metric("a14_agent_streaming_before_steer", s.agent.state.isStreaming);
		await s.prompt("steer-A", { streamingBehavior: "steer" });
		await s.prompt("steer-B", { streamingBehavior: "steer" });
		metric("a14_queued_steer_before_cancel", s.agent.snapshotSteering().length);
		const outcome = await s.cancelAndSubmit("new");
		releaseFirst();
		await run.catch(() => {});
		metric("a14_outcome", outcome.kind);
		metric("a14_steer_len_after_cancel", s.agent.snapshotSteering().length);
		metric("a14_followup_len_after_cancel", s.agent.snapshotFollowUp().length);
		metric("a14_display_followup_after_cancel", s.pendingMessageCounts.followUp);
		await settle(s);
		metric("a14_calls_after_settle", mock.calls.length);
		metric("a14_followup_left_after_settle", s.agent.snapshotFollowUp().length);
		metric("a14_history", userTexts(s.agent).join("|"));
		metric("a14_roles", s.agent.state.messages.map(m => m.role).join(","));
	});

	it("A15: steer submitted during session prompt PREFLIGHT lands in the first model call", async () => {
		const { s, mock } = build([{ content: ["first"] }, { content: ["second"] }], { steeringMode: "all" });
		session = s;
		const run = s.prompt("p0");
		// no sleep: the session is 'busy' (in-flight prompt) but the agent loop has not started.
		metric("a15_agent_streaming_at_steer", s.agent.state.isStreaming);
		metric("a15_session_streaming_at_steer", s.isStreaming);
		let steerErr = "none"; let p0Err = "none";
		await s.prompt("steer-early", { streamingBehavior: "steer" }).catch(e => { steerErr = String((e as any)?.code ?? e) + ":" + String((e as any)?.message) + ":" + String((e as any)?.stack ?? "").split("\n").slice(1,4).join(" / "); });
		await run.catch(e => { p0Err = String((e as any)?.code ?? e); });
		await settle(s);
		metric("a15_steer_prompt_err", steerErr);
		metric("a15_p0_err", p0Err);
		metric("a15_users_in_first_call", mock.calls[0]?.context.messages.filter(m => m.role === "user").length ?? -1);
		metric("a15_calls", mock.calls.length);
		metric("a15_history", userTexts(s.agent).join("|"));
	});

	it("A7: raw orphan then sendCustomMessage(steer) while streaming — mixed ordering", async () => {
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>(r => (releaseFirst = r));
		const { s, mock } = build(
			[{ content: ["p0"] }, async () => { await firstGate; return { content: ["p1"] }; }, { content: ["p2"] }, { content: ["p3"] }],
			{ steeringMode: "all" },
		);
		session = s;
		await promptDone(s, "p0");
		s.agent.steer(userMessage("raw-orphan"));
		const run = s.prompt("p1");
		await Bun.sleep(10);
		metric("a7_orphan_consumed_at_p1_start", s.agent.snapshotSteering().length === 0);
		releaseFirst();
		await run;
		await settle(s);
		metric("a7_history", userTexts(s.agent).join("|"));
		metric("a7_calls", mock.calls.length);
	});
});
EOF
cd "$ROOT" || exit 1
bun test "$TEST" 2>&1 | tee "$TMP/out.txt"
status=${PIPESTATUS[0]}
echo "---- METRICS ----"
grep '^METRIC' "$TMP/out.txt"
echo "METRIC harness_exit=$status"
echo "METRIC tmpdir=$TMP"
exit "$status"
