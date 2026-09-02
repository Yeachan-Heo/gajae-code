/**
 * Shared test infrastructure for the sdk-adapter-dispositions suite, split across
 * per-adapter files so each machine-adapter cohort runs under the CI 300s
 * file-timeout budget (issue #4475). Chat-adapter tests are fast and remain in
 * the parent file.
 *
 * Semantics are preserved exactly: every assertion function, fixture, helper,
 * and test ID from the original monolithic file is carried over unchanged.
 */
import { expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { AcpSdkAdapter } from "../../src/sdk/acp";
import { Broker } from "../../src/sdk/broker";
import { brokerOwnerForTest } from "../../src/sdk/broker/ensure";
import { processIncarnation } from "../../src/sdk/broker/process-incarnation";
import { runSdkSessionCli } from "../../src/sdk/cli/session-cli";
import { SdkClient } from "../../src/sdk/client";
import { createSdkMcpServer } from "../../src/sdk/mcp";
import { ADAPTERS, type Adapter, OPERATIONS, type Operation } from "../../src/sdk/protocol/operation-registry";
import type { SessionAttachment } from "../../src/sdk/router";
import { startProductionSdkHost } from "../helpers/sdk-production-host";

export type MachineAdapter = Extract<Adapter, "mcp" | "acp" | "daemonCli">;
export type Expected = "forwarded" | "rejected_before_send" | "internal_only";
export type ObservedRequest = { kind: "control" | "query" | "global"; operation: string };

export function currentHostIncarnation(): string {
	const incarnation = processIncarnation(process.pid);
	if (!incarnation) throw new Error("Current process incarnation is unavailable.");
	return incarnation;
}

export type ParityRow = {
	adapterTestId: string;
	adapter: Adapter;
	disposition: Operation["adapterDispositions"][Adapter];
	expected: Expected;
};

const parityRowsCache: ParityRow[] = (
	JSON.parse(fs.readFileSync(path.join(import.meta.dir, "..", "manifests", "sdk-adapter-parity-v1.json"), "utf8")) as {
		rows: ParityRow[];
	}
).rows;
// Derived from the registry (one row per operation per adapter, plus the C36
// secret-input receipt per adapter) so registry growth cannot silently strand a
// stale hand-maintained count here the way it did in issue #4992.
expect(parityRowsCache).toHaveLength(ADAPTERS.length * (OPERATIONS.length + 1));

export const parityPrefix: Record<Adapter, string> = {
	telegram: "T",
	discord: "D",
	slack: "S",
	mcp: "M",
	acp: "A",
	daemonCli: "L",
};

export function parityRow(adapter: Adapter, operation: Operation, secret = false): ParityRow {
	const adapterTestId = `AD-${parityPrefix[adapter]}-${operation.id}${secret ? "-secret" : ""}`;
	const row = parityRowsCache.find(candidate => candidate.adapterTestId === adapterTestId);
	if (!row) throw new Error(`Missing parity manifest row: ${adapterTestId}`);
	expect(row.adapter).toBe(adapter);
	expect(row.disposition).toBe(operation.adapterDispositions[adapter]);
	return row;
}

export type SdkMcpServer = {
	callTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
	close(): Promise<void>;
};
export type AdapterFixture = {
	repo: string;
	agentDir: string;
	sessionId: string;
	endpoint: { url: string; token: string };
	brokerEndpoint: { url: string; token: string };
	observed: ObservedRequest[];
	acpRouter: {
		request: (
			sessionId: string,
			frame: Record<string, unknown>,
			generation?: number,
			attachment?: SessionAttachment,
		) => Promise<Record<string, unknown>>;
	};
	acpAttachment: SessionAttachment;
	stop: () => Promise<void>;
};

export const machineAdapters: readonly MachineAdapter[] = ["mcp", "acp", "daemonCli"];
export const adapterPrefix: Record<MachineAdapter, string> = { mcp: "M", acp: "A", daemonCli: "L" };

export function expectedOutcome(adapter: MachineAdapter, operation: Operation, secret = false): Expected {
	if (secret) return "rejected_before_send";
	if (operation.sdkId === "session.reconcile_uncertain") return "rejected_before_send";
	if (operation.sdkId === "session.get_endpoint" && (adapter === "mcp" || adapter === "daemonCli"))
		return "rejected_before_send";
	if (operation.kind === "reverse") return "internal_only";
	const disposition = operation.adapterDispositions[adapter];
	if (disposition === "prohibited" || disposition === "provider_only") return "rejected_before_send";
	if (adapter === "daemonCli" && disposition === "machine_only") return "forwarded";
	return disposition === "machine_only" ? "internal_only" : "forwarded";
}
export const expectedDomainErrors: Readonly<Record<string, string>> = {
	"ask.answer": "resource_gone",
	"workflow.gate_answer": "resource_gone",
	"workflow.plan_approve": "resource_gone",
	"session.resume": "resource_gone",
	"session.switch": "resource_gone",
	"session.branch": "resource_gone",
	"queue.message.remove": "resource_gone",
	"queue.message.move": "invalid_position",
	"queue.message.update": "invalid_message",
	"transcript.body": "resource_gone",
	// goal.list/get is intentionally absent: on a goal-less session it now
	// succeeds with an explicit no_active_goal diagnostic payload instead of
	// resource_gone (#4668), so adapters must observe ok: true.
	"session.last_assistant": "resource_gone",
	"resource.body": "resource_gone",
	"artifact.read": "resource_gone",
	"retry.last": "nothing_to_retry",
	"retry.now": "retry_not_pending",
	"bash.background": "not_foldable",
	"compaction.run": "invalid_request",
	"session.handoff": "invalid_request",
	"session.export_html": "invalid_request",
	"auth.login": "operation_not_session_owned",
	"skill.invoke": "invalid_input",
	"turn.result": "invalid_request",
	"mode.plan.set": "unavailable",
	"model.profile.set": "invalid_input",
};
export const expectedGlobalErrors: Readonly<Record<string, string>> = {
	"session.create": "invalid_input",
	"session.fork": "invalid_input",
	"session.resume": "invalid_input",
	"session.close": "invalid_input",
};
export function expectSemanticResult(operation: Operation, result: unknown): void {
	const code = expectedDomainErrors[operation.sdkId];
	if (code) expect(result).toMatchObject({ ok: false, error: { code } });
	else if (operation.sdkId === "goal.list/get") {
		// Envelope shapes differ per adapter: daemon/MCP return { ok, result|data },
		// ACP unwraps to the bare payload. When an ok flag is present it must be true.
		const envelope = result as { ok?: unknown } | null;
		if (envelope !== null && typeof envelope === "object" && "ok" in envelope)
			expect(result).toMatchObject({ ok: true });
		const page =
			(result as { page?: { items?: unknown[] } } | null)?.page ??
			(result as { result?: { page?: { items?: unknown[] } } } | null)?.result?.page ??
			(result as { data?: { page?: { items?: unknown[] } } } | null)?.data?.page;
		// ACP's translated contract for goal.list/get is the same no_active_goal
		// diagnostic page the daemon/MCP surfaces return (#4668 review P2): a
		// missing page is a contract violation, not a pass.
		if (page == null) throw new Error("goal.list/get diagnostic page must be present");
		expect(
			Array.isArray(page.items) && page.items.length > 0,
			"goal.list/get diagnostic must contain at least one item",
		).toBe(true);
		const first = (page as { items: unknown[] }).items[0] as Record<string, unknown> & { message?: unknown };
		expect(first).toMatchObject({ enabled: false, goal: null, reason: "no_active_goal" });
		const msg = first.message;
		expect(
			typeof msg === "string" && (msg as string).length > 0,
			"goal.list/get diagnostic message must be non-empty",
		).toBe(true);
	} else expect(result).toMatchObject({ ok: true });
}

export function expectGlobalSemanticResult(operation: Operation, result: unknown): void {
	if (operation.sdkId === "session.reconcile_uncertain") {
		expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^invalid_(input|request)$/) } });
		return;
	}
	const code = expectedGlobalErrors[operation.sdkId];
	if (code) expect(result).toMatchObject({ ok: false, error: { code } });
	else expect(result).toMatchObject({ ok: true });
}

