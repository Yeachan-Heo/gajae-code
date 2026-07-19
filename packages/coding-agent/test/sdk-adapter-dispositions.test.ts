import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { AcpSdkAdapter } from "../src/sdk/acp";
import { Broker } from "../src/sdk/broker";
import { brokerOwnerForTest } from "../src/sdk/broker/ensure";
import { sendAuthorizedChatOperation } from "../src/sdk/bus/chat-command-policy";
import { runSdkSessionCli } from "../src/sdk/cli/session-cli";
import { SdkClient } from "../src/sdk/client";
import { createSdkMcpServer } from "../src/sdk/mcp";
import { type Adapter, OPERATIONS, type Operation } from "../src/sdk/protocol/operation-registry";
import { startProductionSdkHost } from "./helpers/sdk-production-host";

type MachineAdapter = Extract<Adapter, "mcp" | "acp" | "daemonCli">;
type Expected = "forwarded" | "rejected_before_send" | "internal_only";
type ObservedRequest = { kind: "control" | "query" | "global"; operation: string };

type ParityRow = {
	adapterTestId: string;
	adapter: Adapter;
	disposition: Operation["adapterDispositions"][Adapter];
	expected: Expected;
};

const parityRows = (
	JSON.parse(fs.readFileSync(path.join(import.meta.dir, "manifests", "sdk-adapter-parity-v1.json"), "utf8")) as {
		rows: ParityRow[];
	}
).rows;
expect(parityRows).toHaveLength(546);
const parityPrefix: Record<Adapter, string> = {
	telegram: "T",
	discord: "D",
	slack: "S",
	mcp: "M",
	acp: "A",
	daemonCli: "L",
};

function parityRow(adapter: Adapter, operation: Operation, secret = false): ParityRow {
	const adapterTestId = `AD-${parityPrefix[adapter]}-${operation.id}${secret ? "-secret" : ""}`;
	const row = parityRows.find(candidate => candidate.adapterTestId === adapterTestId);
	if (!row) throw new Error(`Missing parity manifest row: ${adapterTestId}`);
	expect(row.adapter).toBe(adapter);
	expect(row.disposition).toBe(operation.adapterDispositions[adapter]);
	return row;
}

type AdapterFixture = {
	repo: string;
	agentDir: string;
	sessionId: string;
	endpoint: { url: string; token: string };
	brokerEndpoint: { url: string; token: string };
	observed: ObservedRequest[];
	stop: () => Promise<void>;
};

const machineAdapters: readonly MachineAdapter[] = ["mcp", "acp", "daemonCli"];
const adapterPrefix: Record<MachineAdapter, string> = { mcp: "M", acp: "A", daemonCli: "L" };

function expectedOutcome(adapter: MachineAdapter, operation: Operation, secret = false): Expected {
	if (secret) return "rejected_before_send";
	if (operation.kind === "reverse") return "internal_only";
	const disposition = operation.adapterDispositions[adapter];
	if (disposition === "prohibited" || disposition === "provider_only") return "rejected_before_send";
	if (adapter === "daemonCli" && disposition === "machine_only") return "forwarded";
	return disposition === "machine_only" ? "internal_only" : "forwarded";
}
const expectedDomainErrors: Readonly<Record<string, string>> = {
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
	"goal.list/get": "resource_gone",
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
	"mode.plan.set": "unavailable",
};
const expectedGlobalErrors: Readonly<Record<string, string>> = {
	"session.create": "invalid_input",
	"session.fork": "invalid_input",
	"session.resume": "invalid_input",
	"session.close": "invalid_input",
	"session.delete": "invalid_input",
};
function expectSemanticResult(operation: Operation, result: unknown): void {
	const code = expectedDomainErrors[operation.sdkId];
	if (code) expect(result).toMatchObject({ ok: false, error: { code } });
	else expect(result).toMatchObject({ ok: true });
}

function expectGlobalSemanticResult(operation: Operation, result: unknown): void {
	const code = expectedGlobalErrors[operation.sdkId];
	if (code) expect(result).toMatchObject({ ok: false, error: { code } });
	else expect(result).toMatchObject({ ok: true });
}

