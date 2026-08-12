/**
 * Autoresearch mission `python` tool: the model-facing research execution tool.
 * Two construction paths share one implementation:
 * - `createMissionPythonTool` (src/autoresearch/session.ts) binds the tool to a
 *   fixed persisted mission (runtime capability + tests).
 * - `createAutoresearchSessionPythonTool` (below) is the discoverable builtin
 *   wired through `BUILTIN_TOOL_DESCRIPTORS`: the loader only receives the
 *   session, so the tool resolves the ACTIVE mission per call from
 *   `.gjc/_session-{id}/autoresearch/` and fails closed when none exists.
 * Wraps the shared persistent Python kernel executor, records every execute
 * call as a notebook cell, and carries a clear-kernel action on the same tool
 * (AC-19/AC-20 — no separate teardown tool exists).
 */
import type { AgentTool, AgentToolResult } from "@gajae-code/agent-core";
import { type Static, z } from "@gajae-code/ai/core";
import { disposeKernelSessionsByOwner, executePython } from "../eval/py/executor";
import { RLM_MANAGED_PYTHON_PACKAGES } from "../eval/py/runtime";
import type { ToolDefinition } from "../extensibility/extensions/types";
import { applyToolProxy } from "../extensibility/tool-proxy";
import type { RlmNotebookWriter } from "../rlm/notebook";
import type { RlmCellResult } from "../rlm/types";

export const AUTORESEARCH_PYTHON_TOOL_NAME = "python";

/**
 * Kernel owner/session id for a mission. Distinct from the session's
 * `#evalKernelOwnerId` (spec f33) so mission kernels are reaped by the
 * mission-owned disposer, never by the eval-owner disposals.
 */
export function autoresearchKernelOwnerId(missionId: string): string {
	return `autoresearch:${missionId}`;
}

/** Per-call mission execution context resolved by the tool before every call. */
export interface AutoresearchPythonToolMissionContext {
	/** Mission id (slug) used as the kernel owner suffix. */
	missionId: string;
	/** Effective artifacts directory for kernel execution. */
	artifactsDir: string;
	/** Live notebook writer that records every executed cell. */
	notebook: RlmNotebookWriter;
}

export interface AutoresearchPythonToolContext {
	/** Working directory for kernel execution. */
	cwd: string;
	/** Effective artifacts directory for kernel execution (mission-bound path). */
	artifactsDir?: string;
	/** Live notebook writer that records every executed cell (mission-bound path). */
	notebook?: RlmNotebookWriter;
	/**
	 * Reads the currently-active mission id from persisted mission state
	 * (mission-bound path). Missions are minted at runtime (handoff/cold
	 * intake) and can be cleared and re-created within one session, so the id
	 * is never known at session construction — resolve it per call. Returns
	 * null when no mission is active, in which case the tool refuses to
	 * execute.
	 */
	getMissionId?: () => string | null | Promise<string | null>;
	/**
	 * Per-call mission context resolver used by the discoverable builtin
	 * wiring, where the loader only has the session and the active mission is
	 * unknown at construction. When present, supersedes `getMissionId` /
	 * `artifactsDir` / `notebook`: the full execution context is resolved per
	 * call from persisted mission state. Returns null when no mission is
	 * active, in which case the tool refuses to execute.
	 */
	getMissionContext?: () =>
		| AutoresearchPythonToolMissionContext
		| null
		| Promise<AutoresearchPythonToolMissionContext | null>;
	/**
	 * Registers a cleanup with the session disposal path
	 * (`AgentSession.registerToolSessionCleanup`). Graceful dispose and the
	 * signal-exit path both drain these registrations, reaping the mission
	 * kernel subprocess (AC-21).
	 */
	registerSessionCleanup: (cleanup: () => Promise<void> | void) => void;
	/** Provision a managed workspace venv seeded with research packages. */
	managedWorkspaceVenv?: boolean;
}

const paramsSchema = z.object({
	action: z
		.enum(["execute", "clear"])
		.default("execute")
		.describe(
			'"execute" runs `code` in the persistent mission kernel and is the default. "clear" disposes the mission kernel and frees its subprocess; the next execute starts a fresh kernel.',
		),
	code: z
		.string()
		.optional()
		.describe('Python source to execute when action is "execute" (required then, ignored for "clear").'),
});

/**
 * Fail-closed message returned when no autoresearch mission is active: the
 * mission kernel must never be created ad hoc, and the caller is told how to
 * start a mission instead.
 */
export const AUTORESEARCH_PYTHON_TOOL_NO_MISSION_ERROR =
	"No active autoresearch mission — start one with `gjc autoresearch` before using the mission Python kernel.";

async function resolveMissionContext(
	context: AutoresearchPythonToolContext,
): Promise<AutoresearchPythonToolMissionContext | null> {
	if (context.getMissionContext) {
		return await context.getMissionContext();
	}
	const missionId = (await context.getMissionId?.()) ?? null;
	if (missionId === null) return null;
	if (context.artifactsDir === undefined || context.notebook === undefined) {
		throw new Error(
			"AutoresearchPythonTool requires getMissionContext, or getMissionId together with artifactsDir and notebook.",
		);
	}
	return {
		missionId,
		artifactsDir: context.artifactsDir,
		notebook: context.notebook,
	};
}

