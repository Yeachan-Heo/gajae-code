import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@gajae-code/ai";
import { classifyFallbackTrigger } from "@gajae-code/ai/utils/fallback-transport";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { initializeExtensions } from "../../src/modes/runtime-init";
import { createAgentSession } from "../../src/sdk";
import { type FixtureBrokerLease, startFixtureBrokerWithLeaseForTest } from "../../src/sdk/broker/ensure";
import { SdkClient } from "../../src/sdk/client";
import type { TurnResultPage } from "../../src/sdk/turn-result";
import type { AgentSession, AgentSessionEvent } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { type SessionEntry, SessionManager } from "../../src/session/session-manager";
import { createFixtureBrokerEnvironment, withFixtureBrokerEnvironment } from "./fixture-broker-cleanup";

export const EMPTY_STOP_SCENARIOS = [
	"fallback-disabled",
	"fallback-enabled",
	"untyped-disabled",
	"untyped-fallback",
	"nonzero-usage",
] as const;
export type EmptyStopScenario = (typeof EMPTY_STOP_SCENARIOS)[number];
const PROVIDER = "empty-stop-fixture";
const PRIMARY = "primary";
const FALLBACK = "fallback";
const FALLBACK_TEXT = "fallback-ok";
const WAIT_MS = 15_000;

export interface ScenarioReport {
	scenario: EmptyStopScenario;
	providerModels: string[];
	terminal: TurnResultPage;
	replay: TurnResultPage;
	terminalFrames: Record<string, unknown>[];
	selectedModel: string;
	assistantMessages: AssistantMessage[];
	lifecycle: string[];
	switches: Array<{ from: string; to: string; reason: string }>;
	managedTranscriptExists: boolean;
}

export function parseHarnessPort(value: string | undefined = process.env.PORT_BASE): number {
	const port = value === undefined ? 30200 : Number(value);
	if (
		value?.trim() === "" ||
		!Number.isInteger(port) ||
		(port !== 0 && (port < 30200 || port > 30219) && (port < 52440 || port > 52459))
	)
		throw new Error("PORT_BASE must be 0, between 30200 and 30219, or between 52440 and 52459");
	return port;
}

export function scenarioNames(args: readonly string[]): EmptyStopScenario[] {
	if (args.length === 0) return [...EMPTY_STOP_SCENARIOS];
	return args.map(arg => {
		const scenario = EMPTY_STOP_SCENARIOS.find(name => name === arg);
		if (!scenario) throw new Error(`Unknown scenario: ${arg}`);
		return scenario;
	});
}

export function assertExecutedScenarios(count: number): void {
	assert.ok(Number.isInteger(count) && count > 0, "Zero scenarios executed");
}

/** OpenAI-compatible wire bytes, not an injected model stream. */
export function providerSse(model: string, text: string, tokens: number | undefined): Response {
	const chunk = (delta: Record<string, string>, finishReason: string | null, includeUsage: boolean) => ({
		id: "empty-stop-fixture",
		object: "chat.completion.chunk",
		created: 0,
		model,
		choices: [{ index: 0, delta, finish_reason: finishReason }],
		...(includeUsage && tokens !== undefined
			? { usage: { prompt_tokens: tokens, completion_tokens: tokens, total_tokens: tokens * 2 } }
			: {}),
	});
	const data = [chunk({ role: "assistant", content: text }, null, false), chunk({}, "stop", true)];
	return new Response(`${data.map(item => `data: ${JSON.stringify(item)}\n\n`).join("")}data: [DONE]\n\n`, {
		headers: { "content-type": "text/event-stream" },
	});
}

/** Reject unexpected routes/models instead of hiding routing failures behind an empty response. */
export async function handleProviderRequest(
	request: Request,
	scenario: EmptyStopScenario,
	models: string[],
): Promise<Response> {
	if (new URL(request.url).pathname !== "/v1/chat/completions" || request.method !== "POST")
		throw new Error("Unexpected provider route");
	const body: unknown = await request.json();
	const model = record(body).model;
	if (model !== PRIMARY && model !== FALLBACK) throw new Error("Unexpected provider model");
	models.push(model);
	if (model === FALLBACK) {
		assert.ok(usesFallback(scenario), "Unexpected fallback request");
		return providerSse(model, FALLBACK_TEXT, 1);
	}
	if (scenario === "untyped-fallback" || scenario === "untyped-disabled") return providerSse(model, "", undefined);
	if (scenario === "nonzero-usage") return providerSse(model, "", 1);
	return providerSse(model, "", 0);
}