function expectedAcpRejection(operation: Operation, secret: boolean): string {
	if (secret) return "secret_field_forbidden";
	const disposition = operation.adapterDispositions.acp;
	if (disposition === "provider_only") return "provider_required";
	if (disposition === "machine_only") return operation.errorCodes[0] ?? "machine_only";
	return "operation_prohibited";
}

async function expectSdkRejection(promise: Promise<unknown>, code: string): Promise<void> {
	let failure: unknown;
	try {
		await promise;
	} catch (error) {
		failure = error;
	}
	expect(failure).toMatchObject({ code });
}

function inputFor(operation: Operation, secret = false): Record<string, unknown> {
	if (secret) return { patch: { apiToken: "secret" } };
	switch (operation.sdkId) {
		case "turn.prompt":
		case "turn.steer":
		case "turn.follow_up":
		case "turn.abort_and_prompt":
			return { text: "adapter disposition probe" };
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
		case "thinking.set":
			return { level: "low" };
		case "permission_mode.set":
			return { mode: "prompt" };
		case "queue.steering_mode.set":
		case "queue.follow_up_mode.set":
			return { mode: "one-at-a-time" };
		case "queue.interrupt_mode.set":
			return { mode: "wait" };
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

async function fixture(): Promise<AdapterFixture> {
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
	await broker.index.append({
		type: "host_registered",
		sessionId,
		locator: { repo, stateRoot },
		endpointGeneration: 1,
		pid: process.pid,
		endpointMtimeMs,
	});
	return {
		repo,
		agentDir,
		sessionId,
		endpoint: productionHost.endpoint,
		brokerEndpoint,
		observed,
		stop: async () => {
			await brokerOwnerForTest(agentDir)?.stop();
			await productionHost.stop();
			await broker.stop();
			fs.rmSync(repo, { recursive: true, force: true });
		},
	};
}

function expectObservation(host: AdapterFixture, before: number, operation: Operation, expected: Expected): void {
	const observed = host.observed.slice(before);
	if (expected !== "forwarded") expect(observed).toEqual([]);
	else if (operation.kind === "global")
		expect(observed).toContainEqual({ kind: "global", operation: operation.sdkId });
}
async function stopFixture(host: AdapterFixture, operation: Operation): Promise<void> {
	await host.stop();
	if (operation.sdkId !== "session.new") return;
	await Bun.sleep(500);
	const runtimeAgentDir = path.join(host.repo, ".gjc", "agent");
	const restartedAfterShutdown = fs.existsSync(runtimeAgentDir);
	await brokerOwnerForTest(runtimeAgentDir)?.stop();
	fs.rmSync(host.repo, { recursive: true, force: true });
	expect(restartedAfterShutdown).toBe(false);
}

async function assertAcpRow(operation: Operation, secret: boolean): Promise<void> {
	const host = await fixture();
	const expected = expectedOutcome("acp", operation, secret);
	const before = host.observed.length;
	const input = inputFor(operation, secret);
	const endpoint = operation.kind === "global" ? host.brokerEndpoint : host.endpoint;
	const adapter = await AcpSdkAdapter.connect(endpoint);
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
			} else
				await expectSdkRejection(adapter.global(operation.sdkId, input), expectedAcpRejection(operation, secret));
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

async function assertMcpRow(operation: Operation, secret: boolean): Promise<void> {
	const host = await fixture();
	try {
		const expected = expectedOutcome("mcp", operation, secret);
		const before = host.observed.length;
		const input = inputFor(operation, secret);
		const mcp = createSdkMcpServer({
			repo: host.repo,
			agentDir: host.agentDir,
			...(operation.kind === "global"
				? {}
				: { connect: () => SdkClient.connect(host.endpoint.url, host.endpoint.token) }),
		});
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
		await stopFixture(host, operation);
	}
}

async function runDaemonCli(
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

async function assertDaemonCliRow(operation: Operation, secret: boolean): Promise<void> {
	const host = await fixture();
	try {
		const expected = expectedOutcome("daemonCli", operation, secret);
		const before = host.observed.length;
		const input =
			operation.sdkId === "session.get_endpoint" ? { sessionId: host.sessionId } : inputFor(operation, secret);
		const action = operation.kind === "global" ? "global" : operation.kind === "query" ? "query" : "control";
		const args = {
			action,
			repo: host.repo,
			agentDir: host.agentDir,
			idempotencyKey: operation.kind === "global" ? `parity-${operation.id}` : undefined,
			...(action === "query"
				? { sessionId: host.sessionId, query: operation.sdkId }
				: { operation: operation.sdkId }),
			...(action === "control" ? { sessionId: host.sessionId, confirm: true } : {}),
			...(operation.sdkId === "session.get_endpoint" ? { showEndpointCredential: true, yes: true } : {}),
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

for (const adapter of machineAdapters) {
	for (const operation of OPERATIONS) {
		const name = `AD-${adapterPrefix[adapter]}-${operation.id}: ${operation.sdkId} ${expectedOutcome(adapter, operation)}`;
		test(name, async () => {
			if (adapter === "acp") await assertAcpRow(operation, false);
			else if (adapter === "mcp") await assertMcpRow(operation, false);
			else await assertDaemonCliRow(operation, false);
		}, 60_000);
		if (operation.id === "C36") {
			test(`AD-${adapterPrefix[adapter]}-C36-secret: config.patch secret input rejected before send`, async () => {
				if (adapter === "acp") await assertAcpRow(operation, true);
				else if (adapter === "mcp") await assertMcpRow(operation, true);
				else await assertDaemonCliRow(operation, true);
			}, 60_000);
		}
	}
}

const chatAdapters = ["telegram", "discord", "slack"] as const;
const chatPrefix = { telegram: "T", discord: "D", slack: "S" } as const;
for (const adapter of chatAdapters) {
	for (const operation of OPERATIONS.filter(candidate => candidate.kind !== "reverse")) {
		test(`AD-${chatPrefix[adapter]}-${operation.id}: ${operation.sdkId} chat disposition`, async () => {
			let sends = 0;
			const row = parityRow(adapter, operation);
			const result = await sendAuthorizedChatOperation(
				adapter,
				{ kind: operation.kind, operation: operation.sdkId, input: inputFor(operation) },
				async () => {
					sends++;
					return "sent";
				},
			);
			const observed: Expected = result.ok ? "forwarded" : "rejected_before_send";
			expect(observed === row.expected).toBe(true);
			expect(sends).toBe(row.expected === "forwarded" ? 1 : 0);
		});
		if (operation.id === "C36") {
			test(`AD-${chatPrefix[adapter]}-C36-secret: config.patch secret input rejected before send`, async () => {
				const row = parityRow(adapter, operation, true);
				const secretInputs = [
					{ patch: { nested: { apiKey: "secret" } } },
					{ patch: { nested: { "api-key": "secret" } } },
					{ patch: { nested: { credential: "secret" } } },
					{ patch: { nested: { authorization: "secret" } } },
				];
				for (const input of secretInputs) {
					let sends = 0;
					const result = await sendAuthorizedChatOperation(
						adapter,
						{ kind: "control", operation: operation.sdkId, input },
						async () => {
							sends++;
							return "sent";
						},
					);
					expect(result).toMatchObject({ ok: false, error: { code: "secret_input_forbidden" } });
					expect(sends).toBe(0);
				}
				expect(row.expected).toBe("rejected_before_send");
			});
		}
	}
}

for (const adapter of chatAdapters) {
	for (const operation of OPERATIONS.filter(candidate => candidate.kind === "reverse")) {
		test(`AD-${chatPrefix[adapter]}-${operation.id}: ${operation.sdkId} internal_only/rejected-before-send`, async () => {
			let sends = 0;
			const row = parityRow(adapter, operation);
			const result = await sendAuthorizedChatOperation(
				adapter,
				{ kind: operation.kind, operation: operation.sdkId, input: inputFor(operation) },
				async () => {
					sends++;
					return "sent";
				},
			);
			const observed: Expected = result.ok ? "forwarded" : "rejected_before_send";
			expect(observed === row.expected).toBe(true);
			expect(sends).toBe(0);
		});
	}
}