export function expectedAcpRejection(operation: Operation, secret: boolean): string {
	if (secret) return "secret_field_forbidden";
	if (operation.sdkId === "session.reconcile_uncertain") return "invalid_input";
	const disposition = operation.adapterDispositions.acp;
	if (disposition === "provider_only") return "provider_required";
	if (disposition === "machine_only") return operation.errorCodes[0] ?? "machine_only";
	return "operation_prohibited";
}

export async function expectSdkRejection(promise: Promise<unknown>, code: string): Promise<void> {
	let failure: unknown;
	try {
		await promise;
	} catch (error) {
		failure = error;
	}
	expect(failure).toMatchObject({ code });
}

export function inputFor(operation: Operation, secret = false): Record<string, unknown> {
	if (secret) return { patch: { apiToken: "secret" } };
	switch (operation.sdkId) {
		case "turn.prompt":
		case "turn.steer":
		case "turn.follow_up":
		case "turn.abort_and_prompt":
			return { text: "adapter disposition probe" };
		case "turn.steer_status":
			return { clientRef: "missing-steer" };
		case "ask.answer":
			return { id: "missing-ask", answer: "answer" };
		case "workflow.gate_answer":
			return { id: "missing-gate", response: "approve" };
		case "workflow.plan_approve":
			return { id: "missing-plan", choice: "approve" };
		case "skill.invoke":
			return { name: "missing-skill", args: "" };
		case "mode.plan.set":
		case "compaction.auto.set":
		case "retry.auto.set":
			return { on: true };
		case "mode.goal.operate":
			return { op: "get" };
		case "todo.replace":
			return { items: [] };
		case "model.set":
			return { id: "openai/gpt-4o-mini" };
		case "model.profile.set":
			return { id: "missing-profile" };
		case "thinking.set":
			return { level: "low" };
		case "permission_mode.set":
			return { mode: "prompt" };
		case "queue.steering_mode.set":
		case "queue.follow_up_mode.set":
			return { mode: "one-at-a-time" };
		case "queue.tool_interrupt_policy.set":
			return { mode: "finish_tools" };
		case "bash.execute":
			return { cmd: "printf adapter-disposition" };
		case "session.resume":
		case "session.switch":
		case "session.delete":
			return { id: "missing-session" };
		case "session.branch":
			return { entryId: "missing-entry" };
		case "session.rename":
			return { name: "adapter disposition" };
		case "session.handoff":
			return { instructions: "handoff" };
		case "config.patch":
			return { patch: {} };
		case "runtime.reload":
			return { components: ["tools"] };
		case "auth.login":
			return { provider: "openai" };
		case "host_tools.register":
		case "host_uri.register":
			return { defs: [] };
		case "service_tier.set":
			return { tier: "auto" };
		case "tools.active.set":
			return { names: [] };
		case "queue.message.remove":
			return { id: "missing-message" };
		case "queue.message.move":
			return { id: "missing-message", before: "other-message" };
		case "queue.message.update":
			return { id: "missing-message", patch: { text: "updated" } };
		case "extension.set_enabled":
			return { id: "missing-extension", on: true };
		case "session.cwd.move":
			return { path: process.cwd() };
		case "session.spawn":
			return {
				cwd: process.cwd(),
				task: "adapter disposition probe",
				masterCapability: "capability-shaped-probe",
				model: "openai/gpt-4o-mini",
				profile: "default",
			};
		case "session.get_endpoint":
			return { sessionId: "missing-session" };
		case "transcript.body":
			return { entryId: "missing-entry" };
		case "resource.body":
			return { resourceKind: "transcript", resourceId: "default", revision: "missing", field: "body" };
		case "artifact.read":
			return { artifactId: "missing-artifact", offset: 0, length: 1 };
		default:
			return {};
	}
}

