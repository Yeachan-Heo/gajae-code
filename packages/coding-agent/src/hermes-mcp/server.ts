import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { VERSION } from "@gajae-code/utils";
import {
	assertHermesArtifactPath,
	assertHermesWorkdir,
	buildHermesMcpConfig,
	type HermesMcpConfig,
	hermesNamespacePath,
	requireHermesMutation,
} from "./policy";
import { createHermesSafetyPolicy, type HermesFailure, type HermesMutationClass } from "./safety";

export const HERMES_MCP_PROTOCOL_VERSION = "2024-11-05";
export const HERMES_MCP_SERVER_NAME = "gjc-hermes-mcp";

export const HERMES_MCP_TOOL_NAMES = [
	"gjc_hermes_list_sessions",
	"gjc_hermes_read_status",
	"gjc_hermes_read_tail",
	"gjc_hermes_list_questions",
	"gjc_hermes_list_artifacts",
	"gjc_hermes_read_artifact",
	"gjc_hermes_read_coordination_status",
	"gjc_hermes_start_session",
	"gjc_hermes_send_prompt",
	"gjc_hermes_submit_question_answer",
	"gjc_hermes_report_status",
] as const;

type HermesToolName = (typeof HERMES_MCP_TOOL_NAMES)[number];

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id?: string | number | null;
	method: string;
	params?: unknown;
}

interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: string | number | null;
	result?: any;
	error?: { code: number; message: string; data?: unknown };
}

interface SessionStartInput {
	cwd: string;
	prompt?: string;
	namespace: { profile: string | null; repo: string | null };
	worktree: true;
}

interface HermesServices {
	listSessions?: () => unknown[] | Promise<unknown[]>;
	startSession?: (input: SessionStartInput) => unknown | Promise<unknown>;
}

interface HermesMcpServerOptions {
	env?: NodeJS.ProcessEnv;
	services?: HermesServices;
}

interface LegacyHandlerOptions {
	env?: NodeJS.ProcessEnv;
	createSession?: () => unknown;
}

function textResult(
	payload: unknown,
	isError = false,
): { content: Array<{ type: "text"; text: string }>; isError: boolean } {
	return {
		content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) }],
		isError,
	};
}

function toolSchema(name: HermesToolName): {
	name: HermesToolName;
	description: string;
	inputSchema: Record<string, unknown>;
} {
	const allowMutation = { type: "boolean", description: "Required and must be true for mutating tools." };
	const cwd = {
		type: "string",
		description: "Canonicalized GJC worktree or project directory inside configured roots.",
	};
	const sessionId = { type: "string", description: "GJC Hermes bridge session id." };
	const pathField = { type: "string", description: "Artifact path inside configured safe roots." };
	const common = { type: "object", properties: {} as Record<string, unknown> };
	if (name === "gjc_hermes_start_session") {
		return {
			name,
			description: "Start a GJC worktree/tmux oriented session through the Hermes bridge.",
			inputSchema: {
				type: "object",
				properties: { cwd, prompt: { type: "string" }, allow_mutation: allowMutation },
				required: ["cwd", "allow_mutation"],
			},
		};
	}
	if (name === "gjc_hermes_send_prompt") {
		return {
			name,
			description: "Queue a bounded follow-up prompt for a selected Hermes bridge session.",
			inputSchema: {
				type: "object",
				properties: { session_id: sessionId, prompt: { type: "string" }, allow_mutation: allowMutation },
				required: ["session_id", "prompt", "allow_mutation"],
			},
		};
	}
	if (name === "gjc_hermes_submit_question_answer") {
		return {
			name,
			description: "Submit a bounded structured answer by question id.",
			inputSchema: {
				type: "object",
				properties: { question_id: { type: "string" }, answer: {}, allow_mutation: allowMutation },
				required: ["question_id", "answer", "allow_mutation"],
			},
		};
	}
	if (name === "gjc_hermes_report_status") {
		return {
			name,
			description: "Write a bounded Hermes coordination status report.",
			inputSchema: {
				type: "object",
				properties: {
					status: { type: "string" },
					summary: { type: "string" },
					blocker: { type: "string" },
					pr_url: { type: "string" },
					evidence_paths: { type: "array", items: { type: "string" } },
					allow_mutation: allowMutation,
				},
				required: ["status", "allow_mutation"],
			},
		};
	}
	if (name === "gjc_hermes_read_artifact") {
		return {
			name,
			description: "Read one bounded artifact from configured safe roots.",
			inputSchema: { type: "object", properties: { path: pathField }, required: ["path"] },
		};
	}
	if (name === "gjc_hermes_read_status") {
		return {
			name,
			description: "Read selected Hermes bridge session status.",
			inputSchema: { type: "object", properties: { session_id: sessionId } },
		};
	}
	if (name === "gjc_hermes_read_tail") {
		return {
			name,
			description: "Read a bounded structured session tail, not tmux scrollback.",
			inputSchema: { type: "object", properties: { session_id: sessionId, lines: { type: "number" } } },
		};
	}
	if (name === "gjc_hermes_list_questions") {
		return {
			name,
			description: "List bounded structured questions for Hermes coordination.",
			inputSchema: { type: "object", properties: { session_id: sessionId, status: { type: "string" } } },
		};
	}
	if (name === "gjc_hermes_list_artifacts") {
		return { name, description: "List known safe artifact roots for Hermes coordination.", inputSchema: common };
	}
	if (name === "gjc_hermes_read_coordination_status") {
		return { name, description: "Read Hermes coordination reports.", inputSchema: common };
	}
	return { name, description: "List known scoped GJC Hermes bridge sessions.", inputSchema: common };
}

