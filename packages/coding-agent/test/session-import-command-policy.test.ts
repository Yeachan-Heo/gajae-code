import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
import { TempDir } from "@gajae-code/utils";
import { AcpAgent } from "../src/modes/acp/acp-agent";
import { writeBrokerDiscovery } from "../src/sdk/broker/discovery";
import { processIncarnation } from "../src/sdk/broker/process-incarnation";
import { ACP_BUILTIN_SLASH_COMMANDS, executeAcpBuiltinSlashCommand } from "../src/slash-commands/acp-builtins";
import {
	BUILTIN_SLASH_COMMAND_DEFS,
	executeBuiltinSlashCommand,
	executeLocalHeadlessBuiltinSlashCommand,
	lookupBuiltinSlashCommand,
} from "../src/slash-commands/builtin-registry";
import type {
	AcpBuiltinCommandRuntime,
	SlashCommandRuntime,
	TuiSlashCommandRuntime,
} from "../src/slash-commands/types";

/**
 * Writes the SDK session endpoint file and the session-index registration event
 * so the SessionRouter's reconciliation can find and publish the adopted
 * session. The current router requires exact endpoint/session-identity
 * authority, so the fixture must materialise both surfaces.
 */
async function publishBrokerSession(
	agentDir: string,
	cwd: string,
	sessionId: string,
	pid: number,
	endpointGeneration: number,
	endpointMtimeMs: number,
): Promise<void> {
	const stateRoot = path.join(cwd, ".gjc", "state");
	const sessionsDir = path.join(agentDir, "sdk", "sessions");
	await fs.mkdir(sessionsDir, { recursive: true });
	const indexFile = path.join(sessionsDir, "index.jsonl");
	const incarnation = processIncarnation(pid);
	const event = {
		version: 1,
		indexSeq: 1,
		type: "host_registered" as const,
		sessionId,
		locator: { cwd: cwd, worktreeRoot: null, stateRoot },
		endpointGeneration,
		pid,
		...(incarnation !== undefined ? { hostIncarnation: incarnation } : {}),
		endpointMtimeMs,
		ts: Date.now(),
	};
	const checksum = createHash("sha256").update(JSON.stringify(event)).digest("hex");
	await fs.writeFile(indexFile, `${JSON.stringify({ ...event, checksum })}\n`, "utf8");
}

type AcpPromptFixture = {
	agent: AcpAgent;
	sessionId: string;
	updates: SessionNotification[];
	controlOperations: string[];
	promptTexts: string[];
	dispose: () => void;
};

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error("waitFor timed out");
}

