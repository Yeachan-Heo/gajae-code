import type { ThinkingLevel } from "@gajae-code/agent-core";
import {
	getMiniMaxThinkingMode,
	getSupportedEfforts,
	type Model,
	modelSupportsReasoningControl,
	THINKING_CONTROL_MODES,
	THINKING_EFFORTS,
} from "@gajae-code/ai/core";
import type { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { getThinkingLevelMetadata, parseThinkingLevel } from "@gajae-code/coding-agent/thinking";
import type { DesktopModel, DesktopThinking, DesktopThinkingMode, DesktopThinkingOption } from "./protocol";

type SdkThinkingMode = (typeof THINKING_CONTROL_MODES)[number];
type DesktopSdkThinkingMode = Exclude<DesktopThinkingMode, "toggle" | "always-on">;
type _DesktopThinkingModeParity = [
	Exclude<SdkThinkingMode, DesktopSdkThinkingMode>,
	Exclude<DesktopSdkThinkingMode, SdkThinkingMode>,
] extends [never, never]
	? true
	: false;
true satisfies _DesktopThinkingModeParity;

interface ModelThinking {
	options: DesktopThinkingOption[];
	mode?: DesktopThinkingMode;
	reason?: string;
}

/** Use the public transport-aware capability APIs, including native toggle/always-on semantics. */
function modelThinking(model: Model): ModelThinking {
	const nativeMode = getMiniMaxThinkingMode(model);
	if (nativeMode === "always-on")
		return { options: [], mode: nativeMode, reason: "Reasoning is always on; effort control is unsupported." };
	if (!modelSupportsReasoningControl(model))
		return { options: [], reason: "This model does not support reasoning controls." };
	try {
		const supported = getSupportedEfforts(model);
		if (
			!model.thinking ||
			!THINKING_CONTROL_MODES.includes(model.thinking.mode) ||
			supported.length === 0 ||
			supported.some(level => !THINKING_EFFORTS.includes(level))
		)
			throw new Error("Invalid thinking metadata");
		// Canonical order, retaining discrete memberships (not an invented continuous range).
		const levels = THINKING_EFFORTS.filter(level => supported.includes(level));
		return {
			options: ["off" as const, ...levels].map(level => ({ ...getThinkingLevelMetadata(level, model) })),
			mode: nativeMode ?? model.thinking.mode,
		};
	} catch {
		return { options: [], reason: "Reasoning capability metadata is unavailable." };
	}
}

export function projectDesktopModel(model: Model): DesktopModel {
	const thinking = modelThinking(model);
	return {
		id: `${model.provider}/${model.id}`,
		name: model.name,
		provider: model.provider,
		contextWindow: model.contextWindow,
		reasoning: model.reasoning,
		thinking: { options: thinking.options, ...(thinking.mode ? { mode: thinking.mode } : {}) },
	};
}

export function projectDesktopThinking(session?: AgentSession): DesktopThinking {
	if (!session?.model)
		return {
			level: null,
			options: [],
			scope: null,
			available: false,
			reason: session ? "No model is selected." : "Open the session to read reasoning controls.",
		};
	const thinking = modelThinking(session.model);
	return {
		level: session.thinkingLevel ?? null,
		// The resolved level is what the session will use, so `inherit` would be a second name
		// for the value already shown. Only concrete levels are selectable here.
		options: thinking.options,
		scope: session.getThinkingScopeForControl(),
		available: thinking.options.length > 0,
		...(thinking.mode ? { mode: thinking.mode } : {}),
		...(thinking.reason ? { reason: thinking.reason } : {}),
	};
}

function requestedLevel(value: unknown): ThinkingLevel {
	const level = typeof value === "string" ? parseThinkingLevel(value) : undefined;
	if (level === undefined) throw new Error("Invalid thinking level");
	return level;
}

/** Validate before calling SDK setters, which intentionally clamp low-level requests. */
export function validateSessionThinking(session: AgentSession, value: unknown): ThinkingLevel {
	const level = requestedLevel(value);
	const thinking = projectDesktopThinking(session);
	if (!thinking.available) throw new Error(thinking.reason);
	if (!thinking.options.some(option => option.value === level)) throw new Error("Unsupported thinking level");
	return level;
}

export function validateModelThinking(model: Model, value: unknown): ThinkingLevel {
	const level = requestedLevel(value);
	// A concrete non-reasoning selection can explicitly record off, but an
	// always-on model must never advertise or accept a disabling selection.
	if (level === "off" && !model.reasoning) return level;
	if (!modelThinking(model).options.some(option => option.value === level))
		throw new Error("Unsupported thinking level for selected model");
	return level;
}