function usesFallback(scenario: EmptyStopScenario): boolean {
	return scenario === "fallback-enabled" || scenario === "untyped-fallback";
}

function record(value: unknown): Record<string, unknown> {
	assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), "Expected object response");
	return value as Record<string, unknown>;
}

export function responseResult(value: unknown): Record<string, unknown> {
	const response = record(value);
	assert.equal(response.ok, true, "SDK request failed");
	return record(response.result);
}

export async function assertManagedTranscript(
	manager: SessionManager,
	assistants: readonly AssistantMessage[],
): Promise<void> {
	await manager.ensureOnDisk();
	await manager.flush();
	const transcript = manager.getSessionFile();
	assert.ok(transcript, "Missing managed transcript path");
	const entries = Bun.JSONL.parse(await Bun.file(transcript).text()) as SessionEntry[];
	const persisted = entries.flatMap(entry =>
		entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : [],
	);
	// JSONL omits optional undefined fields (for example, errorMessage on a stop).
	const expected: unknown = JSON.parse(JSON.stringify(assistants));
	assert.deepEqual(persisted, expected, "Managed transcript must contain only accepted assistant messages");
}

export function assertScenarioReport(report: ScenarioReport): void {
	const fallback = usesFallback(report.scenario);
	const failed = report.scenario === "fallback-disabled" || report.scenario === "untyped-disabled";
	assert.deepEqual(report.providerModels, fallback ? [PRIMARY, FALLBACK] : [PRIMARY], "Provider model sequence");
	assert.equal(report.selectedModel, `${PROVIDER}/${fallback ? FALLBACK : PRIMARY}`, "Selected fallback model");
	assert.ok(report.managedTranscriptExists, "Managed transcript was not persisted");
	assert.equal(report.terminal.status, failed ? "failed" : "terminal_ok", "Terminal status");
	assert.ok(report.terminal.commandId && report.terminal.turnId, "Missing accepted correlation");
	assert.deepEqual(report.replay, report.terminal, "Durable terminal query changed");
	assert.equal(report.terminalFrames.length, 1, "Terminal lifecycle must publish exactly once");
	const boundary = record(report.terminalFrames[0].payload);
	assert.equal(boundary.commandId, report.terminal.commandId, "Terminal command correlation");
	assert.equal(boundary.turnId, report.terminal.turnId, "Terminal turn correlation");
	assert.equal(record(boundary.outcome).kind, failed ? "failed" : "stopped", "Wire terminal outcome");
	assert.deepEqual(
		report.lifecycle,
		["message_start", "message_end", "turn_end", "agent_end"],
		"Accepted-only lifecycle",
	);
	assert.equal(report.assistantMessages.length, 1, "Failed attempts leaked into transcript");
	const assistant = report.assistantMessages[0];
	if (failed) {
		if (report.scenario === "untyped-disabled") {
			assert.equal(report.terminal.error?.code, "empty_response", "Explicit SDK local empty-stop error");
			assert.equal(assistant.errorKind, "local_empty_response", "Agent-loop empty-stop promotion");
		} else {
			assert.equal(report.terminal.error?.code, "provider_rejected", "Explicit SDK provider error");
			assert.equal(record(report.terminal.outcome).providerCode, "empty_response", "SDK empty-stop provider code");
			assert.equal(
				classifyFallbackTrigger(assistant.transportFailure).class,
				"server",
				"Replay-safe failure classification",
			);
		}
		assert.equal(assistant.stopReason, "error");
		assert.match(assistant.errorMessage ?? "", /empty response with zero token usage/i);
		assert.deepEqual(assistant.content, []);
		assert.equal(assistant.usage.totalTokens, 0);
	} else {
		assert.equal(assistant.stopReason, "stop");
		if (fallback) {
			assert.equal(report.terminal.content?.text, FALLBACK_TEXT, "Fallback output on SDK query");
			assert.deepEqual(assistant.content, [{ type: "text", text: FALLBACK_TEXT }], "Accepted fallback output");
		} else {
			assert.deepEqual(assistant.content, []);
			assert.ok(assistant.usage.totalTokens > 0, "Nonzero-usage guard");
		}
	}
	// Replay safety is private: actual switching after a clean HTTP attempt plus an
	// accepted-only transcript/lifecycle proves session admission, not merely query replay.
	if (fallback) {
		assert.equal(report.switches.length, 1, "Missing clean-attempt fallback admission");
		assert.equal(report.switches[0].from, `${PROVIDER}/${PRIMARY}`);
		assert.equal(report.switches[0].to, `${PROVIDER}/${FALLBACK}`);
		assert.equal(report.switches[0].reason, "server", "Session fallback classification");
	} else assert.deepEqual(report.switches, [], "Unexpected fallback switch");
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
	const deadline = Date.now() + WAIT_MS;
	while (!(await predicate())) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
		await Bun.sleep(10);
	}
}

