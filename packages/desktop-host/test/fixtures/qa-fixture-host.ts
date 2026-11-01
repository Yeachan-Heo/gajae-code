// TEST ONLY. Separate process entrypoint; never imported or selected by product code.
// Parent driver supplies a freshly-owned, fully isolated environment before SDK imports.

import { appendFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setModelPresetRegistryDisabled } from "@gajae-code/coding-agent/config/model-preset-registry";
import { shutdownAll } from "@gajae-code/coding-agent/lsp/client";
import { type CreateAgentSessionResult, createAgentSession } from "@gajae-code/coding-agent/sdk";
import { approvalGate, executionGate, questionToGate } from "@gajae-code/coding-agent/sdk/workflow-gates";
import {
	type FixtureGateContinuation,
	type FixtureGateSnapshot,
	fixtureFetch,
	QA_PROVIDER,
	validateFixtureEnvironment,
} from "../../../desktop/scripts/qa-model-fixture";
import { createFrameWriter } from "../../src/frame-writer";
import { DesktopHost } from "../../src/host";
import { registerDesktopProcessShutdown } from "../../src/process-lifecycle";
import type { DesktopFrame } from "../../src/protocol";
import { serveProtocol } from "../../src/transport";

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export async function main(): Promise<void> {
	const { layout, baseUrl, providerToken } = await validateFixtureEnvironment(process.env);
	const mcpCalls: string[] = [];
	const mcpSessions = new Set<string>();
	const recordMcp = (event: string, sessionId: string) =>
		appendFileSync(path.join(layout.root, "mcp-lifecycle.jsonl"), `${JSON.stringify({ event, sessionId })}\n`);
	const mcp = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		maxRequestBodySize: 1024 * 1024,
		idleTimeout: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (
				url.origin !== `http://127.0.0.1:${mcp.port}` ||
				url.pathname !== "/mcp" ||
				url.search ||
				request.headers.get("host") !== `127.0.0.1:${mcp.port}` ||
				request.headers.has("Origin") ||
				request.headers.get("Authorization") !== `Bearer ${providerToken}`
			)
				return new Response("Forbidden", { status: 403 });
			const sessionId = request.headers.get("Mcp-Session-Id");
			if (request.method === "GET") {
				if (!sessionId || !mcpSessions.has(sessionId)) return new Response("Unknown session", { status: 404 });
				recordMcp("open", sessionId);
				let closed = false;
				const close = () => {
					if (!closed) {
						closed = true;
						recordMcp("close", sessionId);
					}
				};
				request.signal.addEventListener("abort", close, { once: true });
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode(": connected\n\n"));
						},
						cancel: close,
					}),
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			}
			if (request.method === "DELETE") {
				if (!sessionId || !mcpSessions.delete(sessionId)) return new Response("Unknown session", { status: 404 });
				recordMcp("terminate", sessionId);
				return new Response(null, { status: 204 });
			}
			if (request.method !== "POST") return new Response("Forbidden", { status: 403 });
			const message = (await request.json()) as {
				id?: string | number;
				method?: string;
				params?: { protocolVersion?: string };
			};
			if (typeof message.method !== "string") return new Response("Invalid", { status: 400 });
			const currentSession = message.method === "initialize" ? crypto.randomUUID() : sessionId;
			if (!currentSession || (message.method !== "initialize" && !mcpSessions.has(currentSession)))
				return new Response("Unknown session", { status: 404 });
			if (message.method === "initialize") mcpSessions.add(currentSession);
			mcpCalls.push(message.method);
			let result: Record<string, unknown> = {};
			if (message.method === "initialize")
				result = {
					protocolVersion: message.params?.protocolVersion,
					capabilities: { tools: {} },
					serverInfo: { name: "owned-fixture", version: "1" },
				};
			else if (message.method === "tools/list")
				result = {
					tools: [
						{
							name: "probe",
							description: "Owned fixture probe",
							inputSchema: { type: "object", properties: {} },
						},
					],
				};
			else if (message.method === "tools/call") {
				recordMcp("call", currentSession);
				result = { content: [{ type: "text", text: "owned MCP effect" }] };
			} else if (message.method !== "notifications/initialized")
				return new Response("Unknown method", { status: 400 });
			return Response.json(
				{ jsonrpc: "2.0", id: message.id, result },
				{ headers: { "Mcp-Session-Id": currentSession } },
			);
		},
	});
	const mcpUrl = `http://127.0.0.1:${mcp.port}/mcp`;
	await Bun.write(
		path.join(layout.agentDir, "mcp.json"),
		JSON.stringify({
			mcpServers: {
				fixture: {
					type: "http",
					url: mcpUrl,
					protocol: "legacy",
					headers: { Authorization: `Bearer ${providerToken}` },
					enabled: true,
					autoload: true,
				},
			},
		}),
	);
	// Install before host initialization, registry refresh, or session construction.
	globalThis.fetch = fixtureFetch(baseUrl, providerToken, globalThis.fetch, mcpUrl);
	await setModelPresetRegistryDisabled({ agentDir: layout.agentDir, disabled: true });
	process.stdout.write = process.stderr.write.bind(process.stderr);
	const frames = createFrameWriter({
		write: async bytes => {
			await Bun.write(Bun.stdout, bytes);
		},
		onError: () => {
			process.exitCode = 1;
			process.stdin.destroy();
		},
	});
	const emit = (frame: DesktopFrame) => frames.write(frame);
	const captured: CreateAgentSessionResult[] = [];
	const startupRunners = new WeakMap<
		CreateAgentSessionResult,
		CreateAgentSessionResult["session"]["extensionRunner"]
	>();
	const continuations: FixtureGateContinuation[] = [];
	let writes = Promise.resolve();
	let writeFailed = false;
	const gateSnapshot = (sessionId?: string): FixtureGateSnapshot => ({
		version: 1,
		testOnly: true,
		continuations: structuredClone(
			continuations.filter(entry => sessionId === undefined || entry.sessionId === sessionId),
		),
	});
	const persist = () => {
		const json = JSON.stringify(gateSnapshot(), null, 2);
		writes = writes
			.then(async () => {
				await Bun.write(layout.gateArtifactPath, json);
			})
			.catch(() => {
				writeFailed = true;
			});
	};
	const host = new DesktopHost({
		dataDir: layout.dataDir,
		emit,
		createSession: async options => {
			if (
				!options.authStorage ||
				!options.modelRegistry ||
				!options.sessionManager ||
				!options.settings ||
				options.agentDir !== layout.agentDir ||
				options.cwd !== layout.project
			)
				throw new Error("Fixture requires the real host-owned session dependencies");
			// Preserve this conversation's host-owned registry/auth/settings unchanged:
			// models.list, model.set and SDK requests must share this exact catalog.
			// No replacement registry, fake session methods or stream overrides.
			const services = await Bun.file(path.join(layout.root, "enable-services")).exists();
			const result = await createAgentSession({
				...options,
				enableMcpAutoload: services,
				enableLsp: services,
				skipPythonPreflight: true,
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
			});
			// Fault injection targets the real runner's initialization boundary, not
			// prompt or transport behavior. It is armed only by the owned test root.
			if (await Bun.file(path.join(layout.root, "extension-init-failure")).exists()) {
				if (!result.session.extensionRunner) throw new Error("Fixture extension runner unavailable");
				result.session.extensionRunner.initialize = () => {
					throw new Error("TEST ONLY extension initialization failure");
				};
			}
			startupRunners.set(result, result.session.extensionRunner);
			captured.push(result);
			return result;
		},
	});
	const ownedSession = async (sessionId: string): Promise<CreateAgentSessionResult> => {
		const snapshot = host.snapshot();
		const metadata = snapshot.sessions.find(session => session.id === sessionId);
		if (
			!metadata ||
			!snapshot.projects.some(project => project.id === metadata.projectId && project.path === layout.project)
		)
			throw new Error("Unknown fixture session");
		const catalog = record(await Bun.file(path.join(layout.dataDir, "catalog.json")).json());
		const saved = Array.isArray(catalog?.sessions)
			? catalog.sessions.map(record).find(entry => entry?.id === sessionId)
			: undefined;
		if (typeof saved?.file !== "string") throw new Error("Fixture transcript is not committed");
		const transcript = path.resolve(layout.dataDir, "sessions", saved.file);
		if (!transcript.startsWith(`${layout.dataDir}/sessions/`) || (await fs.realpath(transcript)) !== transcript)
			throw new Error("Non-owned fixture transcript");
		const result = captured.findLast(entry => entry.session.sessionManager.getSessionFile() === transcript);
		if (!result || result.session.model?.provider !== QA_PROVIDER || result.session.model.baseUrl !== baseUrl)
			throw new Error("Non-owned fixture session or provider");
		return result;
	};
	// Private loopback control transport. It can only emit fixed gates and read
	// promise outcomes; it cannot answer, present, ACK, grant or terminalize gates.
	const controls = Bun.serve<undefined>({
		hostname: "127.0.0.1",
		port: 0,
		maxRequestBodySize: 1024,
		idleTimeout: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (
				url.origin !== `http://127.0.0.1:${controls.port}` ||
				request.headers.get("host") !== `127.0.0.1:${controls.port}` ||
				request.headers.has("Origin") ||
				request.headers.get("X-Desktop-QA-Fixture") !== providerToken ||
				url.search ||
				request.method !== "POST" ||
				request.headers.get("Content-Type") !== "application/json" ||
				!["/gate", "/gates", "/services", "/runner"].includes(url.pathname)
			)
				return new Response("Forbidden fixture gate control", { status: 403 });
			try {
				const body = record(await request.json());
				if (
					!body ||
					typeof body.sessionId !== "string" ||
					!/^[a-f0-9-]{36}$/.test(body.sessionId) ||
					Object.keys(body).some(key => key !== "sessionId" && !(url.pathname === "/gate" && key === "kind"))
				)
					return new Response("Invalid gate control", { status: 400 });
				const result = await ownedSession(body.sessionId);
				if (url.pathname === "/runner")
					return Response.json({
						sameRunner:
							!!result.session.extensionRunner && result.session.extensionRunner === startupRunners.get(result),
					});
				if (url.pathname === "/services") {
					const mcpTool = result.session.getToolByName("mcp__fixture_probe");
					const lspTool = result.session.getToolByName("lsp");
					if (!mcpTool || !lspTool) return new Response("Owned services unavailable", { status: 409 });
					const mcpResult = await mcpTool.execute("fixture-mcp", {} as never);
					const lspResult = await lspTool.execute("fixture-lsp", {
						action: "diagnostics",
						file: path.join(layout.project, "probe.move"),
					} as never);
					return Response.json(
						{ mcpResult, lspResult, mcpCalls, mcpUrl },
						{ headers: { "Cache-Control": "no-store" } },
					);
				}
				if (url.pathname === "/gate") {
					if (body.kind !== "approval" && body.kind !== "question" && body.kind !== "execution")
						return new Response("Invalid gate kind", { status: 400 });
					if (
						continuations.length >= 32 ||
						continuations.some(entry => entry.sessionId === body.sessionId && entry.state === "pending")
					)
						return new Response("Fixture gate limit or pending continuation", { status: 409 });
					const emitter = result.session.getWorkflowGateEmitter();
					if (!emitter?.supportsRemoteGateAnswers())
						return new Response("Real SDK remote gates unavailable", { status: 409 });
					const entry: FixtureGateContinuation = {
						id: continuations.length + 1,
						sessionId: body.sessionId,
						kind: body.kind,
						state: "pending",
						advanced: false,
					};
					const input =
						body.kind === "approval"
							? approvalGate({ title: "TEST ONLY fixture plan approval" })
							: body.kind === "execution"
								? executionGate({ title: "TEST ONLY fixture execution decision" })
								: questionToGate({
										id: `fixture-question-${entry.id}`,
										question: "TEST ONLY fixture question",
										options: [{ label: "Fixture A" }, { label: "Fixture B" }],
									});
					const continuation = emitter.emitGate(input);
					continuations.push(entry);
					void continuation.then(
						answer => {
							entry.state = "resolved";
							entry.advanced = true;
							entry.answer = answer;
							persist();
						},
						() => {
							entry.state = "rejected";
							entry.error = "Genuine SDK gate continuation rejected";
							persist();
						},
					);
					persist();
				}
				await writes;
				if (writeFailed) return new Response("Fixture gate artifact unavailable", { status: 503 });
				return Response.json(gateSnapshot(body.sessionId), { headers: { "Cache-Control": "no-store" } });
			} catch {
				return new Response("Invalid or non-owned fixture gate request", { status: 400 });
			}
		},
	});
	persist();
	await Bun.write(layout.gateControlPath, JSON.stringify({ baseUrl: `http://127.0.0.1:${controls.port}` }));
	const drained = Promise.withResolvers<void>();
	let stopping = false;
	const unregisterShutdown = registerDesktopProcessShutdown({
		close: async () => {
			stopping = true;
			await host.close();
			if (await Bun.file(path.join(layout.root, "signal-close-failure")).exists())
				throw new Error("TEST ONLY injected signal close failure");
		},
		flush: () => drained.promise,
		onError: () => {
			process.exitCode = 1;
			process.stderr.write("QA fixture host signal shutdown failed\n");
		},
	});
	try {
		await serveProtocol(process.stdin, host, emit);
	} catch {
		if (!stopping) {
			emit({ type: "fatal", error: "QA fixture host transport failed" });
			process.exitCode = 1;
		}
	} finally {
		try {
			await controls.stop(true);
			await shutdownAll();
			await mcp.stop(true);
			await writes;
			await frames.flush();
		} finally {
			drained.resolve();
			unregisterShutdown();
		}
	}
}

if (import.meta.main) await main();
