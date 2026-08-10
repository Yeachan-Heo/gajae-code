#!/usr/bin/env bun

import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { SdkClient, listSdkSessionEndpoints, type SdkSessionEndpoint } from "@gajae-code/coding-agent/sdk";

// Trusted-local procedural policy only; this template does not isolate a modified process from endpoint authority.

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
	sessionId?: string;
	mode: "inspect" | "control";
	operation?: string;
	input: Record<string, unknown>;
};

function parseArgs(argv: string[]): Arguments {
	const values = new Map<string, string>();
	for (let index = 0; index < argv.length; index++) {
		const token = argv[index];
		if (!ALLOWED_ARGUMENTS.has(token)) throw new Error("invalid_argument");
		const value = argv[++index];
		if (!value) throw new Error("missing_argument_value");
		values.set(token, value);
	}
	const repo = values.get("--repo");
	if (!repo) throw new Error("missing_repo");
	const mode = values.get("--mode") ?? "inspect";
	if (mode !== "inspect" && mode !== "control") throw new Error("invalid_mode");
	let input: Record<string, unknown> = {};
	const rawInput = values.get("--input");
	if (rawInput) {
		const parsed: unknown = JSON.parse(rawInput);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_input");
		input = parsed as Record<string, unknown>;
	}
	return {
		repo,
		sessionId: values.get("--session-id"),
		mode,
		operation: values.get("--operation"),
		input,
	};
}

function endpointState(endpoint: SdkSessionEndpoint): "live" | "stale" | "dead" | "unknown" {
	if (endpoint.stale) return "stale";
	if (!endpoint.pid) return "unknown";
	try {
		process.kill(endpoint.pid, 0);
		return "live";
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EPERM") return "live";
		return code === "ESRCH" ? "dead" : "unknown";
	}
}

async function selectEndpoint(repo: string, sessionId?: string): Promise<SdkSessionEndpoint> {
	const discoveryDirectory = path.join(repo, ".gjc", "state", "sdk");
	const directoryStat = await lstat(discoveryDirectory).catch(() => undefined);
	if (!directoryStat || directoryStat.isSymbolicLink() || !directoryStat.isDirectory())
		throw new Error("unsafe_discovery_directory");
	const entries = await readdir(discoveryDirectory, { withFileTypes: true });
	if (entries.some(entry => entry.isSymbolicLink())) throw new Error("unsafe_discovery_record");
	if (entries.some(entry => entry.name.endsWith(".json") && !entry.isFile())) throw new Error("unsafe_discovery_record");
	const discovered = await listSdkSessionEndpoints(repo);
	if (discovered.warnings.length > 0) throw new Error("discovery_warning");
	for (const endpoint of discovered.endpoints) {
		const endpointStat = await lstat(endpoint.path).catch(() => undefined);
		if (!endpointStat || endpointStat.isSymbolicLink() || !endpointStat.isFile())
			throw new Error("unsafe_discovery_record");
		const record: unknown = JSON.parse(await readFile(endpoint.path, "utf8"));
		const embeddedSessionId =
			record && typeof record === "object" ? (record as { sessionId?: unknown }).sessionId : undefined;
		if (embeddedSessionId !== undefined && embeddedSessionId !== endpoint.sessionId)
			throw new Error("invalid_discovery_record");
	}
	const live = discovered.endpoints.filter(endpoint => endpointState(endpoint) === "live");
	if (sessionId) {
		const selected = discovered.endpoints.find(endpoint => endpoint.sessionId === sessionId);
		if (!selected) throw new Error("session_not_found");
		if (endpointState(selected) !== "live") throw new Error("session_not_live");
		return selected;
	}
	if (live.length !== 1) throw new Error(live.length === 0 ? "no_live_session" : "ambiguous_session");
	return live[0];
}

function sameEndpoint(left: SdkSessionEndpoint, right: SdkSessionEndpoint): boolean {
	return (
		left.sessionId === right.sessionId &&
		left.url === right.url &&
		left.token === right.token &&
		left.pid === right.pid &&
		left.stale === right.stale &&
		left.path === right.path
	);
}

function redact(value: unknown, endpointToken: string): unknown {
	if (typeof value === "string") return value.replaceAll(endpointToken, "[REDACTED]");
	if (Array.isArray(value)) return value.map(item => redact(item, endpointToken));
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).map(([key, item]) => [
			key,
			SECRET_FIELD.test(key) ? "[REDACTED]" : redact(item, endpointToken),
		]),
	);
}

async function inspect(client: SdkClient, endpointToken: string): Promise<Record<string, unknown>> {
	const snapshot: Record<string, unknown> = {};
	for (const query of CORE_QUERIES) {
		try {
			snapshot[query] = { status: "confirmed", source: query, value: redact(await client.query(query), endpointToken) };
		} catch {
			snapshot[query] = { status: "unavailable", source: query };
		}
	}
	return snapshot;
}

async function requireApproval(sessionId: string, operation: string, input: Record<string, unknown>): Promise<void> {
	const digest = createHash("sha256")
		.update(JSON.stringify({ sessionId, operation, input }))
		.digest("hex")
		.slice(0, 16);
	const challenge = `APPROVE ${sessionId} ${operation} ${digest} ${randomBytes(8).toString("hex")}`;
	const reader = createInterface({ input: process.stdin, output: process.stderr });
	try {
		const answer = await reader.question(`Approval required: ${challenge}\nType the exact challenge: `);
		if (answer.trim() !== challenge) throw new Error("human_approval_required");
	} finally {
		reader.close();
	}
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	let endpoint = await selectEndpoint(args.repo, args.sessionId);
	if (args.mode === "control") {
		if (!args.operation || !ALLOWED_CONTROLS.has(args.operation)) throw new Error("operation_not_allowed");
		if (args.operation === "workflow.gate_answer") args.input.expectedSessionId = endpoint.sessionId;
		await requireApproval(endpoint.sessionId, args.operation, args.input);
		const revalidated = await selectEndpoint(args.repo, endpoint.sessionId);
		if (!sameEndpoint(endpoint, revalidated)) throw new Error("endpoint_changed");
		endpoint = revalidated;
	}
	const client = await SdkClient.connect(endpoint.url, endpoint.token);
	try {
		const result =
			args.mode === "inspect"
				? await inspect(client, endpoint.token)
				: await client.control(args.operation!, args.input, { confirm: true });
		process.stdout.write(JSON.stringify(redact({ sessionId: endpoint.sessionId, result }, endpoint.token), null, 2) + "\n");
	} finally {
		await client.close();
	}
}

main().catch(() => {
	process.stderr.write("GJC SDK request failed safely.\n");
	process.exitCode = 1;
});