async function createAcpPromptFixture(): Promise<AcpPromptFixture> {
	const tempDir = TempDir.createSync("@acp-import-policy-");
	const agentDir = path.join(tempDir.path(), "agent");
	const cwd = path.join(tempDir.path(), "workspace");
	const token = "acp-import-policy-token";
	const sessionId = "acp-import-policy-session";
	const updates: SessionNotification[] = [];
	const promptTexts: string[] = [];
	const controlOperations: string[] = [];
	let turnNumber = 0;
	let server!: ReturnType<typeof Bun.serve>;

	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, server) {
			if (new URL(request.url).searchParams.get("token") !== token)
				return new Response("Unauthorized", { status: 401 });
			if (!server.upgrade(request, { data: undefined })) return new Response("Upgrade failed", { status: 400 });
		},
		websocket: {
			open(socket) {
				socket.send(JSON.stringify({ type: "hello", connectionId: "acp-import-policy" }));
			},
			async message(socket, raw) {
				const frame = JSON.parse(String(raw)) as Record<string, unknown>;
				if (frame.type === "register_provider") {
					socket.send(
						JSON.stringify({ type: "register_provider_result", id: frame.id, ok: true, leaseId: "lease" }),
					);
					return;
				}
				if (frame.type === "broker_request") {
					if (frame.operation === "session.create") {
						const url = `ws://127.0.0.1:${server.port}`;
						const sdkDir = path.join(cwd, ".gjc", "state", "sdk");
						nodeFs.mkdirSync(sdkDir, { recursive: true });
						const endpointFile = path.join(sdkDir, `${sessionId}.json`);
						nodeFs.writeFileSync(
							endpointFile,
							JSON.stringify({ version: 1, sessionId, url, token, pid: process.pid }),
						);
						const endpointMtimeMs = nodeFs.statSync(endpointFile).mtimeMs;
						const result = {
							sessionId,
							endpointGeneration: 1,
							pid: process.pid,
							endpointMtimeMs,
							endpoint: { sessionId, pid: process.pid, url, token },
						};
						await publishBrokerSession(agentDir, cwd, sessionId, process.pid, 1, endpointMtimeMs);
						socket.send(JSON.stringify({ type: "broker_response", id: frame.id, ok: true, result }));
						return;
					}
					socket.send(JSON.stringify({ type: "broker_response", id: frame.id, ok: true, result: {} }));
					return;
				}
				if (frame.type === "query_request") {
					const query = String(frame.query);
					const items =
						query === "config.list/get"
							? [{ mode: "default", model: "openai/gpt", thinking: "medium" }]
							: query === "models.list/current"
								? [{ provider: "openai", id: "gpt", name: "GPT" }]
								: query === "providers.list/active"
									? [{ providerId: "openai", connectionKind: "credential" }]
									: [];
					const result =
						query === "runtime.capabilities"
							? { promptTerminalOutcomeVersion: 1 }
							: query === "context.get"
								? { usage: { tokens: 0, contextWindow: 200_000, percent: 0, source: "test" } }
								: query === "session.metadata"
									? { page: { items: [{ sessionId, name: "ACP import policy", cwd }], complete: true } }
									: { page: { items, complete: true } };
					socket.send(JSON.stringify({ type: "query_response", id: frame.id, ok: true, result }));
					return;
				}
				if (frame.type === "event_replay") {
					socket.send(JSON.stringify({ type: "event_replay_result", id: frame.id, events: [] }));
					return;
				}
				if (frame.type !== "control_request") return;
				const operation = String(frame.operation);
				if (operation === "turn.prompt") {
					const input = frame.input;
					if (input && typeof input === "object" && !Array.isArray(input)) {
						const text = (input as { text?: unknown }).text;
						if (typeof text === "string") promptTexts.push(text);
					}
				}

				controlOperations.push(operation);
				const commandId = `prompt-command-${++turnNumber}`;
				const turnId = `prompt-turn-${turnNumber}`;
				socket.send(
					JSON.stringify({
						type: "control_response",
						id: frame.id,
						ok: true,
						result:
							operation === "turn.prompt"
								? { commandId, turnId, accepted: true }
								: operation === "turn.abort"
									? { aborted: true }
									: {},
					}),
				);
				if (operation === "turn.prompt") {
					setTimeout(() => {
						socket.send(JSON.stringify({ type: "agent_start", sessionId, commandId, turnId }));
						socket.send(
							JSON.stringify({
								type: "agent_end",
								sessionId,
								commandId,
								turnId,
								finalText: "fixture response",
								outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
							}),
						);
					}, 0);
				}
			},
		},
	});
	if (server.port === undefined) throw new Error("Expected ACP import-policy fixture server port");
	await writeBrokerDiscovery(agentDir, {
		version: 1,
		protocolVersion: 3,
		packageGeneration: "test",
		ownerId: "test-owner",
		pid: process.pid,
		host: "127.0.0.1",
		port: server.port,
		url: `ws://127.0.0.1:${server.port}`,
		token,
		startedAt: Date.now(),
		heartbeatAt: Date.now(),
	});
	const abort = new AbortController();
	const agent = new AcpAgent(
		{
			sessionUpdate: async (update: SessionNotification) => updates.push(update),
			signal: abort.signal,
			closed: Promise.withResolvers<void>().promise,
		} as unknown as AgentSideConnection,
		{ agentDir },
	);
	const created = await agent.newSession({ cwd, mcpServers: [] });
	return {
		agent,
		sessionId: created.sessionId,
		updates,
		promptTexts,
		controlOperations,
		dispose: () => {
			abort.abort();
			server.stop(true);
			tempDir.removeSync();
		},
	};
}

