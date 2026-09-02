import type { ExtensionContext } from "../../extensibility/extensions";
import { OPERATIONS } from "../protocol/operation-registry";
export function hasSdkWorkflowGateCapability(workflowGate: unknown): boolean {
	if (!workflowGate || typeof workflowGate !== "object") return false;
	const candidate = workflowGate as Record<string, unknown>;
	return [
		"resolveGate",
		"recoverAcceptedGates",
		"lookupCompletedResolution",
		"prepareTerminalization",
		"clearPreparedTerminalization",
		"registerGateTerminalController",
	].every(name => typeof candidate[name] === "function");
}

const UNINSTALLED_CONTROL_OPERATIONS = new Set(["auth.login", "host_tools.register", "host_uri.register"]);
/** Advertised only when the context carries a real durable workflow-gate bridge. */
const WORKFLOW_GATE_CONTROL_OPERATIONS = new Set(["workflow.gate_answer", "workflow.plan_approve"]);
/** Lifecycle mutations are Broker-owned and never advertised on generic session controls. */
const BROKER_LIFECYCLE_CONTROL_OPERATIONS = new Set([
	"session.new",
	"session.fork",
	"session.resume",
	"session.switch",
	"session.branch",
	"session.handoff",
	"session.close",
	"session.delete",
]);

const CONTROL_BINDINGS: Readonly<Record<string, string | undefined>> = {
	"model.cycle": "cycleModel",
	"model.profile.set": "setModelProfile",
	"thinking.cycle": "cycleThinkingLevel",
	"queue.steering_mode.set": "setQueueMode",
	"queue.follow_up_mode.set": "setQueueMode",
	"queue.tool_interrupt_policy.set": "setQueueMode",
	"todo.replace": "sdkControl",
	"permission_mode.set": "sdkControl",
	"skill.invoke": "invokeSkill",
	"mode.plan.set": "setPlanMode",
	"mode.goal.operate": "operateGoal",
	"compaction.auto.set": "sdkControl",
	"retry.auto.set": "sdkControl",
	"retry.abort": "sdkControl",
	"bash.execute": "sdkControl",
	"bash.abort": "sdkControl",
	"session.rename": "sdkControl",
	"session.export_html": "sdkControl",
	"runtime.reload": "sdkControl",
	"service_tier.set": "sdkControl",
	"queue.message.remove": "sdkControl",
	"queue.message.move": "sdkControl",
	"queue.message.update": "sdkControl",
	"extension.set_enabled": "sdkControl",
	"session.cwd.move": "sdkControl",
	"retry.last": "sdkControl",
	"retry.now": "sdkControl",
	"bash.background": "sdkControl",
};

// Resource queries (`artifact.read`, `runtime.jobs.list`) remain dispatchable when their
// backing session resource is absent so their handlers can return `resource_gone`.
// `session.checkpoint` (Q30) is likewise unconditionally installed: it is an SDK-native
// replay authority whose handler returns explicit `unavailable` when the host cannot
// provide one atomic transcript/ring/idle capture, so it must never be hidden behind a binding gate.
const QUERY_BINDINGS: Readonly<Record<string, string | undefined>> = {
	"skill.list/state": "getSkillState",
	"config.list/get": "getConfigItems",
	"session.branch_candidates": "getBranchCandidates",
	"extensions.list": "getExtensions",
};

export interface SdkSurfacePolicy {
	readonly installedControls: ReadonlySet<string>;
	readonly installedQueries: ReadonlySet<string>;
}

export interface SdkSurfacePolicyOptions {
	bindings: Iterable<string>;
	workflowGateAvailable: boolean;
	isBindingInstalled?: (binding: string) => boolean;
}

/** Shared operation advertisement policy for every SDK transport. */
export function createSdkSurfacePolicy(options: SdkSurfacePolicyOptions): SdkSurfacePolicy {
	const bindings = new Set(options.bindings);
	const hasBinding = (binding: string): boolean =>
		bindings.has(binding) && (options.isBindingInstalled?.(binding) ?? true);
	const installed = (kind: "control" | "query"): ReadonlySet<string> => {
		const required = kind === "control" ? CONTROL_BINDINGS : QUERY_BINDINGS;
		return new Set(
			OPERATIONS.filter(
				operation =>
					operation.kind === kind &&
					!BROKER_LIFECYCLE_CONTROL_OPERATIONS.has(operation.sdkId) &&
					!UNINSTALLED_CONTROL_OPERATIONS.has(operation.sdkId) &&
					(!WORKFLOW_GATE_CONTROL_OPERATIONS.has(operation.sdkId) || options.workflowGateAvailable) &&
					(!required[operation.sdkId] || hasBinding(required[operation.sdkId]!)),
			).map(operation => operation.sdkId),
		);
	};
	return { installedControls: installed("control"), installedQueries: installed("query") };
}

export interface SdkCapabilities {
	operations: string[];
	hostTools: boolean;
	promptTerminalOutcomeVersion: 1;
}

export function createSdkCapabilities(policy: SdkSurfacePolicy, hostTools = false): SdkCapabilities {
	return {
		operations: [...policy.installedControls, ...policy.installedQueries],
		hostTools,
		promptTerminalOutcomeVersion: 1,
	};
}

/** Derive the shared policy from an extension context without importing adapters. */
export function createSdkSurfacePolicyForContext(
	ctx: ExtensionContext,
	workflowGateAvailable = false,
): SdkSurfacePolicy {
	const bindings = ctx.sdkBindings?.() ?? [];
	return createSdkSurfacePolicy({
		bindings,
		workflowGateAvailable,
		isBindingInstalled: binding => typeof (ctx as unknown as Record<string, unknown>)[binding] === "function",
	});
}