export async function runManagedEmptyStopScenario(
	scenario: EmptyStopScenario,
	port = parseHarnessPort(),
): Promise<ScenarioReport> {
	parseHarnessPort(String(port));
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-empty-stop-"));
	const agentDir = path.join(root, "agent");
	const cwd = path.join(root, "workspace");
	const models: string[] = [];
	const runtimeErrors: unknown[] = [];
	let server: Bun.Server<undefined> | undefined;
	let client: SdkClient | undefined;
	let session: AgentSession | undefined;
	let auth: AuthStorage | undefined;
	let lease: FixtureBrokerLease | undefined;
	let unsubscribeFrames: (() => void) | undefined;
	let unsubscribeSession: (() => void) | undefined;
	let failure: unknown;
	let result: ScenarioReport | undefined;
	const errors: unknown[] = [];
	try {
		await fs.mkdir(cwd, { recursive: true });
		server = Bun.serve({
			hostname: "127.0.0.1",
			port,
			fetch: async request => {
				try {
					return await handleProviderRequest(request, scenario, models);
				} catch (error) {
					runtimeErrors.push(error);
					return new Response("Provider fixture rejected request", { status: 400 });
				}
			},
		});
		const baseUrl = `http://127.0.0.1:${server.port}/v1`;
		result = await withFixtureBrokerEnvironment(async () => {
			const env = createFixtureBrokerEnvironment(root, agentDir);
			lease = (await startFixtureBrokerWithLeaseForTest({ agentDir, env })).lease;
			auth = await AuthStorage.create(path.join(agentDir, "auth.db"));
			const settings = Settings.isolated({
				"compaction.enabled": false,
				"contextPromotion.enabled": false,
				"todo.reminders": false,
				"fallback.maxAttempts": 1,
				"retry.enabled": false,
				"retry.baseDelayMs": 1,
				"fallback.circuitCooldownMs": 0,
			});
			settings.setModelRole("default", `${PROVIDER}/${PRIMARY}`);
			const registry = new ModelRegistry(auth, path.join(agentDir, "models.yml"), settings);
			registry.registerProvider(PROVIDER, {
				baseUrl,
				api: "openai-completions",
				apiKey: "fixture-only-key",
				models: [PRIMARY, FALLBACK].map(id => ({
					id,
					name: id,
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 32768,
					maxTokens: 4096,
				})),
			});
			const primary = registry.find(PROVIDER, PRIMARY);
			assert.ok(primary, "Fixture model registration failed");
			({ session } = await createAgentSession({
				cwd,
				agentDir,
				settings,
				authStorage: auth,
				modelRegistry: registry,
				model: primary,
				sessionManager: SessionManager.create(cwd, SessionManager.managedDestination(cwd, agentDir)),
				disableExtensionDiscovery: true,
				enableMcpAutoload: false,
				enableLsp: false,
				skipPythonPreflight: true,
				deferOptionalModelRefresh: true,
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
			}));
			session.setConfiguredModelChain(
				"default",
				usesFallback(scenario) ? [`${PROVIDER}/${PRIMARY}`, `${PROVIDER}/${FALLBACK}`] : [`${PROVIDER}/${PRIMARY}`],
				"connected-local",
			);
			const events: AgentSessionEvent[] = [];
			unsubscribeSession = session.subscribe(event => events.push(event));
			await initializeExtensions(session, {
				reportSendError: (_action, error) => runtimeErrors.push(error),
				reportRuntimeError: error => runtimeErrors.push(error),
			});
			const endpointFile = path.join(cwd, ".gjc", "state", "sdk", `${session.sessionId}.json`);
			await waitUntil(() => Bun.file(endpointFile).exists(), "SDK endpoint");
			assert.deepEqual(runtimeErrors, [], "SDK startup errors");
			const endpoint = record(await Bun.file(endpointFile).json());
			assert.equal(typeof endpoint.url, "string");
			assert.equal(typeof endpoint.token, "string");
			client = await SdkClient.connect(endpoint.url as string, endpoint.token as string, {
				capabilities: ["turn_stream"],
				reconnectAttempts: 0,
				timeoutMs: WAIT_MS,
			});
			const frames: Record<string, unknown>[] = [];
			const terminalFrame = Promise.withResolvers<void>();
			let correlation: { commandId: string; turnId: string } | undefined;
			const correlatedFrames = () =>
				frames.filter(frame => {
					if (!correlation || frame.kind !== "agent_end" || frame.payload === undefined) return false;
					const payload = record(frame.payload);
					return payload.commandId === correlation.commandId && payload.turnId === correlation.turnId;
				});
			unsubscribeFrames = client.onFrame(frame => {
				frames.push(frame);
				if (correlatedFrames().length > 0) terminalFrame.resolve();
			});
			const accepted = responseResult(
				await client.control("turn.prompt", { text: "Exercise empty stop", clientRef: scenario }),
			);
			assert.equal(accepted.accepted, true);
			assert.equal(typeof accepted.commandId, "string");
			assert.equal(typeof accepted.turnId, "string");
			correlation = { commandId: accepted.commandId as string, turnId: accepted.turnId as string };
			const input = { kind: "prompt", commandId: accepted.commandId, turnId: accepted.turnId };
			// Terminal publication follows durable reconciliation; query only afterward.
			if (correlatedFrames().length > 0) terminalFrame.resolve();
			const timeout = setTimeout(
				() => terminalFrame.reject(new Error("Timed out waiting for correlated terminal lifecycle")),
				WAIT_MS,
			);
			try {
				await terminalFrame.promise;
			} finally {
				clearTimeout(timeout);
			}
			await session.waitForIdle();
			const terminal = responseResult(await client.query("turn.result", input)) as unknown as TurnResultPage;
			assert.deepEqual(runtimeErrors, [], "Provider/SDK runtime errors");
			const replay = responseResult(await client.query("turn.result", input)) as unknown as TurnResultPage;
			const assistantMessages = session.messages.filter(
				(message): message is AssistantMessage => message.role === "assistant",
			);
			await assertManagedTranscript(session.sessionManager, assistantMessages);
			const transcript = session.sessionManager.getSessionFile();
			const report: ScenarioReport = {
				scenario,
				providerModels: models,
				terminal,
				replay,
				terminalFrames: correlatedFrames(),
				selectedModel: `${session.model?.provider}/${session.model?.id}`,
				assistantMessages,
				lifecycle: events
					.filter(
						event =>
							event.type === "turn_end" ||
							event.type === "agent_end" ||
							((event.type === "message_start" || event.type === "message_end") &&
								event.message.role === "assistant"),
					)
					.map(event => event.type),
				switches: events
					.filter(
						(event): event is Extract<AgentSessionEvent, { type: "model_fallback_switched" }> =>
							event.type === "model_fallback_switched",
					)
					.map(({ from, to, reason }) => ({ from, to, reason })),
				managedTranscriptExists: transcript !== undefined && (await Bun.file(transcript).exists()),
			};
			assertScenarioReport(report);
			return report;
		});
	} catch (error) {
		failure = error;
	} finally {
		unsubscribeFrames?.();
		unsubscribeSession?.();
		const clean = async (operation: () => unknown | Promise<unknown>) => {
			try {
				await operation();
			} catch (error) {
				errors.push(error);
			}
		};
		await clean(async () => await client?.close());
		await clean(async () => await session?.dispose());
		await clean(() => auth?.close());
		await clean(async () => await lease?.close());
		await clean(async () => await server?.stop(true));
		// Never remove storage beneath an owner whose cleanup failed.
		if (errors.length === 0) await clean(async () => await fs.rm(root, { recursive: true, force: true }));
	}
	if (errors.length > 0)
		throw new AggregateError(
			failure === undefined ? errors : [failure, ...errors],
			"Managed empty-stop cleanup failed",
		);
	if (failure !== undefined) throw failure;
	assert.ok(result, "Scenario produced no report");
	return result;
}
