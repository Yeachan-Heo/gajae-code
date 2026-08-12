/**
 * Autoresearch mission `python` tool: the model-facing research execution tool.
 * Registered at session construction as a default-inactive `ToolDefinition` and
 * activated per mission via `setActiveToolsByName` with the full merged active
 * list. Wraps the shared persistent Python kernel executor, records every
 * execute call as a notebook cell, and carries a clear-kernel action on the
 * same tool (AC-19/AC-20 — no separate teardown tool exists).
 */
import type { AgentToolResult } from "@gajae-code/agent-core";
import { type Static, z } from "@gajae-code/ai/core";
import { disposeKernelSessionsByOwner, executePython } from "../eval/py/executor";
import { RLM_MANAGED_PYTHON_PACKAGES } from "../eval/py/runtime";
import type { ToolDefinition } from "../extensibility/extensions/types";
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

export interface AutoresearchPythonToolContext {
	/** Working directory for kernel execution. */
	cwd: string;
	/** Effective artifacts directory for the current session. */
	artifactsDir: string;
	/** Live notebook writer that records every executed cell. */
	notebook: RlmNotebookWriter;
	/**
	 * Reads the currently-active mission id from persisted mission state.
	 * Missions are minted at runtime (handoff/cold intake) and can be cleared
	 * and re-created within one session, so the id is never known at session
	 * construction — resolve it per call. Returns null when no mission is
	 * active, in which case the tool refuses to execute.
	 */
	getMissionId: () => string | null;
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

export function createAutoresearchPythonTool(
	context: AutoresearchPythonToolContext,
): ToolDefinition<typeof paramsSchema> {
	const seenOwnerIds = new Set<string>();

	const resolveOwnerId = (): string | null => {
		const missionId = context.getMissionId();
		if (missionId === null) return null;
		const ownerId = autoresearchKernelOwnerId(missionId);
		seenOwnerIds.add(ownerId);
		return ownerId;
	};

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
			const ownerId = resolveOwnerId();
			if (ownerId === null) {
				return {
					content: [
						{
							type: "text",
							text: "No active autoresearch mission — the mission Python kernel is only available while a mission is active.",
						},
					],
					isError: true,
				};
			}
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
				artifactsDir: context.artifactsDir,
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
			await context.notebook.appendCode(code, cell);
			const text = result.output.length > 0 ? result.output : "(no output)";
			return { content: [{ type: "text", text }] };
		},
	};
}
