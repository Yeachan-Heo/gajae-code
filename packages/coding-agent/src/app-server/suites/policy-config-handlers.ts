import { getAgentDir } from "@gajae-code/utils";
import { type ModelSelectorValue, selectorHead } from "../../config/model-selector-value";
import { type SettingPath, Settings } from "../../config/settings";
import { resolveMemoryBackend } from "../../memory-backend";
import type { HandlerResult, MethodHandler } from "./handlers";

type RecordValue = Record<string, unknown>;

type CollaborationModeMask = {
	name: string;
	mode: "default" | "plan";
	model: string | null;
	reasoning_effort: string | null;
};

/**
 * GJC's experimental feature surface is intentionally small and explicit.
 * Each wire key is a real boolean SettingPath, rather than a compatibility
 * alias that would silently do nothing.
 */
export const EXPERIMENTAL_FEATURE_SETTINGS: Readonly<Record<string, SettingPath>> = Object.freeze({
	"contextPromotion.enabled": "contextPromotion.enabled",
	"tools.preAdmissionArtifactSpill": "tools.preAdmissionArtifactSpill",
});

const REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

function invalidParams(): HandlerResult {
	return { ok: false, errorKey: "invalidParams" };
}

function internalError(): HandlerResult {
	return { ok: false, errorKey: "internalError" };
}

function notSupported(): HandlerResult {
	return { ok: false, errorKey: "notSupported" };
}

function isRecord(value: unknown): value is RecordValue {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Option<()> accepts absent/null/empty-object params, but no payload fields. */
function hasEmptyParams(params: unknown): boolean {
	return params === undefined || params === null || (isRecord(params) && Object.keys(params).length === 0);
}

function resolveAgentDirectory(): string {
	const configured =
		process.env.GJC_AGENT_DIR ?? process.env.GJC_CODING_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR ?? undefined;
	return configured ? configured : getAgentDir();
}

function selectorEffort(selector: string | null | undefined): string | null {
	if (!selector) return null;
	const separator = selector.lastIndexOf(":");
	if (separator < 0) return null;
	const effort = selector.slice(separator + 1);
	return REASONING_EFFORTS.has(effort) ? effort : null;
}

function modelRoleSelector(roles: Record<string, ModelSelectorValue>, role: string): string | null {
	return selectorHead(roles[role]) ?? null;
}

/**
 * Project the two modes that GJC actually exposes: the normal mode and plan
 * mode when its real settings gate is enabled. Goal mode is deliberately not
 * projected because the pinned collaboration-mode union has no goal variant.
 */
export const collaborationModeListHandler: MethodHandler = async params => {
	if (!hasEmptyParams(params)) return invalidParams();
	try {
		const settings = await Settings.loadForScope({ cwd: process.cwd(), agentDir: resolveAgentDirectory() });
		const roles = settings.get("modelRoles") as Record<string, ModelSelectorValue>;
		const defaultSelector = modelRoleSelector(roles, "default");
		const modes: CollaborationModeMask[] = [
			{
				name: "default",
				mode: "default",
				model: defaultSelector,
				reasoning_effort: selectorEffort(defaultSelector),
			},
		];
		if (settings.get("plan.enabled")) {
			const planSelector = modelRoleSelector(roles, "planner");
			modes.push({
				name: "plan",
				mode: "plan",
				model: planSelector,
				reasoning_effort: selectorEffort(planSelector),
			});
		}
		return { ok: true, result: { data: modes } };
	} catch {
		return internalError();
	}
};

/** Returns the validated enablement map, or undefined when the pinned params are malformed. */
function parseEnablement(params: unknown): Record<string, boolean> | undefined {
	if (!isRecord(params) || Object.keys(params).length !== 1 || !Object.hasOwn(params, "enablement")) return undefined;
	if (!isRecord(params.enablement)) return undefined;
	const enablement: Record<string, boolean> = {};
	for (const [key, value] of Object.entries(params.enablement)) {
		if (!Object.hasOwn(EXPERIMENTAL_FEATURE_SETTINGS, key) || typeof value !== "boolean") return undefined;
		enablement[key] = value;
	}
	return enablement;
}

/** Persist GJC-native experimental booleans through Settings' atomic writer. */
export const experimentalFeatureEnablementSetHandler: MethodHandler = async params => {
	const parsed = parseEnablement(params);
	if (!parsed) return invalidParams();
	try {
		const settings = await Settings.loadForScope({ cwd: process.cwd(), agentDir: resolveAgentDirectory() });
		const entries = Object.entries(parsed);
		if (entries.length === 0) return { ok: true, result: { enablement: {} } };
		await settings.commitAtomicBatch(
			entries.map(([key, enabled]) => ({
				path: EXPERIMENTAL_FEATURE_SETTINGS[key]!,
				op: "set" as const,
				value: enabled,
			})),
		);
		const enablement = Object.fromEntries(
			entries.map(([key]) => [key, settings.get(EXPERIMENTAL_FEATURE_SETTINGS[key]!)]),
		);
		return { ok: true, result: { enablement } };
	} catch {
		return internalError();
	}
};

/**
 * Reset the active local memory backend. Hindsight's authoritative state is
 * server-side and the off backend has no state to reset, so both are refused
 * rather than reported as successful no-ops.
 */
export const memoryResetHandler: MethodHandler = async params => {
	if (!hasEmptyParams(params)) return invalidParams();
	const agentDir = resolveAgentDirectory();
	try {
		const settings = await Settings.loadForScope({ cwd: process.cwd(), agentDir });
		const backend = resolveMemoryBackend(settings);
		if (backend.id !== "local") return notSupported();
		await backend.clear(agentDir, process.cwd());
		return { ok: true, result: {} };
	} catch {
		return internalError();
	}
};

/**
 * GJC has no managed requirements.toml/MDM or permission-profile settings
 * subsystem. Those Codex methods are intentionally omitted instead of being
 * represented by fabricated empty payloads.
 */
export const policyConfigHandlers: Record<string, MethodHandler> = {
	"collaborationMode/list": collaborationModeListHandler,
	"experimentalFeature/enablement/set": experimentalFeatureEnablementSetHandler,
	"memory/reset": memoryResetHandler,
};
