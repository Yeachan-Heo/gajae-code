import * as fs from "node:fs/promises";
import * as path from "node:path";
import { projectSharedStateRoot } from "../../gjc-runtime/session-layout";
import {
	isValidReadinessTimeoutMs,
	lifecycleRequestTimeoutMs,
	READINESS_TIMEOUT_INVALID_MESSAGE,
} from "../broker/startup-budget";
import { AgentDirSessionLifecycleClient } from "./broker-client";
import { type ListRecentSessionsResult, listRecentSessions, type RecentSessionEntry } from "./recent-sessions";
import {
	type SessionCreateOutcome,
	type SessionLifecycleActor,
	SessionLifecycleService,
	type SessionResumeOutcome,
	validateSessionLifecycleMutationRequest,
} from "./service";

export type ExternalSessionCreateTarget =
	| { readonly kind: "existing_path"; readonly path: string }
	| { readonly kind: "worktree"; readonly repo: string; readonly branch: string }
	| { readonly kind: "plain_dir"; readonly path: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const EXTERNAL_SESSION_PREFIX_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

function validExternalSessionCreateTarget(value: unknown): value is ExternalSessionCreateTarget {
	if (!isRecord(value) || typeof value.kind !== "string") return false;
	if (value.kind === "plain_dir" || value.kind === "existing_path")
		return typeof value.path === "string" && value.path.length > 0;
	return (
		value.kind === "worktree" &&
		typeof value.repo === "string" &&
		value.repo.length > 0 &&
		typeof value.branch === "string" &&
		value.branch.length > 0
	);
}

function invalidExternalCreate(message: string): SessionCreateOutcome {
	return {
		ok: false,
		operation: "session.create",
		certainty: "terminal",
		error: { code: "invalid_request", message },
	};
}
const RETRYABLE_PLAIN_DIR_ERRORS = new Set(["EAGAIN", "EINTR", "EMFILE", "ENFILE", "ENOSPC", "EDQUOT"]);
const COMPLETE_RECENT_SESSION_LIMIT = Number.MAX_SAFE_INTEGER;

function plainDirCreateFailure(error: unknown): SessionCreateOutcome {
	const code = isRecord(error) && typeof error.code === "string" ? error.code : "filesystem_error";
	const message = error instanceof Error ? error.message : "Unable to prepare the requested directory.";
	return {
		ok: false,
		operation: "session.create",
		certainty: RETRYABLE_PLAIN_DIR_ERRORS.has(code) ? "retryable" : "terminal",
		error: { code, message },
	};
}

export interface ExternalSessionResumeTarget {
	readonly sessionIdOrPrefix: string;
	readonly path?: string;
}

function validExternalSessionResumeTarget(value: unknown): value is ExternalSessionResumeTarget {
	return (
		isRecord(value) &&
		typeof value.sessionIdOrPrefix === "string" &&
		EXTERNAL_SESSION_PREFIX_PATTERN.test(value.sessionIdOrPrefix) &&
		(value.path === undefined || (typeof value.path === "string" && value.path.length > 0))
	);
}

function invalidExternalResume(message: string): ExternalSessionResumeResult {
	return { kind: "unavailable", message };
}

export type ExternalSessionResumeResult =
	| { readonly kind: "result"; readonly outcome: SessionResumeOutcome }
	| { readonly kind: "not_found" }
	| {
			readonly kind: "ambiguous";
			readonly candidates: readonly { readonly sessionId: string; readonly path?: string }[];
	  }
	| { readonly kind: "unavailable"; readonly message: string };

export class AgentDirSessionLifecycleService extends SessionLifecycleService {
	readonly #agentDir: string;

	constructor(agentDir: string) {
		super(new AgentDirSessionLifecycleClient(agentDir), agentDir);
		this.#agentDir = agentDir;
	}

	async createExternal(request: {
		readonly actor: SessionLifecycleActor;
		readonly capability: "session.create";
		readonly requestKey: string;
		readonly target: ExternalSessionCreateTarget;
		readonly modelPreset?: string;
		readonly readinessTimeoutMs?: number;
	}): Promise<SessionCreateOutcome> {
		const rawRequest: Record<string, unknown> = isRecord(request) ? request : {};
		const targetInput = rawRequest.target;
		if (!validExternalSessionCreateTarget(targetInput))
			return invalidExternalCreate("target must be a valid external create target");
		const modelPreset = rawRequest.modelPreset;
		if (modelPreset !== undefined && typeof modelPreset !== "string")
			return invalidExternalCreate("modelPreset must be a string");
		const readinessTimeoutMs = rawRequest.readinessTimeoutMs;
		if (readinessTimeoutMs !== undefined && !isValidReadinessTimeoutMs(readinessTimeoutMs))
			return invalidExternalCreate(READINESS_TIMEOUT_INVALID_MESSAGE);

		const requestedCwd = targetInput.kind === "worktree" ? targetInput.repo : targetInput.path;
		const cwd = path.resolve(requestedCwd);
		const target = {
			cwd,
			stateRoot: projectSharedStateRoot(cwd, this.#agentDir),
			...(targetInput.kind === "worktree" ? { worktree: { enabled: true as const, name: targetInput.branch } } : {}),
			...(modelPreset === undefined ? {} : { modelPreset }),
			...(readinessTimeoutMs === undefined ? {} : { readinessTimeoutMs }),
		};
		const validation = validateSessionLifecycleMutationRequest({
			operation: "session.create",
			actor: rawRequest.actor,
			capability: rawRequest.capability,
			requestKey: rawRequest.requestKey,
			target,
		});
		if (!validation.ok) return validation as SessionCreateOutcome;
		if (targetInput.kind === "plain_dir") {
			try {
				await fs.mkdir(cwd, { recursive: true });
			} catch (error) {
				return plainDirCreateFailure(error);
			}
		}
		return await this.create({
			actor: validation.actor,
			capability: "session.create",
			requestKey: validation.requestKey,
			target,
			timeoutMs: lifecycleRequestTimeoutMs("session.create", target),
		});
	}

	listRecent(input: {
		readonly cwd: string;
		readonly limit?: number;
		readonly includeInternal?: boolean;
		readonly allWorkspaces?: boolean;
	}): Promise<ListRecentSessionsResult> {
		return listRecentSessions({ ...input, agentDir: this.#agentDir });
	}

	async resumeExternal(request: {
		readonly actor: SessionLifecycleActor;
		readonly capability: "session.resume";
		readonly requestKey: string;
		readonly target: ExternalSessionResumeTarget;
		readonly modelPreset?: string;
		readonly readinessTimeoutMs?: number;
	}): Promise<ExternalSessionResumeResult> {
		const rawRequest: Record<string, unknown> = isRecord(request) ? request : {};
		const targetInput = rawRequest.target;
		if (!validExternalSessionResumeTarget(targetInput))
			return invalidExternalResume("resume target requires a safe session id or prefix");
		const readinessTimeoutMs = rawRequest.readinessTimeoutMs;
		if (readinessTimeoutMs !== undefined && !isValidReadinessTimeoutMs(readinessTimeoutMs))
			return invalidExternalResume(READINESS_TIMEOUT_INVALID_MESSAGE);
		const requestedCwd = targetInput.path === undefined ? undefined : path.resolve(targetInput.path);
		const validation = validateSessionLifecycleMutationRequest({
			operation: "session.resume",
			actor: rawRequest.actor,
			capability: rawRequest.capability,
			requestKey: rawRequest.requestKey,
			target: {
				sessionId: targetInput.sessionIdOrPrefix,
				...(requestedCwd === undefined ? {} : { cwd: requestedCwd }),
			},
		});
		if (!validation.ok) return invalidExternalResume(validation.error.message);
		const recent = await this.listRecent({
			cwd: requestedCwd ?? this.#agentDir,
			allWorkspaces: requestedCwd === undefined,
			limit: COMPLETE_RECENT_SESSION_LIMIT,
			includeInternal: false,
		});
		if (recent.kind === "error") return { kind: "unavailable", message: recent.message };
		const prefixed = recent.entries.filter(
			entry =>
				entry.sessionId === targetInput.sessionIdOrPrefix ||
				entry.sessionId.startsWith(targetInput.sessionIdOrPrefix),
		);
		const exact = prefixed.filter(entry => entry.sessionId === targetInput.sessionIdOrPrefix);
		const resolved: RecentSessionEntry[] = exact.length > 0 ? exact : prefixed;
		if (resolved.length === 0) return { kind: "not_found" };
		if (resolved.length > 1)
			return {
				kind: "ambiguous",
				candidates: resolved.map(entry => ({
					sessionId: entry.sessionId,
					...(entry.path === undefined ? {} : { path: entry.path }),
				})),
			};
		const selected = resolved[0]!;
		if (!selected.path) return { kind: "unavailable", message: "Saved session workspace is unavailable." };
		const selectedCwd = path.resolve(selected.path);
		const target = {
			sessionId: selected.sessionId,
			cwd: selectedCwd,
			stateRoot: projectSharedStateRoot(selectedCwd, this.#agentDir),
			sessionPath: selected.sessionStateFile,
			...(request.modelPreset === undefined ? {} : { modelPreset: request.modelPreset }),
			...(readinessTimeoutMs === undefined ? {} : { readinessTimeoutMs }),
		};
		const outcome = await this.resume({
			actor: validation.actor,
			capability: "session.resume",
			requestKey: validation.requestKey,
			target,
			timeoutMs: lifecycleRequestTimeoutMs("session.resume", target),
		});
		return { kind: "result", outcome };
	}
}

export function createSessionLifecycleService(agentDir: string): AgentDirSessionLifecycleService {
	return new AgentDirSessionLifecycleService(agentDir);
}