function normalizeSession(session: any): Record<string, unknown> {
	return {
		session_id: session.sessionId ?? session.session_id ?? session.name ?? "unknown",
		...(session.tmuxSession ? { tmux_session: session.tmuxSession } : {}),
		...(session.cwd ? { cwd: session.cwd } : {}),
		...(session.createdAt ? { created_at: session.createdAt } : {}),
		...session,
	};
}

async function ensureDir(dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
}

async function readJsonFile(file: string): Promise<any | null> {
	try {
		return JSON.parse(await fs.readFile(file, "utf8"));
	} catch {
		return null;
	}
}

async function writeJsonFile(file: string, value: unknown): Promise<void> {
	await ensureDir(path.dirname(file));
	await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function listJsonFiles(dir: string): Promise<any[]> {
	try {
		const entries = await fs.readdir(dir);
		const values = await Promise.all(
			entries.filter(entry => entry.endsWith(".json")).map(entry => readJsonFile(path.join(dir, entry))),
		);
		return values.filter(value => value !== null);
	} catch {
		return [];
	}
}
async function runCommand(command: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
}

function boundedLineCount(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return 80;
	return Math.min(parsed, 400);
}

async function startTmuxSession(
	config: HermesMcpConfig,
	input: SessionStartInput,
): Promise<Record<string, unknown> | null> {
	if (!config.sessionCommand) return null;
	const sessionName = `gjc-hermes-${randomUUID().slice(0, 8)}`;
	const started = await runCommand([
		"tmux",
		"new-session",
		"-d",
		"-P",
		"-F",
		"#{session_name}:#{window_index}.#{pane_index} #{pane_id}",
		"-s",
		sessionName,
		"-c",
		input.cwd,
		config.sessionCommand,
	]);
	if (started.exitCode !== 0) throw new Error(`hermes_tmux_start_failed:${started.stderr || started.stdout}`);
	const [tmuxTarget, paneId] = started.stdout.trim().split(/\s+/, 2);
	if (input.prompt) {
		await runCommand(["tmux", "send-keys", "-t", tmuxTarget || sessionName, input.prompt, "C-m"]);
	}
	return {
		sessionId: sessionName,
		tmuxSession: sessionName,
		tmuxTarget: tmuxTarget || sessionName,
		paneId,
		cwd: input.cwd,
		createdAt: new Date().toISOString(),
		sessionCommand: config.sessionCommand,
	};
}

async function captureTmuxTail(session: Record<string, unknown>, lines: number): Promise<string[]> {
	const target = typeof session.tmux_target === "string" ? session.tmux_target : session.tmuxTarget;
	if (typeof target !== "string" || target.length === 0) return [];
	const captured = await runCommand(["tmux", "capture-pane", "-t", target, "-p", "-S", `-${lines}`]);
	if (captured.exitCode !== 0) return [];
	return captured.stdout.split("\n").slice(-lines);
}

async function sendTmuxPrompt(session: Record<string, unknown>, prompt: string): Promise<boolean> {
	const target = typeof session.tmux_target === "string" ? session.tmux_target : session.tmuxTarget;
	if (typeof target !== "string" || target.length === 0) return false;
	const sent = await runCommand(["tmux", "send-keys", "-t", target, prompt, "C-m"]);
	return sent.exitCode === 0;
}

async function hasTmuxSession(session: Record<string, unknown>): Promise<boolean | null> {
	const tmuxSession = typeof session.tmux_session === "string" ? session.tmux_session : session.tmuxSession;
	if (typeof tmuxSession !== "string" || tmuxSession.length === 0) return null;
	const checked = await runCommand(["tmux", "has-session", "-t", tmuxSession]);
	return checked.exitCode === 0;
}

export async function readHermesArtifact(
	config: HermesMcpConfig,
	args: { path: unknown },
): Promise<Record<string, unknown>> {
	try {
		const resolved = await assertHermesArtifactPath(config, args.path);
		const file = await fs.readFile(resolved.path, "utf8");
		const text = file.slice(0, resolved.byteCap);
		return {
			ok: true,
			path: resolved.path,
			text,
			bytes: Buffer.byteLength(text),
			truncated: file.length > text.length,
		};
	} catch (error) {
		return {
			ok: false,
			reason: (error instanceof Error ? error.message.split(":")[0] : String(error)).replace(/^hermes_/, ""),
		};
	}
}

export function createHermesMcpServer(options: HermesMcpServerOptions = {}) {
	const config = buildHermesMcpConfig(options.env ?? process.env);
	const services = options.services ?? {};
	const namespaceDir = hermesNamespacePath(config);

	async function listSessions(): Promise<unknown[]> {
		if (!config.namespace.profile || !config.namespace.repo) return [];
		if (services.listSessions) return await services.listSessions();
		return await listJsonFiles(path.join(namespaceDir, "sessions"));
	}
	function sessionFile(sessionId: unknown): string {
		return path.join(namespaceDir, "sessions", `${String(sessionId ?? "")}.json`);
	}

	async function callTool(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
		try {
			if (name === "gjc_hermes_list_sessions") return { ok: true, sessions: await listSessions() };
			if (name === "gjc_hermes_read_status") {
				const sessionId = args.session_id;
				if (sessionId) {
					const session = await readJsonFile(sessionFile(sessionId));
					return { ok: true, session, live: session ? await hasTmuxSession(session) : false };
				}
				return { ok: true, sessions: await listSessions() };
			}
			if (name === "gjc_hermes_read_tail") {
				const session = await readJsonFile(sessionFile(args.session_id));
				return { ok: true, lines: session ? await captureTmuxTail(session, boundedLineCount(args.lines)) : [] };
			}
			if (name === "gjc_hermes_list_questions")
				return { ok: true, questions: await listJsonFiles(path.join(namespaceDir, "questions")) };
			if (name === "gjc_hermes_list_artifacts") return { ok: true, roots: config.allowedRoots };
			if (name === "gjc_hermes_read_artifact") return await readHermesArtifact(config, { path: args.path });
			if (name === "gjc_hermes_read_coordination_status")
				return { ok: true, reports: await listJsonFiles(path.join(namespaceDir, "reports")) };
			if (name === "gjc_hermes_start_session") {
				requireHermesMutation(config, "sessions", args);
				const cwd = await assertHermesWorkdir(config, args.cwd);
				const input = {
					cwd,
					prompt: typeof args.prompt === "string" ? args.prompt : undefined,
					namespace: config.namespace,
					worktree: true as const,
				};
				const started = services.startSession
					? await services.startSession(input)
					: await startTmuxSession(config, input);
				const session = normalizeSession(
					started ?? { sessionId: `gjc-hermes-${Date.now()}`, cwd, createdAt: new Date().toISOString() },
				);
				await writeJsonFile(sessionFile(session.session_id), session);
				return { ok: true, session };
			}
			if (name === "gjc_hermes_send_prompt") {
				requireHermesMutation(config, "sessions", args);
				const session = await readJsonFile(sessionFile(args.session_id));
				const delivered =
					session && typeof args.prompt === "string" ? await sendTmuxPrompt(session, args.prompt) : false;
				const queued = {
					session_id: args.session_id,
					prompt: args.prompt,
					queued: !delivered,
					delivered,
					created_at: new Date().toISOString(),
				};
				await writeJsonFile(path.join(namespaceDir, "prompts", `${Date.now()}.json`), queued);
				return { ok: true, queued: !delivered, delivered, prompt: queued };
			}
			if (name === "gjc_hermes_submit_question_answer") {
				requireHermesMutation(config, "questions", args);
				const questionId = String(args.question_id ?? "");
				const questionPath = path.join(namespaceDir, "questions", `${questionId}.json`);
				const question = await readJsonFile(questionPath);
				if (!question) return { ok: false, reason: "unknown_question" };
				const answered = {
					...question,
					status: "answered",
					answer: args.answer,
					answered_at: new Date().toISOString(),
				};
				await writeJsonFile(questionPath, answered);
				return { ok: true, question: answered };
			}
			if (name === "gjc_hermes_report_status") {
				requireHermesMutation(config, "reports", args);
				const report = {
					status: args.status,
					summary: args.summary,
					blocker: args.blocker,
					pr_url: args.pr_url,
					evidence_paths: args.evidence_paths ?? [],
					created_at: new Date().toISOString(),
				};
				await writeJsonFile(path.join(namespaceDir, "reports", `${Date.now()}.json`), report);
				return { ok: true, report };
			}
			return { ok: false, reason: "unknown_tool", tool: name };
		} catch (error) {
			return { ok: false, reason: error instanceof Error ? error.message : String(error) };
		}
	}

	async function handleJsonRpc(request: JsonRpcRequest): Promise<JsonRpcResponse> {
		const id = request.id ?? null;
		if (request.method === "initialize") {
			return {
				jsonrpc: "2.0",
				id,
				result: {
					protocolVersion: HERMES_MCP_PROTOCOL_VERSION,
					capabilities: { tools: {}, prompts: {}, resources: {} },
					serverInfo: { name: HERMES_MCP_SERVER_NAME, version: VERSION },
				},
			};
		}
		if (request.method === "tools/list") {
			return { jsonrpc: "2.0", id, result: { tools: HERMES_MCP_TOOL_NAMES.map(toolSchema) } };
		}
		if (request.method === "prompts/list") {
			return { jsonrpc: "2.0", id, result: { prompts: [] } };
		}
		if (request.method === "resources/list") {
			return { jsonrpc: "2.0", id, result: { resources: [] } };
		}
		if (request.method === "tools/call") {
			const params = (request.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
			const payload = await callTool(params.name ?? "", params.arguments ?? {});
			return { jsonrpc: "2.0", id, result: textResult(payload, payload.ok === false) };
		}
		return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown_method:${request.method}` } };
	}

	return { config, callTool, handleJsonRpc, handle: handleJsonRpc };
}

function legacyMutationClass(name: string): HermesMutationClass | null {
	if (name === "gjc_hermes_start_session" || name === "gjc_hermes_send_prompt") return "session";
	if (name === "gjc_hermes_submit_question_answer") return "question";
	if (name === "gjc_hermes_report_status") return "report";
	return null;
}

function legacyToolResult(payload: unknown): { content: Array<{ type: "text"; text: string }>; isError: boolean } {
	const failed = typeof payload === "object" && payload !== null && (payload as { ok?: unknown }).ok === false;
	return textResult(payload, failed);
}

export async function handleHermesMcpRequest(
	request: JsonRpcRequest,
	options: LegacyHandlerOptions = {},
): Promise<any> {
	if (request.method === "initialize") {
		return {
			jsonrpc: "2.0",
			id: request.id ?? null,
			result: {
				protocolVersion: HERMES_MCP_PROTOCOL_VERSION,
				capabilities: { tools: {}, prompts: {}, resources: {} },
				serverInfo: { name: HERMES_MCP_SERVER_NAME, version: VERSION },
			},
		};
	}
	if (request.method === "tools/list") {
		return { jsonrpc: "2.0", id: request.id ?? null, result: { tools: HERMES_MCP_TOOL_NAMES.map(toolSchema) } };
	}
	if (request.method === "prompts/list") {
		return { jsonrpc: "2.0", id: request.id ?? null, result: { prompts: [] } };
	}
	if (request.method === "resources/list") {
		return { jsonrpc: "2.0", id: request.id ?? null, result: { resources: [] } };
	}
	if (request.method !== "tools/call")
		return {
			jsonrpc: "2.0",
			id: request.id ?? null,
			error: { code: -32601, message: `unknown_method:${request.method}` },
		};
	const params = (request.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
	const args = params.arguments ?? {};
	const mutationClass = legacyMutationClass(params.name ?? "");
	const policy = await createHermesSafetyPolicy({ env: options.env ?? process.env });
	if (mutationClass) {
		const allowed = policy.assertMutationAllowed(mutationClass, args);
		if (allowed.ok === false)
			return { jsonrpc: "2.0", id: request.id ?? null, result: legacyToolResult(allowed as HermesFailure) };
	}
	if (params.name === "gjc_hermes_start_session") {
		const session = options.createSession ? options.createSession() : { session_id: "dry-run", cwd: args.cwd };
		return { jsonrpc: "2.0", id: request.id ?? null, result: legacyToolResult({ ok: true, session }) };
	}
	const server = createHermesMcpServer({ env: options.env ?? process.env });
	return {
		jsonrpc: "2.0",
		id: request.id ?? null,
		result: legacyToolResult(await server.callTool(params.name ?? "", args)),
	};
}

export async function runHermesMcpStdio(options: HermesMcpServerOptions = {}): Promise<void> {
	const server = createHermesMcpServer(options);
	let buffer = "";
	for await (const chunk of process.stdin) {
		buffer += chunk.toString();
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (line.length > 0) {
				const response = await server.handleJsonRpc(JSON.parse(line));
				process.stdout.write(`${JSON.stringify(response)}\n`);
			}
			newline = buffer.indexOf("\n");
		}
	}
}