describe("session import command transport policy", () => {
	it("is never advertised or dispatched over ACP", async () => {
		expect(ACP_BUILTIN_SLASH_COMMANDS.some(command => command.name === "import-session")).toBe(false);
		const output: string[] = [];
		const runtime = {
			output: (text: string) => output.push(text),
		} as unknown as AcpBuiltinCommandRuntime;
		const availableLocally = lookupBuiltinSlashCommand("import-session") !== undefined;
		expect(await executeAcpBuiltinSlashCommand("/import-session codex", runtime)).toEqual(
			availableLocally ? { consumed: true } : false,
		);
		expect(output).toEqual(availableLocally ? ["Slash command /import-session is unavailable over ACP."] : []);
	});

	it.skipIf(process.platform !== "linux")("intercepts disabled builtins at the ACP turn.prompt ingress", async () => {
		const fixture = await createAcpPromptFixture();
		try {
			const result = await fixture.agent.prompt({
				sessionId: fixture.sessionId,
				prompt: [{ type: "text", text: "/import-session codex" }],
			});
			expect(result).toEqual({ stopReason: "end_turn" });
			expect(fixture.controlOperations).not.toContain("turn.prompt");
			expect(fixture.updates).toContainEqual(
				expect.objectContaining({
					sessionId: fixture.sessionId,
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: "Slash command /import-session is unavailable over ACP." },
					},
				}),
			);
		} finally {
			fixture.dispose();
		}
	});

	it.skipIf(process.platform !== "linux")("forwards unknown slash input and normal prompts through ACP", async () => {
		const fixture = await createAcpPromptFixture();
		try {
			await fixture.agent.prompt({
				sessionId: fixture.sessionId,
				prompt: [{ type: "text", text: "/unknown-command" }],
			});
			await waitFor(() =>
				fixture.updates.some(
					update =>
						update.update.sessionUpdate === "agent_message_chunk" &&
						update.update.content.type === "text" &&
						update.update.content.text.includes("fixture response"),
				),
			);
			await Bun.sleep(0);
			await fixture.agent.prompt({
				sessionId: fixture.sessionId,
				prompt: [{ type: "text", text: "normal prompt" }],
			});
			expect(fixture.promptTexts).toEqual(["/unknown-command", "normal prompt"]);
			expect(fixture.controlOperations.filter(operation => operation === "turn.prompt")).toHaveLength(2);
		} finally {
			fixture.dispose();
		}
	});

	it("advertises and dispatches only where retained-descriptor authority is available", async () => {
		const available = process.platform === "linux";
		expect(BUILTIN_SLASH_COMMAND_DEFS.some(command => command.name === "import-session")).toBe(available);
		expect(lookupBuiltinSlashCommand("import-session") !== undefined).toBe(available);

		const tuiOutput: string[] = [];
		const tuiRuntime = {
			ctx: {
				session: {},
				sessionManager: { getCwd: () => "/workspace" },
				settings: {},
				showStatus: (text: string) => tuiOutput.push(text),
				refreshSlashCommandState: () => {},
				editor: { setText: () => {} },
			},
		} as unknown as TuiSlashCommandRuntime;
		expect(await executeBuiltinSlashCommand("/import-session unsupported", tuiRuntime)).toBe(available);
		expect(tuiOutput).toEqual(
			available ? ["Import failed: source_not_found [read] — Transcript file does not exist: unsupported"] : [],
		);

		const headlessOutput: string[] = [];
		const headlessRuntime = {
			output: (text: string) => headlessOutput.push(text),
		} as unknown as SlashCommandRuntime;
		expect(await executeLocalHeadlessBuiltinSlashCommand("/import-session unsupported", headlessRuntime)).toEqual(
			available ? { consumed: true, exitCode: 1 } : false,
		);
		expect(headlessOutput).toEqual(
			available ? ["Import failed: source_not_found [read] — Transcript file does not exist: unsupported"] : [],
		);
	});

	it.skipIf(process.platform !== "linux")(
		"retains a local handler and routes through the local TUI/headless adapter",
		async () => {
			const spec = lookupBuiltinSlashCommand("import-session");
			expect(spec).toMatchObject({ acp: false, localHeadless: true, allowArgs: true });
			expect(typeof spec?.handle).toBe("function");
			const output: string[] = [];
			const runtime = {
				ctx: {
					session: {},
					sessionManager: { getCwd: () => "/workspace" },
					settings: {},
					showStatus: (text: string) => output.push(text),
					refreshSlashCommandState: () => {},
					editor: { setText: () => {} },
				},
			} as unknown as TuiSlashCommandRuntime;
			expect(await executeBuiltinSlashCommand("/import-session unsupported", runtime)).toBe(true);
			expect(output).toEqual([
				"Import failed: source_not_found [read] — Transcript file does not exist: unsupported",
			]);
		},
	);

	it.skipIf(process.platform !== "linux")(
		"dispatches through the explicit trusted local headless policy",
		async () => {
			const output: string[] = [];
			const runtime = {
				output: (text: string) => output.push(text),
			} as unknown as SlashCommandRuntime;
			expect(await executeLocalHeadlessBuiltinSlashCommand("/import-session unsupported", runtime)).toEqual({
				consumed: true,
				exitCode: 1,
			});
			expect(output).toEqual([
				"Import failed: source_not_found [read] — Transcript file does not exist: unsupported",
			]);
		},
	);
});