/** Raw lifecycle globals require typed targets; retain broker-side invalid-input probes without launching a session. */
export function daemonCliLifecycleInput(host: AdapterFixture, operation: string): Record<string, unknown> | undefined {
	const invalidStateRoot = path.join(host.repo, ".invalid-state");
	switch (operation) {
		case "session.create":
		case "session.fork":
			return { cwd: host.repo, stateRoot: invalidStateRoot };
		case "session.resume":
			return { cwd: host.repo, stateRoot: invalidStateRoot, sessionId: host.sessionId };
		case "session.close":
			return { sessionId: host.sessionId, endpointGeneration: 0 };
		case "session.delete":
			return { sessionId: "missing-session" };
		case "session.reconcile_uncertain":
			return { sessionId: host.sessionId };
		default:
			return undefined;
	}
}

export async function fixture(): Promise<AdapterFixture> {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-sdk-adapter-dispositions-"));
	const agentDir = path.join(repo, ".gjc", "adapter-agent");
	const stateRoot = path.join(repo, ".gjc", "state");
	Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
	const productionHost = await startProductionSdkHost(repo, { acceptPromptPreflightWithoutExecution: true });
	const sessionId = productionHost.sessionId;
	const observed: ObservedRequest[] = productionHost.observed;
	const broker = new Broker({ agentDir, packageGeneration: "adapter-dispositions" });
	const brokerEndpoint = await broker.start();
	const handleRequest = broker.handleRequest.bind(broker);
	broker.handleRequest = async (operation, input, idempotencyKey) => {
		observed.push({ kind: "global", operation });
		return await handleRequest(operation, input, idempotencyKey);
	};
	const endpointMtimeMs = fs.statSync(path.join(stateRoot, "sdk", `${sessionId}.json`)).mtimeMs;
	const hostIncarnation = currentHostIncarnation();
	await broker.index.append({
		type: "host_registered",
		sessionId,
		locator: { cwd: repo, worktreeRoot: null, stateRoot },
		endpointGeneration: 1,
		pid: process.pid,
		processIncarnation: hostIncarnation,
		hostIncarnation,
		endpointMtimeMs,
	});
	await broker.heartbeatSessions();
	const acpAttachment: SessionAttachment = {
		sessionId,
		generation: 1,
		isCurrent: () => true,
		send: async () => undefined,
		sendMaintenance: () => {},
	};
	const acpRouter = {
		request: async (
			requestedSessionId: string,
			frame: Record<string, unknown>,
			generation?: number,
			attachment?: SessionAttachment,
		): Promise<Record<string, unknown>> => {
			if (
				requestedSessionId !== sessionId ||
				generation !== acpAttachment.generation ||
				attachment !== acpAttachment
			)
				throw new Error("ACP fixture received a non-current SessionAttachment");
			const operation =
				frame.type === "control_request"
					? frame.operation
					: frame.type === "query_request"
						? frame.query
						: undefined;
			if (typeof operation !== "string")
				return { ok: false, error: { code: "invalid_input", message: "invalid frame" } };
			const code = expectedDomainErrors[operation];
			if (code) return { ok: false, error: { code, message: code } };
			// ACP translated contract for goal.list/get (#4668 review P2): a
			// goal-less session succeeds with the explicit no_active_goal
			// diagnostic page, never a bare {ok:true} with no payload.
			if (operation === "goal.list/get")
				return {
					ok: true,
					result: {
						page: {
							items: [
								{
									enabled: false,
									goal: null,
									reason: "no_active_goal",
									message:
										"No goal is active in this session: goal mode has not created or resumed a goal, so no goal snapshot exists yet.",
								},
							],
							complete: true,
						},
					},
				};
			return { ok: true, result: { ok: true } };
		},
	};
	return {
		repo,
		agentDir,
		sessionId,
		endpoint: productionHost.endpoint,
		brokerEndpoint,
		observed,
		acpRouter,
		acpAttachment,
		stop: async () => {
			await brokerOwnerForTest(agentDir)?.stop();
			await productionHost.stop();
			await broker.stop();
			fs.rmSync(repo, { recursive: true, force: true });
		},
	};
}

