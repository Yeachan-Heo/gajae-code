// app-server thread-session-ops lane: live operations backed by a retained SessionClient.
//
// This lane deliberately registers only operations with an honest child-session seam. Persisted
// settings, transcript injection, and background-terminal lifecycle methods have no equivalent
// operation reachable from HandlerContext and remain omitted rather than being emulated.
// Omitted methods: `thread/inject_items` has no transcript-append/queue operation; `thread/settings/update`
// has no live-session settings operation; and `thread/backgroundTerminals/list`, `/terminate`, and
// `/clean` have no retained-client query/control or manager registry for the child-managed jobs.

import type { SessionClient } from "../thread-runtime/child-bridge";
import type { HandlerContext, HandlerResult, MethodHandler } from "./handlers";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidParams(): HandlerResult {
	return { ok: false, errorKey: "invalidParams" };
}

function notFound(): HandlerResult {
	return { ok: false, errorKey: "notFound" };
}

function internalError(): HandlerResult {
	return { ok: false, errorKey: "internalError" };
}

function liveClient(threadId: string, context: HandlerContext | undefined): { client: SessionClient } | HandlerResult {
	const manager = context?.manager;
	if (!manager) return internalError();
	const thread = manager.get(threadId);
	if (!thread) return notFound();
	if (!thread.client) return internalError();
	return { client: thread.client };
}

/** A child control response can reject without throwing; never turn that into a false success. */
function rejectedControlResponse(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (value.ok === false || value.accepted === false || value.started === false) return true;
	if (value.status === "failed" || value.status === "rejected" || value.status === "error") return true;
	if (value.error !== undefined) return true;
	return isRecord(value.result) && rejectedControlResponse(value.result);
}

async function runControl(
	threadId: string,
	operation: "compaction.run" | "bash.execute",
	input: Record<string, unknown>,
	context: HandlerContext | undefined,
): Promise<HandlerResult> {
	const resolved = liveClient(threadId, context);
	if ("ok" in resolved) return resolved;
	try {
		const response = await resolved.client.control(operation, input);
		if (rejectedControlResponse(response)) return internalError();
		return { ok: true, result: {} };
	} catch {
		return internalError();
	}
}

/** `thread/compact/start` maps directly to the retained session's real compaction operation. */
export const threadCompactStartHandler: MethodHandler = async (params, context) => {
	if (!isRecord(params) || typeof params.threadId !== "string" || params.threadId.length === 0) return invalidParams();
	return runControl(params.threadId, "compaction.run", {}, context);
};

/** `thread/shellCommand` maps the pinned command field to managed bash's `cmd` input. */
export const threadShellCommandHandler: MethodHandler = async (params, context) => {
	if (
		!isRecord(params) ||
		typeof params.threadId !== "string" ||
		params.threadId.length === 0 ||
		typeof params.command !== "string" ||
		params.command.trim().length === 0
	)
		return invalidParams();
	return runControl(params.threadId, "bash.execute", { cmd: params.command }, context);
};

/** Only methods with a retained-child operation seam are registered in this lane. */
export const threadSessionOpsHandlers: Record<string, MethodHandler> = {
	"thread/compact/start": threadCompactStartHandler,
	"thread/shellCommand": threadShellCommandHandler,
};
