import * as path from "node:path";
import type { AgentTool, AgentToolResult } from "@gajae-code/agent-core";
import {
	MEMORY_ERROR_SCHEMA_VERSION,
	MEMORY_EXIT_CODES,
	type MemoryEnvironment,
	type MemoryError,
	type MemoryResult,
	type MemoryScopeKind,
	type RecallResult,
	recall,
	type WriteDestination,
} from "@gajae-code/memory-core";
import { getMemoryRootDir } from "@gajae-code/utils";
import * as z from "zod/v4";
import { buildMemoryEnvironment } from "../../cli/memory/environment";
import type { ToolSession } from "..";

const MEMORY_SCOPES = ["global", "project", "session"] as const satisfies readonly MemoryScopeKind[];
const MEMORY_INTENTS = [
	"user-preference",
	"project-convention",
	"architecture-rationale",
	"decision-history",
	"current-task-status",
	"resume-session",
	"person-identity",
	"environment",
	"debugging-history",
	"workflow-policy",
	"generic-recall",
] as const;

const memoryRecallSchema = z
	.object({
		query: z.string().describe("natural-language memory query"),
		intent: z.enum(MEMORY_INTENTS).optional().describe("optional retrieval intent"),
		scopes: z.array(z.enum(MEMORY_SCOPES)).min(1).optional().describe("memory scopes to search"),
		limit: z.number().int().positive().optional().describe("maximum number of sources"),
		complete: z.boolean().optional().describe("fail instead of returning a truncated result"),
	})
	.strict();

export type MemoryRecallParams = z.infer<typeof memoryRecallSchema>;

export interface MemoryToolErrorEnvelope {
	readonly schemaVersion: typeof MEMORY_ERROR_SCHEMA_VERSION;
	readonly code: MemoryError["code"];
	readonly exitCode: number;
	readonly [key: string]: unknown;
}

export type MemoryToolDetails<T> = T | MemoryToolErrorEnvelope;
export type MemoryToolResult<T> = AgentToolResult<MemoryToolDetails<T>>;

function sanitizeMemoryError(error: MemoryError): MemoryToolErrorEnvelope {
	const envelope: Record<string, unknown> = {
		schemaVersion: MEMORY_ERROR_SCHEMA_VERSION,
		code: error.code,
		exitCode: error.exitCode,
	};
	if (error.code === "invalid-input" || error.code === "scope-unresolved" || error.code === "truncated") {
		envelope.detail = error.detail;
	} else if (error.code === "not-found" || error.code === "stale-source") {
		envelope.uri = error.uri;
	} else if (error.code === "not-initialized") {
		envelope.remedy = error.remedy;
	} else if (error.code === "malformed-document" || error.code === "lock-conflict") {
		envelope.relPath = error.relPath;
		if (error.code === "malformed-document") envelope.detail = error.detail;
	} else if (error.code === "policy-denied") {
		envelope.destination = error.destination;
		envelope.reason = error.reason;
	} else if (error.code === "sensitivity-violation") {
		envelope.destination = error.destination;
		envelope.findings = error.findings.map(finding => ({
			kind: finding.kind,
			sensitivity: finding.sensitivity,
			line: finding.line,
			excerptRedacted: finding.excerptRedacted,
		}));
	} else if (error.code === "conflict-requires-confirmation") {
		envelope.conflicts = [];
	}
	return Object.freeze(envelope) as MemoryToolErrorEnvelope;
}

export function memoryToolError(error: MemoryError): MemoryToolResult<never> {
	const envelope = sanitizeMemoryError(error);
	return {
		content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
		details: envelope,
		isError: true,
	};
}

export function memoryToolResult<T>(result: MemoryResult<T>): MemoryToolResult<T> {
	if (!result.ok) return memoryToolError(result.error);
	return {
		content: [{ type: "text", text: JSON.stringify(result.value, null, 2) }],
		details: result.value,
	};
}

function environmentFailure(destination: WriteDestination): MemoryResult<never> {
	return {
		ok: false,
		error: {
			code: "policy-denied",
			exitCode: MEMORY_EXIT_CODES.policyDenied,
			destination,
			reason: "memory environment could not be resolved",
		},
	};
}

function notInitialized(memoryRoot: string): MemoryResult<never> {
	return {
		ok: false,
		error: {
			code: "not-initialized",
			exitCode: MEMORY_EXIT_CODES.notInitialized,
			memoryRoot,
			remedy: "Run `gjc memory init` to create an initialized memory root.",
		},
	};
}

async function memoryRootGate(session: ToolSession): Promise<MemoryResult<true>> {
	const memoryRoot = getMemoryRootDir(session.settings.getAgentDir());
	try {
		const markerExists = await Bun.file(path.join(memoryRoot, "MEMORY.md")).exists();
		return markerExists ? { ok: true, value: true } : notInitialized(memoryRoot);
	} catch {
		return notInitialized(memoryRoot);
	}
}

export async function memoryToolUnexpectedFailure(
	session: ToolSession,
	destination: WriteDestination,
): Promise<MemoryToolResult<never>> {
	const initialized = await memoryRootGate(session);
	if (!initialized.ok) return memoryToolError(initialized.error);
	return memoryToolError({
		code: "policy-denied",
		exitCode: MEMORY_EXIT_CODES.policyDenied,
		destination,
		reason: "memory operation failed closed",
	});
}

export async function memoryToolEnabled(session: ToolSession): Promise<boolean> {
	const initialized = await memoryRootGate(session);
	return initialized.ok;
}

/** Build the environment only after a per-ingress initialized-root check. */
export async function buildMemoryToolEnvironment(
	session: ToolSession,
	destination: WriteDestination,
): Promise<MemoryResult<MemoryEnvironment>> {
	const initialized = await memoryRootGate(session);
	if (!initialized.ok) return initialized;
	try {
		const sessionId = session.getSessionId?.();
		const environment = await buildMemoryEnvironment({
			settings: session.settings,
			cwd: session.cwd,
			...(sessionId === undefined || sessionId === null ? {} : { session: { flagValue: sessionId } }),
		});
		return { ok: true, value: environment };
	} catch {
		return environmentFailure(destination);
	}
}

export class MemoryRecallTool implements AgentTool<typeof memoryRecallSchema, MemoryToolDetails<RecallResult>> {
	readonly name = "memory_recall";
	readonly label = "Memory Recall";
	readonly summary = "Recall structured claims from initialized canonical memory";
	readonly description =
		"Search initialized canonical memory and return versioned citations, resolved claims, conflicts, and volatile verification hints.";
	readonly parameters = memoryRecallSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	static async createIf(session: ToolSession): Promise<MemoryRecallTool | null> {
		return (await memoryToolEnabled(session)) ? new MemoryRecallTool(session) : null;
	}

	async execute(_id: string, params: MemoryRecallParams): Promise<MemoryToolResult<RecallResult>> {
		const environment = await buildMemoryToolEnvironment(this.session, "ledger");
		if (!environment.ok) return memoryToolError(environment.error);
		try {
			return memoryToolResult(await recall(environment.value, params));
		} catch {
			return await memoryToolUnexpectedFailure(this.session, "ledger");
		}
	}
}