export function expectObservation(
	host: AdapterFixture,
	before: number,
	operation: Operation,
	expected: Expected,
): void {
	const observed = host.observed.slice(before);
	if (expected !== "forwarded") expect(observed).toEqual([]);
	else if (operation.kind === "global")
		expect(observed).toContainEqual({ kind: "global", operation: operation.sdkId });
}
export async function stopFixture(host: AdapterFixture, operation: Operation): Promise<void> {
	await host.stop();
	if (operation.sdkId !== "session.new") return;
	await Bun.sleep(500);
	const runtimeAgentDir = path.join(host.repo, ".gjc", "agent");
	const restartedAfterShutdown = fs.existsSync(runtimeAgentDir);
	await brokerOwnerForTest(runtimeAgentDir)?.stop();
	fs.rmSync(host.repo, { recursive: true, force: true });
	expect(restartedAfterShutdown).toBe(false);
}

export async function assertAcpRow(operation: Operation, secret: boolean): Promise<void> {
	const host = await fixture();
	const expected = expectedOutcome("acp", operation, secret);
	const before = host.observed.length;
	const input = inputFor(operation, secret);
	const adapter =
		operation.kind === "global"
			? await AcpSdkAdapter.connect({
					client: await SdkClient.connect(host.brokerEndpoint.url, host.brokerEndpoint.token),
				})
			: await AcpSdkAdapter.connect({
					router: host.acpRouter as never,
					attachment: host.acpAttachment,
					sessionId: host.sessionId,
				});
	try {
		if (operation.kind === "control") {
			if (expected === "forwarded") {
				const code = expectedDomainErrors[operation.sdkId];
				if (code) await expectSdkRejection(adapter.control(operation.sdkId, { ...input, confirm: true }), code);
				else expectSemanticResult(operation, await adapter.control(operation.sdkId, { ...input, confirm: true }));
			} else
				await expectSdkRejection(adapter.control(operation.sdkId, input), expectedAcpRejection(operation, secret));
		} else if (operation.kind === "global") {
			if (expected === "forwarded") {
				const code = expectedGlobalErrors[operation.sdkId];
				if (code) await expectSdkRejection(adapter.global(operation.sdkId, input, `parity-${operation.id}`), code);
				else
					expectSemanticResult(operation, await adapter.global(operation.sdkId, input, `parity-${operation.id}`));
			} else {
				const rejectionKey =
					operation.sdkId === "session.reconcile_uncertain" ? `parity-${operation.id}` : undefined;
				await expectSdkRejection(
					adapter.global(operation.sdkId, input, rejectionKey),
					expectedAcpRejection(operation, secret),
				);
			}
		} else if (operation.kind === "query") {
			if (expected !== "forwarded")
				throw new Error(`Query ${operation.sdkId} has no permitted machine-adapter semantic fixture.`);
			const code = expectedDomainErrors[operation.sdkId];
			if (code) await expectSdkRejection(adapter.query(operation.sdkId, input), code);
			else expectSemanticResult(operation, await adapter.query(operation.sdkId, input));
		} else expect(expected).toBe("internal_only");
		expectObservation(host, before, operation, expected);
	} finally {
		await adapter.close();
		await stopFixture(host, operation);
	}
}

