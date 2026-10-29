/** Genuine DesktopHost -> parseRequest -> public SDK factory/operator transport.
 * SDK promise settlement is not a native resource-ledger or remote completion certificate.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { setModelPresetRegistryDisabled } from "@gajae-code/coding-agent/config/model-preset-registry";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { IsolatedShell } from "@gajae-code/coding-agent/exec/isolated-shell";
import {
	createAgentSession,
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
} from "@gajae-code/coding-agent/sdk";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { convertToLlm } from "@gajae-code/coding-agent/session/messages";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import { DesktopHost } from "../src/host";
import type { DesktopOperatorFoldResult, DesktopOperatorOperation } from "../src/operator-protocol";
import {
	type DesktopFrame,
	type DesktopProject,
	type DesktopRequest,
	type DesktopSession,
	parseRequest,
} from "../src/protocol";

const provider = "desktop-operator-transport-fixture";
const secret = "transport-operator-owned-private-key";
const originalRefresh = ModelRegistry.prototype.refresh;
const cleanups: Array<() => Promise<void>> = [];
let environment: NodeJS.ProcessEnv;
let previousAgentDir: string;

beforeEach(() => {
	environment = { ...process.env };
	previousAgentDir = getAgentDir();
	process.env.GJC_DESKTOP_ISOLATED = "1";
	delete process.env.GJC_CODING_AGENT_DIR;
	delete process.env.GJC_DESKTOP_OPERATOR_UNUSED_API_KEY;
	// Keep the actual registry/parser/auth path, but all catalog refreshes are offline.
	vi.spyOn(ModelRegistry.prototype, "refresh").mockImplementation(function (this: ModelRegistry, _strategy, credentialSessionId) {
		return originalRefresh.call(this, "offline", credentialSessionId);
	});
	// Fail closed on accidental network usage; no mocked provider response or turn.
	vi.spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => {
		throw new Error("Network is forbidden in desktop operator transport tests");
	}, { preconnect: () => { throw new Error("Network preconnect is forbidden in desktop operator transport tests"); } }));
});

afterEach(async () => {
	try {
		while (cleanups.length) await cleanups.pop()?.();
	} finally {
		vi.restoreAllMocks();
		for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
		Object.assign(process.env, environment);
		setAgentDir(previousAgentDir);
	}
});

type Response = Extract<DesktopFrame, { type: "response" }>;
type OperatorFrame = Extract<DesktopFrame, { type: "operator" }>;

async function waitFor(predicate: () => boolean, timeoutMs = 10_000, diagnostic?: () => string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error(`Desktop operator transport condition did not settle before its deadline${diagnostic ? `: ${diagnostic()}` : ""}`);
}

function terminal(operation: DesktopOperatorOperation): boolean {
	return operation.status !== "running" && operation.status !== "cancel_requested";
}

async function fixture() {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-operator-transport-"));
	const dataDir = path.join(directory, "desktop");
	const scopedAgentDir = path.join(dataDir, "agent");
	const projectPath = path.join(directory, "project");
	await fs.mkdir(projectPath);
	await setModelPresetRegistryDisabled({ agentDir: scopedAgentDir, disabled: true });
	await Bun.write(path.join(scopedAgentDir, "config.yml"), [
		"shellPath: /bin/sh", "startup:", "  networkPrewarm: false",
		"compaction:", "  enabled: false", "retry:", "  enabled: false", "todo:", "  enabled: false", "",
	].join("\n"));
	await Bun.write(path.join(scopedAgentDir, "models.yml"), JSON.stringify({
		providers: {
			[provider]: {
				api: "openai-completions", baseUrl: "https://example.invalid/never-contact-operator-provider",
				apiKeyEnv: "GJC_DESKTOP_OPERATOR_UNUSED_API_KEY",
				models: ["base", "next"].map(id => ({
					id, name: `Operator transport ${id}`, reasoning: false, input: ["text"],
					contextWindow: 200_000, maxTokens: 1024,
				})),
			},
		},
	}));
	const auth = await AuthStorage.create(path.join(scopedAgentDir, "agent.db"));
	try { await auth.set(provider, { type: "api_key", key: secret }); }
	finally { auth.close(); }

	const captures: CreateAgentSessionResult[] = [];
	const createSession = async (options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> => {
		if (!options.sessionManager || !options.settings || !options.modelRegistry)
			throw new Error("The desktop host must pass its genuine scoped SDK services");
		const model = options.modelRegistry.find(provider, "base");
		if (!model) throw new Error("The real registry did not load the owned fixture model");
		options.settings.override("startup.networkPrewarm", false);
		options.settings.override("compaction.enabled", false);
		options.settings.override("retry.enabled", false);
		options.settings.override("bash.autoBackground.enabled", false);
		const result = await createAgentSession({
			...options, model, agentId: crypto.randomUUID(),
			extensions: [], additionalExtensionPaths: [], hookPaths: [], disableExtensionDiscovery: true,
			toolNames: [], skills: [], rules: [], contextFiles: [], promptTemplates: [], slashCommands: [],
			workspaceTree: { rootPath: projectPath, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			enableMCP: false, enableMcpAutoload: false, enableLsp: false, skipPythonPreflight: true,
			deferOptionalModelRefresh: true,
		});
		// Preserve actual SDK objects and factory UI setup. Only forbid provider entry.
		vi.spyOn(result.session.agent, "streamFn").mockImplementation(() => {
			throw new Error("No provider turns are allowed in operator transport tests");
		});
		captures.push(result);
		return result;
	};
	const frames: DesktopFrame[] = [];
	const host = new DesktopHost({ dataDir, createSession, emit: frame => { frames.push(frame); } });
	cleanups.push(async () => {
		try {
			for (const capture of captures) { capture.session.abortBash(); capture.session.abortEval(); }
			await host.close();
		} finally { await fs.rm(directory, { recursive: true, force: true }); }
	});
	const response = async (method: DesktopRequest["method"], params: Record<string, unknown> = {}): Promise<Response> => {
		const id = crypto.randomUUID();
		await host.handle(parseRequest(JSON.stringify({ id, method, params })));
		const result = frames.find((frame): frame is Response => frame.type === "response" && frame.id === id);
		if (!result) throw new Error(`No JSON protocol response for ${method}`);
		return result;
	};
	const call = async <T>(method: DesktopRequest["method"], params: Record<string, unknown> = {}): Promise<T> => {
		const result = await response(method, params);
		if (!result.ok) throw new Error(`${method}: ${result.error}`);
		return result.result as T;
	};
	const project = await call<DesktopProject>("project.open", { path: projectPath });
	const open = async () => {
		const dto = await call<DesktopSession>("session.create", { projectId: project.id });
		const result = captures.at(-1);
		if (!result) throw new Error("The desktop host did not invoke the public SDK factory");
		return { dto, sdk: result.session };
	};
	const first = await open();
	const operationFrames = (sessionId: string, operationId: string): OperatorFrame[] => frames.filter(
		(frame): frame is OperatorFrame => frame.type === "operator" && frame.sessionId === sessionId &&
			frame.event.operation.operationId === operationId,
	);
	const settled = async (sessionId: string, operation: DesktopOperatorOperation): Promise<DesktopOperatorOperation> => {
		await waitFor(() => operationFrames(sessionId, operation.operationId).some(frame => terminal(frame.event.operation)));
		return call<DesktopOperatorOperation>("operator.get", { sessionId, operationId: operation.operationId });
	};
	return { directory, host, frames, captures, response, call, first, open, operationFrames, settled };
}

function persistedBashMessages(text: string): Array<Record<string, unknown>> {
	const messages: Array<Record<string, unknown>> = [];
	for (const line of text.trim().split("\n")) {
		const value: unknown = JSON.parse(line);
		if (!value || typeof value !== "object" || !("type" in value) || value.type !== "message" || !("message" in value)) continue;
		const message = value.message;
		if (message && typeof message === "object" && "role" in message && message.role === "bashExecution")
			messages.push(message as Record<string, unknown>);
	}
	return messages;
}

describe("desktop operator public SDK transport", () => {
	test("actual shell output, operator frames, DTOs and disk records retain !! context semantics without leaking host credentials", async () => {
		const f = await fixture();
		expect(f.first.sdk).toBeInstanceOf(AgentSession);
		expect(f.first.sdk.agent).toBeInstanceOf(Agent);
		const sessionId = f.first.dto.id;
		const execute = vi.spyOn(f.first.sdk, "executeBash");
		const included = await f.call<DesktopOperatorOperation>("operator.execute", {
			sessionId, text: "! printf 'transport-included-output\\n'",
		});
		expect(included).toMatchObject({ kind: "bash", excludeFromContext: false, status: "running" });
		expect(await f.settled(sessionId, included)).toMatchObject({ status: "completed", exitCode: 0, output: "transport-included-output\n" });
		const excluded = await f.call<DesktopOperatorOperation>("operator.execute", {
			sessionId, text: "!! printf 'transport-excluded-output\\n'",
		});
		expect(await f.settled(sessionId, excluded)).toMatchObject({ status: "completed", exitCode: 0, excludeFromContext: true });
		expect(execute.mock.calls.map(args => args[2])).toEqual([{ excludeFromContext: false }, { excludeFromContext: true }]);
		const context = JSON.stringify(convertToLlm(f.first.sdk.agent.state.messages));
		expect(context).toContain("transport-included-output");
		expect(context).not.toContain("transport-excluded-output");
		await f.first.sdk.sessionManager.flush();
		const file = f.first.sdk.sessionManager.getSessionFile();
		if (!file || !path.resolve(file).startsWith(`${path.resolve(f.directory)}${path.sep}`))
			throw new Error("Expected an actual transcript owned by this fixture");
		const disk = persistedBashMessages(await Bun.file(file).text());
		expect(disk).toEqual(expect.arrayContaining([
			expect.objectContaining({ output: "transport-included-output\n", excludeFromContext: false, exitCode: 0 }),
			expect.objectContaining({ output: "transport-excluded-output\n", excludeFromContext: true, exitCode: 0 }),
		]));
		const dto = await f.call<DesktopSession>("session.select", { sessionId });
		expect(dto).toMatchObject({ id: sessionId, operatorRunning: false, controlGeneration: f.first.sdk.sessionLifecycle.generation });
		expect(JSON.stringify(dto.messages)).toContain("transport-included-output");
		expect(JSON.stringify(dto.messages)).toContain("transport-excluded-output");
		for (const operation of [included, excluded]) {
			const events = f.operationFrames(sessionId, operation.operationId);
			expect(events[0]?.event.type).toBe("operator.updated");
			expect(events[0]?.event.operation.status).toBe("running");
			expect(events.at(-1)?.event.operation.status).toBe("completed");
			expect(events.every(frame => frame.event.operation.sessionGeneration === dto.controlGeneration)).toBe(true);
		}

		const privateOperation = await f.call<DesktopOperatorOperation>("operator.execute", {
			sessionId,
			text: "!! printf 'safe-prefix-padding-for-secret-overlap\\ntransport-operator-owned-'; sleep 0.1; printf 'private-key\\nsafe-trailer-padding-for-secret-overlap\\n'",
		});
		const privateResult = await f.settled(sessionId, privateOperation);
		expect(privateResult.output).toContain("[redacted]");
		expect(privateResult.output).toContain("safe-trailer");
		expect(JSON.stringify(f.frames)).not.toContain(secret);
		const finalDTO = await f.call<DesktopSession>("session.select", { sessionId });
		expect(JSON.stringify(finalDTO)).not.toContain(secret);
		expect(f.first.sdk.agent.streamFn).not.toHaveBeenCalled();
		expect(globalThis.fetch).not.toHaveBeenCalled();
	}, 30_000);

	test("held real shell execution rejects prompts and transitions before SDK invocation while get, foreign-ID checks, other sessions and canonical abort stay responsive", async () => {
		const f = await fixture();
		const other = await f.open();
		const sessionId = f.first.dto.id;
		const prompt = vi.spyOn(f.first.sdk, "prompt");
		const queue = vi.spyOn(f.first.sdk, "submitUserMessage");
		const model = vi.spyOn(f.first.sdk, "setDefaultModelSelection");
		const clear = vi.spyOn(f.first.sdk, "clearContext");
		const fork = vi.spyOn(SessionManager, "forkFrom");
		const abort = vi.spyOn(f.first.sdk, "abortBash");
		const marker = "transport-command-is-held";
		// Observe the real native-worker and SDK callbacks without replacing data,
		// transport, redaction, execution, or timing. Diagnostics contain no output.
		const chunks = {
			nativeCount: 0, nativeChars: 0, nativeMarker: false,
			sdkCount: 0, sdkChars: 0, sdkMarker: false,
		};
		let nativeWindow = "";
		let sdkWindow = "";
		const nativeRun = IsolatedShell.prototype.run;
		vi.spyOn(IsolatedShell.prototype, "run").mockImplementation(function (this: IsolatedShell, options, onChunk) {
			return nativeRun.call(this, options, (error, chunk) => {
				if (!error) {
					chunks.nativeCount++;
					chunks.nativeChars += chunk.length;
					const combined = nativeWindow + chunk;
					chunks.nativeMarker ||= combined.includes(marker);
					nativeWindow = combined.slice(-(marker.length - 1));
				}
				onChunk?.(error, chunk);
			});
		});
		const executeActual = f.first.sdk.executeBash.bind(f.first.sdk);
		let sdkPromisePending = false;
		const execute = vi.spyOn(f.first.sdk, "executeBash").mockImplementation(async (command, onChunk, options) => {
			sdkPromisePending = true;
			try {
				return await executeActual(command, chunk => {
					chunks.sdkCount++;
					chunks.sdkChars += chunk.length;
					const combined = sdkWindow + chunk;
					chunks.sdkMarker ||= combined.includes(marker);
					sdkWindow = combined.slice(-(marker.length - 1));
					onChunk?.(chunk);
				}, options);
			} finally { sdkPromisePending = false; }
		});
		const running = await f.call<DesktopOperatorOperation>("operator.execute", {
			sessionId, text: "! printf 'transport-command-is-held-with-live-output-and-padding-after-marker-for-stream-redaction\\n'; sleep 30; printf 'must-not-complete\\n'",
		});
		try {
			await waitFor(() => f.operationFrames(sessionId, running.operationId).some(frame =>
				frame.event.operation.output.includes(marker)), 10_000, () => JSON.stringify({
				...chunks, sdkPromisePending,
				lifecycle: f.first.sdk.sessionLifecycle,
				operatorFrames: f.operationFrames(sessionId, running.operationId).map(frame => ({
					status: frame.event.operation.status,
					liveOutput: frame.event.operation.liveOutput,
					chars: frame.event.operation.output.length,
				})),
			}));
			expect(sdkPromisePending).toBe(true);
			expect((await f.call<DesktopSession>("session.select", { sessionId })).operatorRunning).toBe(true);
			expect(await f.call<DesktopOperatorOperation>("operator.get", { sessionId, operationId: running.operationId })).toMatchObject({ status: "running" });
			for (const request of [
				{ method: "prompt", params: { sessionId, text: "must-not-start-provider-turn" } },
				{ method: "prompt", params: { sessionId, text: "must-not-queue", deliverAs: "followUp" } },
				{ method: "model.set", params: { sessionId, modelId: `${provider}/next` } },
				{ method: "session.fork", params: { sessionId } },
				{ method: "command.run", params: { sessionId, text: "/clear" } },
				{ method: "operator.execute", params: { sessionId, text: "! printf 'concurrent-not-admitted\\n'" } },
			] satisfies Array<{ method: DesktopRequest["method"]; params: Record<string, unknown> }>) {
				const response = await f.response(request.method, request.params);
				expect(response.ok).toBe(false);
			}
			expect(prompt).not.toHaveBeenCalled();
			expect(queue).not.toHaveBeenCalled();
			expect(model).not.toHaveBeenCalled();
			expect(clear).not.toHaveBeenCalled();
			expect(fork).not.toHaveBeenCalled();
			expect(execute).toHaveBeenCalledTimes(1);
			expect(f.captures).toHaveLength(2);
			expect(sdkPromisePending).toBe(true);
			const afterRejections = await f.call<DesktopSession>("session.select", { sessionId });
			expect(afterRejections.operatorRunning).toBe(true);
			expect(afterRejections.queued ?? []).toHaveLength(0);
			expect(await f.call<DesktopOperatorFoldResult>("operator.fold", { sessionId })).toEqual({ target: "current_foreground_tool", status: "unsupported" });
			expect(sdkPromisePending).toBe(true);
			for (const method of ["operator.get", "operator.abort"] as const) {
				const foreign = await f.response(method, { sessionId: other.dto.id, operationId: running.operationId });
				expect(foreign.ok).toBe(false);
			}
			const independent = await f.call<DesktopOperatorOperation>("operator.execute", {
				sessionId: other.dto.id, text: "! printf 'independent-sdk-session-output\\n'",
			});
			expect((await f.settled(other.dto.id, independent)).output).toContain("independent-sdk-session-output");
			expect(sdkPromisePending).toBe(true);
			expect(f.first.sdk.isBashRunning).toBe(true);
			const cancel = await f.call<DesktopOperatorOperation>("operator.abort", { sessionId, operationId: running.operationId });
			expect(cancel.status).toBe("cancel_requested");
			expect(abort).toHaveBeenCalledTimes(1);
			const cancelled = await f.settled(sessionId, running);
			expect(cancelled.status).toBe("cancelled");
			expect(cancelled.output).not.toContain("must-not-complete");
			expect(sdkPromisePending).toBe(false);
			expect((await f.call<DesktopSession>("session.select", { sessionId })).operatorRunning).toBe(false);
			const retry = await f.call<DesktopOperatorOperation>("operator.execute", { sessionId, text: "! printf 'post-abort-real-execution\\n'" });
			expect(await f.settled(sessionId, retry)).toMatchObject({ status: "completed", exitCode: 0, output: "post-abort-real-execution\n" });
			expect(execute).toHaveBeenCalledTimes(2);
			expect(f.first.sdk.agent.streamFn).not.toHaveBeenCalled();
			expect(other.sdk.agent.streamFn).not.toHaveBeenCalled();
			expect(globalThis.fetch).not.toHaveBeenCalled();
		} finally { if (sdkPromisePending) f.first.sdk.abortBash(); }
	}, 30_000);

	test("global abort reaches the admitted SDK Bash executor and rejects arbitrary operator parameters", async () => {
		const f = await fixture();
		const sessionId = f.first.dto.id;
		const execute = vi.spyOn(f.first.sdk, "executeBash");
		for (const params of [
			{ sessionId, text: "! true", cwd: "/" },
			{ sessionId, text: "! true", excludeFromContext: true },
			{ sessionId, text: "! true", timeout: 1 },
		]) expect((await f.response("operator.execute", params)).ok).toBe(false);
		expect(execute).not.toHaveBeenCalled();
		const running = await f.call<DesktopOperatorOperation>("operator.execute", {
			sessionId, text: "! printf 'global-abort-live-output-padding\\n'; sleep 30",
		});
		try {
			await waitFor(() => f.first.sdk.isBashRunning);
			const abort = vi.spyOn(f.first.sdk, "abortBash");
			expect(await f.call("abort", { sessionId })).toBeNull();
			expect(abort).toHaveBeenCalledTimes(1);
			expect((await f.settled(sessionId, running)).status).toBe("cancelled");
			expect((await f.call<DesktopSession>("session.select", { sessionId })).operatorRunning).toBe(false);
			expect(f.first.sdk.agent.streamFn).not.toHaveBeenCalled();
			expect(globalThis.fetch).not.toHaveBeenCalled();
		} finally { f.first.sdk.abortBash(); }
	}, 30_000);
});
