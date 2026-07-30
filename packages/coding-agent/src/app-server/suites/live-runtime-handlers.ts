// app-server live-runtime lane: methods that act on threads currently loaded in memory.
//
// These are the only suite methods that need the runtime rather than the persisted session
// store, so they read `HandlerContext.manager` / `HandlerContext.turnController`, which the
// server supplies for every registry-dispatched request.

import type { HandlerResult, MethodHandler } from "./handlers";

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

/**
 * `thread/loaded/list` reports the ids of threads held in memory. Without a runtime on the
 * context there is nothing to read, and an empty list would falsely claim nothing is loaded.
 */
export const threadLoadedListHandler: MethodHandler = (params, context) => {
	if (params !== undefined && params !== null && !isRecord(params)) return invalidParams();
	const manager = context?.manager;
	if (!manager) return internalError();
	return { ok: true, result: { data: manager.loaded().map(thread => thread.threadId), nextCursor: null } };
};

/**
 * `thread/unsubscribe` distinguishes the three pinned outcomes honestly: a thread that is not
 * loaded, a loaded thread this connection was not receiving notifications for, and a real
 * unsubscribe.
 */
export const threadUnsubscribeHandler: MethodHandler = async (params, context) => {
	if (!isRecord(params) || typeof params.threadId !== "string" || params.threadId.length === 0) return invalidParams();
	const manager = context?.manager;
	if (!manager) return internalError();
	if (!manager.get(params.threadId)) return { ok: true, result: { status: "notLoaded" } };
	if (!context?.unsubscribe) return { ok: true, result: { status: "notSubscribed" } };
	try {
		await context.unsubscribe(params.threadId);
	} catch {
		return internalError();
	}
	return { ok: true, result: { status: "unsubscribed" } };
};

/** Only `text` user input can be carried to the child's `turn.steer` control operation. */
function steerText(input: unknown): string | undefined {
	if (!Array.isArray(input) || input.length === 0) return undefined;
	const parts: string[] = [];
	for (const entry of input) {
		// Image, audio, skill and mention inputs have no representation in `turn.steer`, so a
		// request carrying them is refused instead of being silently reduced to its text.
		if (!isRecord(entry) || entry.type !== "text" || typeof entry.text !== "string") return undefined;
		parts.push(entry.text);
	}
	const text = parts.join("\n").trim();
	return text.length > 0 ? text : undefined;
}

export const turnInterruptHandler: MethodHandler = async (params, context) => {
	if (
		!isRecord(params) ||
		typeof params.threadId !== "string" ||
		typeof params.turnId !== "string" ||
		params.threadId.length === 0 ||
		params.turnId.length === 0
	)
		return invalidParams();
	const controller = context?.turnController;
	if (!controller) return internalError();
	if (!context?.manager?.get(params.threadId)) return notFound();
	if (controller.activeTurnId(params.threadId) !== params.turnId) return notFound();
	try {
		await controller.interruptTurn(params.threadId, params.turnId);
	} catch {
		return internalError();
	}
	return { ok: true, result: {} };
};

export const turnSteerHandler: MethodHandler = async (params, context) => {
	if (
		!isRecord(params) ||
		typeof params.threadId !== "string" ||
		typeof params.expectedTurnId !== "string" ||
		params.threadId.length === 0 ||
		params.expectedTurnId.length === 0
	)
		return invalidParams();
	const text = steerText(params.input);
	if (text === undefined) return invalidParams();
	const controller = context?.turnController;
	if (!controller) return internalError();
	if (!context?.manager?.get(params.threadId)) return notFound();
	// The precondition is checked before any control call so a stale id never steers another turn.
	if (controller.activeTurnId(params.threadId) !== params.expectedTurnId) return { ok: false, errorKey: "conflict" };
	try {
		const turnId = await controller.steerTurn(params.threadId, params.expectedTurnId, text);
		return { ok: true, result: { turnId } };
	} catch {
		return internalError();
	}
};

export const liveRuntimeHandlers: Record<string, MethodHandler> = {
	"thread/loaded/list": threadLoadedListHandler,
	"thread/unsubscribe": threadUnsubscribeHandler,
	"turn/interrupt": turnInterruptHandler,
	"turn/steer": turnSteerHandler,
};