export async function assertMcpRow(operation: Operation, secret: boolean): Promise<void> {
	const host = await fixture();
	let mcp: SdkMcpServer | undefined;
	try {
		const expected = expectedOutcome("mcp", operation, secret);
		const before = host.observed.length;
		const input = inputFor(operation, secret);
		mcp = createSdkMcpServer({ agentDir: host.agentDir });
		const tool =
			operation.kind === "global"
				? "gjc_session_global"
				: operation.kind === "query"
					? "gjc_session_query"
					: "gjc_session_control";
		const args =
			operation.kind === "global"
				? { operation: operation.sdkId, input, idempotencyKey: `parity-${operation.id}` }
				: operation.kind === "query"
					? { sessionId: host.sessionId, query: operation.sdkId, input }
					: { sessionId: host.sessionId, operation: operation.sdkId, input, confirm: true };
		const result = await mcp.callTool(tool, args);
		if (expected === "forwarded") {
			if (operation.kind === "global") expectGlobalSemanticResult(operation, result);
			else expectSemanticResult(operation, result);
		} else expect(result).toMatchObject({ ok: false, error: expect.any(Object) });
		expectObservation(host, before, operation, expected);
	} finally {
		await mcp?.close();
		await stopFixture(host, operation);
	}
}

export async function runDaemonCli(
	args: Parameters<typeof runSdkSessionCli>[0],
): Promise<{ output: unknown; exitCode: number | undefined }> {
	let output: unknown;
	let exitCode: number | undefined;
	await runSdkSessionCli(
		args,
		value => {
			output = value;
		},
		code => {
			exitCode = code;
		},
	);
	return { output, exitCode };
}

export async function assertDaemonCliRow(operation: Operation, secret: boolean): Promise<void> {
	const host = await fixture();
	try {
		const expected = expectedOutcome("daemonCli", operation, secret);
		const before = host.observed.length;
		const lifecycleInput = operation.kind === "global" ? daemonCliLifecycleInput(host, operation.sdkId) : undefined;
		const input =
			lifecycleInput ??
			(operation.sdkId === "session.get_endpoint" ? { sessionId: host.sessionId } : inputFor(operation, secret));
		const action = operation.kind === "global" ? "global" : operation.kind === "query" ? "query" : "control";
		const args = {
			action,
			agentDir: host.agentDir,
			idempotencyKey: operation.kind === "global" ? `parity-${operation.id}` : undefined,
			...(action === "query"
				? { sessionId: host.sessionId, query: operation.sdkId }
				: { operation: operation.sdkId }),
			...(action === "control" ? { sessionId: host.sessionId, confirm: true } : {}),
			jsonInput: JSON.stringify(input),
		};
		const result = await runDaemonCli(args);
		if (expected === "forwarded") {
			if (action === "global") expectGlobalSemanticResult(operation, result.output);
			else expectSemanticResult(operation, result.output);
		} else expect(result.output).toMatchObject({ ok: false, error: expect.any(Object) });
		expectObservation(host, before, operation, expected);
	} finally {
		await stopFixture(host, operation);
	}
}

export { OPERATIONS };
