#!/usr/bin/env bun

import { createHash, randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";

// Trusted-local procedural policy only. The Broker and SessionRouter retain session lifecycle and attachment authority.

// Long-running prompts: the SDK deadline is a progress-aware lease (sdk.promptDeadlineMs is
// an inactivity lease renewed only by attributable tool_execution_start/end for the exact
// accepted commandId/turnId, bounded by sdk.promptMaxRuntimeMs). Persist session_id/turn_id
// and reconcile via turn.result (Q26) rather than blindly replaying; heartbeats/streaming/
// retries/other-turn activity do not renew. Distinguish the bounded await_turn poll timeout
// from the SDK terminal deadline.

const CORE_QUERIES = [
	"session.metadata",
	"context.get",
	"goal.list/get",
	"todo.list",
	"workflow.gates.list",
	"session.stats",
] as const;

const ALLOWED_CONTROLS: ReadonlySet<string> = new Set(["turn.prompt","turn.steer","turn.follow_up","ask.answer","workflow.gate_answer","todo.replace","session.switch","session.rename"]);
const SECRET_FIELD = /(?:secret|token|password|credential|authorization|api[_-]?key)/i;
const ALLOWED_ARGUMENTS = new Set(["--repo", "--session-id", "--mode", "--operation", "--input"]);

type Arguments = {
	repo: string;
	sessionId: string;
	mode: "inspect" | "control";
	operation?: string;
	input: Record<string, unknown>;
};

function parseArgs(argv: string[]): Arguments {
	const values = new Map<string, string>();
	for (let index = 0; index < argv.length; index++) {
		const token = argv[index];
		if (!ALLOWED_ARGUMENTS.has(token) || values.has(token)) throw new Error("invalid_argument");
		const value = argv[++index];
		if (!value) throw new Error("missing_argument_value");
		values.set(token, value);
	}
	const repo = values.get("--repo");
	const sessionId = values.get("--session-id");
	if (!repo) throw new Error("missing_repo");
	if (!sessionId) throw new Error("missing_session_id");
	const mode = values.get("--mode") ?? "inspect";
	if (mode !== "inspect" && mode !== "control") throw new Error("invalid_mode");
	let input: Record<string, unknown> = {};
	const rawInput = values.get("--input");
	if (rawInput) {
		const parsed: unknown = JSON.parse(rawInput);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_input");
		input = parsed as Record<string, unknown>;
	}
	if (hasSecretField(input)) throw new Error("secret_input_forbidden");
	return { repo, sessionId, mode, operation: values.get("--operation"), input };
}

function hasSecretField(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(hasSecretField);
	if (!value || typeof value !== "object") return false;
	return Object.entries(value as Record<string, unknown>).some(([key, nested]) => SECRET_FIELD.test(key) || hasSecretField(nested));
}

function redact(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redact);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).map(([key, item]) => [
			key,
			SECRET_FIELD.test(key) ? "[REDACTED]" : redact(item),
		]),
	);
}

function parseCliJson(stdout: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new Error("invalid_cli_response");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_cli_response");
	return parsed as Record<string, unknown>;
}

// Preserve the trusted CLI's bounded public envelope, including exact reconciliation references.
class CliFailure extends Error {
	constructor(readonly envelope: Record<string, unknown>, readonly exitCode: number) { super("broker_request_failed"); }
}

async function runGjcSession(repo: string, arguments_: readonly string[]): Promise<Record<string, unknown>> {
	const child = Bun.spawn(["gjc", "sdk", "session", ...arguments_, "--json"], {
		cwd: repo,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	const response = parseCliJson(stdout);
	if (exitCode !== 0 || response.ok === false) {
		if (Buffer.byteLength(stdout) > 8192 || response.schema !== "gjc.command-error" || response.version !== 1 || response.ok !== false)
			throw new Error("invalid_cli_response");
		throw new CliFailure(response, exitCode === 2 ? 2 : 1);
	}
	return response;
}

async function inspect(repo: string, sessionId: string): Promise<Record<string, unknown>> {
	const snapshot: Record<string, unknown> = {};
	for (const query of CORE_QUERIES) {
		try {
			const response = await runGjcSession(repo, ["raw", "query", sessionId, "--query", query]);
			if (response.ok === false) throw new Error("query_unavailable");
			snapshot[query] = { status: "confirmed", source: query, value: redact(response) };
		} catch (error) {
			snapshot[query] = { status: "unavailable", source: query, ...(error instanceof CliFailure ? { failure: error.envelope } : {}) };
		}
	}
	return snapshot;
}

async function requireApproval(sessionId: string, operation: string, input: Record<string, unknown>): Promise<void> {
	const digest = createHash("sha256").update(JSON.stringify({ sessionId, operation, input })).digest("hex").slice(0, 16);
	const challenge = `APPROVE ${sessionId} ${operation} ${digest} ${randomBytes(8).toString("hex")}`;
	const reader = createInterface({ input: process.stdin, output: process.stderr });
	try {
		if ((await reader.question(`Approval required: ${challenge}\nType the exact challenge: `)).trim() !== challenge)
			throw new Error("human_approval_required");
	} finally { reader.close(); }
}


async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (args.mode === "inspect") {
		const result = await inspect(args.repo, args.sessionId);
		process.stdout.write(JSON.stringify({ sessionId: args.sessionId, result }, null, 2) + "\n");
		return;
	}
	if (!args.operation || !ALLOWED_CONTROLS.has(args.operation)) throw new Error("operation_not_allowed");
	const input = args.operation === "workflow.gate_answer" ? { ...args.input, expectedSessionId: args.sessionId } : args.input;
	await requireApproval(args.sessionId, args.operation, input);
	const result = await runGjcSession(args.repo, [
		"raw",
		"control",
		args.sessionId,
		"--op",
		args.operation,
		"--json-input",
		JSON.stringify(input),
		"--confirm",
	]);
	if (result.ok === false) throw new Error("control_failed");
	process.stdout.write(JSON.stringify(redact({ sessionId: args.sessionId, result }), null, 2) + "\n");
}

main().catch(error => {
	if (error instanceof CliFailure) {
		process.stdout.write(JSON.stringify(error.envelope) + "\n");
		process.exitCode = error.exitCode;
	} else { process.stderr.write("GJC SDK request failed safely.\n"); process.exitCode = 1; }
});
