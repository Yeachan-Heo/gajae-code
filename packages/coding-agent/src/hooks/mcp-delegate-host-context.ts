import * as fs from "node:fs/promises";
import * as path from "node:path";
import { sessionStateDir } from "../gjc-runtime/session-layout";

export const GJC_MCP_DELEGATE_FLOW_ACTIVATION = "$gjc-mcp-delegate-flow";

const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,256}$/;
const ACTIVATION_PATTERN = /(?:^|[^A-Za-z0-9_-])\$gjc-mcp-delegate-flow(?=$|[^A-Za-z0-9_-])/;

export interface McpDelegateHostContextV1 {
	schema_version: 1;
	activation: typeof GJC_MCP_DELEGATE_FLOW_ACTIVATION;
	session_id: string | null;
	thread_id: string | null;
	turn_id: string | null;
	cwd: string;
	source: "user_prompt_submit";
	recorded_at: string;
	prompt_excerpt: string;
}

function optionalString(value: string | undefined): string | null {
	return value?.trim() || null;
}

function promptExcerpt(prompt: string): string {
	return prompt.replace(/\s+/g, " ").trim().slice(0, 400);
}

function isMcpDelegateHostContextV1(value: unknown): value is McpDelegateHostContextV1 {
	if (!value || typeof value !== "object") return false;
	const context = value as Record<string, unknown>;
	return (
		context.schema_version === 1 &&
		context.activation === GJC_MCP_DELEGATE_FLOW_ACTIVATION &&
		(typeof context.session_id === "string" || context.session_id === null) &&
		(typeof context.thread_id === "string" || context.thread_id === null) &&
		(typeof context.turn_id === "string" || context.turn_id === null) &&
		typeof context.cwd === "string" &&
		context.source === "user_prompt_submit" &&
		typeof context.recorded_at === "string" &&
		typeof context.prompt_excerpt === "string"
	);
}

export function detectMcpDelegateFlowActivation(prompt: string): boolean {
	return ACTIVATION_PATTERN.test(prompt);
}

export function mcpDelegateHostContextPath(cwd: string, sessionId: string): string {
	if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error("invalid_session_id");
	return path.join(sessionStateDir(cwd, sessionId), "mcp-delegate-host-context.json");
}

export async function persistMcpDelegateHostContext(input: {
	cwd: string;
	sessionId?: string;
	threadId?: string;
	turnId?: string;
	prompt: string;
}): Promise<{ path: string; context: McpDelegateHostContextV1 } | null> {
	if (!detectMcpDelegateFlowActivation(input.prompt)) return null;
	const sessionId = optionalString(input.sessionId);
	if (!sessionId) return null;
	const context: McpDelegateHostContextV1 = {
		schema_version: 1,
		activation: GJC_MCP_DELEGATE_FLOW_ACTIVATION,
		session_id: sessionId,
		thread_id: optionalString(input.threadId),
		turn_id: optionalString(input.turnId),
		cwd: input.cwd,
		source: "user_prompt_submit",
		recorded_at: new Date().toISOString(),
		prompt_excerpt: promptExcerpt(input.prompt),
	};
	const contextPath = mcpDelegateHostContextPath(input.cwd, sessionId);
	await fs.mkdir(sessionStateDir(input.cwd, sessionId), { recursive: true });
	await fs.writeFile(contextPath, `${JSON.stringify(context, null, "\t")}\n`, "utf8");
	return { path: contextPath, context };
}

export async function readMcpDelegateHostContext(
	cwd: string,
	sessionId: string,
): Promise<McpDelegateHostContextV1 | null> {
	const contextPath = mcpDelegateHostContextPath(cwd, sessionId);
	let contents: string;
	try {
		contents = await fs.readFile(contextPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw new Error("state_unreadable");
	}
	try {
		const context = JSON.parse(contents);
		if (!isMcpDelegateHostContextV1(context)) throw new Error("state_corrupt");
		return context;
	} catch {
		throw new Error("state_corrupt");
	}
}