export function createAutoresearchPythonTool(
	context: AutoresearchPythonToolContext,
): ToolDefinition<typeof paramsSchema> {
	const seenOwnerIds = new Set<string>();

	// Reap every mission owner that ever touched the kernel when the session
	// tears down. `disposeKernelSessionsByOwner` is idempotent, so owners
	// already cleared via the clear action are a no-op, and a clear followed by
	// session exit is not a double free.
	context.registerSessionCleanup(async () => {
		await Promise.all([...seenOwnerIds].map(ownerId => disposeKernelSessionsByOwner(ownerId)));
	});

	return {
		name: AUTORESEARCH_PYTHON_TOOL_NAME,
		label: "Python",
		description:
			'Execute Python in the persistent mission kernel. Variables, imports, and loaded data persist across calls like notebook cells; every call is recorded as a cell in the mission notebook. Use action "clear" to dispose the kernel subprocess when the mission is done.',
		parameters: paramsSchema,
		defaultInactive: true,
		concurrency: "exclusive",
		async execute(
			_toolCallId: string,
			params: Static<typeof paramsSchema>,
			signal?: AbortSignal,
		): Promise<AgentToolResult> {
			const missionContext = await resolveMissionContext(context);
			if (missionContext === null) {
				return {
					content: [{ type: "text", text: AUTORESEARCH_PYTHON_TOOL_NO_MISSION_ERROR }],
					isError: true,
				};
			}
			const ownerId = autoresearchKernelOwnerId(missionContext.missionId);
			seenOwnerIds.add(ownerId);
			if (params.action === "clear") {
				await disposeKernelSessionsByOwner(ownerId);
				return {
					content: [
						{
							type: "text",
							text: "Mission Python kernel cleared; the next execute starts a fresh kernel.",
						},
					],
				};
			}
			const code = params.code;
			if (code === undefined) {
				return {
					content: [{ type: "text", text: 'Missing required "code" parameter for action "execute".' }],
					isError: true,
				};
			}
			const result = await executePython(code, {
				cwd: context.cwd,
				kernelMode: "session",
				sessionId: ownerId,
				kernelOwnerId: ownerId,
				artifactsDir: missionContext.artifactsDir,
				runtimeOptions: context.managedWorkspaceVenv
					? { managedWorkspaceVenv: true, seedPackages: RLM_MANAGED_PYTHON_PACKAGES }
					: undefined,
				signal,
			});
			const cell: RlmCellResult = {
				output: result.output,
				exitCode: result.exitCode,
				cancelled: result.cancelled,
				truncated: result.truncated,
				displayOutputs: result.displayOutputs,
			};
			await missionContext.notebook.appendCode(code, cell);
			const text = result.output.length > 0 ? result.output : "(no output)";
			return { content: [{ type: "text", text }] };
		},
	};
}

export interface AutoresearchSessionPythonToolInput {
	/** Working directory for kernel execution (session cwd). */
	cwd: string;
	/** Resolve the session id used to locate `.gjc/_session-{id}/autoresearch/`. */
	getSessionId: () => string | null;
	/**
	 * Registers a cleanup with the session disposal path
	 * (`AgentSession.registerToolSessionCleanup`), reaping the mission kernel
	 * subprocess on graceful dispose and signal exit (AC-21).
	 */
	registerSessionCleanup: (cleanup: () => Promise<void> | void) => void;
	/** Provision a managed workspace venv seeded with research packages. */
	managedWorkspaceVenv?: boolean;
}

/**
 * Build the discoverable builtin `python` tool for a live agent session. The
 * active mission is resolved per call through the session-scoped autoresearch
 * runtime readers, so the tool never creates a mission and never falls back to
 * a session-scoped or ad-hoc kernel: with no active mission it returns a
 * fail-closed error telling the caller to run `gjc autoresearch`. The kernel
 * owner stays `autoresearch:<mission-id>`, distinct from the session's eval
 * owner (spec f33 / AC-19).
 */
export function createAutoresearchSessionPythonTool(input: AutoresearchSessionPythonToolInput): AgentTool {
	const definition = createAutoresearchPythonTool({
		cwd: input.cwd,
		getMissionContext: async () => {
			const [{ autoresearchRead }, { openMissionNotebook, missionArtifactsDir }] = await Promise.all([
				import("../gjc-runtime/autoresearch-runtime"),
				import("./session"),
			]);
			const receipt = await autoresearchRead(input.cwd, input.getSessionId());
			if (!receipt.exists || !receipt.mission) return null;
			const { writer } = await openMissionNotebook(input.cwd, receipt.mission);
			return {
				missionId: receipt.mission.slug,
				artifactsDir: missionArtifactsDir(input.cwd, receipt.mission),
				notebook: writer,
			};
		},
		registerSessionCleanup: input.registerSessionCleanup,
		managedWorkspaceVenv: input.managedWorkspaceVenv,
	});
	const agentTool = {
		async execute(
			toolCallId: string,
			params: Static<typeof paramsSchema>,
			signal?: AbortSignal,
		): Promise<AgentToolResult> {
			return definition.execute(toolCallId, params, signal, undefined, undefined as never);
		},
	} as AgentTool;
	applyToolProxy(definition, agentTool);
	return agentTool;
}
