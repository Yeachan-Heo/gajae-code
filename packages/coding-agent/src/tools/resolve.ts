import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@gajae-code/agent-core";
import type { ToolChoice } from "@gajae-code/ai";
import type { Component } from "@gajae-code/tui";
import { Text } from "@gajae-code/tui";
import { prompt, untilAborted } from "@gajae-code/utils";
import * as z from "zod/v4";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import resolveDescription from "../prompts/tools/resolve.md" with { type: "text" };
import { Ellipsis, padToWidth, renderStatusLine, truncateToWidth } from "../tui";
import type { ToolSession } from ".";
import { replaceTabs } from "./render-utils";
import { ToolError } from "./tool-errors";

const resolveSchema = z.object({
	action: z.enum(["apply", "discard"]),
	reason: z.string().describe("reason for action"),
	extra: z.record(z.string(), z.unknown()).optional().describe("free-form metadata"),
});

type ResolveParams = z.infer<typeof resolveSchema>;

export interface ResolveToolDetails {
	action: "apply" | "discard";
	reason: string;
	extra?: Record<string, unknown>;
	sourceToolName?: string;
	label?: string;
	sourceResultDetails?: unknown;
}

/**
 * Queue a resolve-protocol handler on the tool-choice queue. Forces the next
 * LLM call to invoke the hidden `resolve` tool, wraps the caller's apply/reject
 * callbacks into an onInvoked closure that matches the resolve schema, and
 * steers a preview reminder so the model understands why.
 *
 * This is the canonical entry point for any tool that wants preview/apply
 * semantics. No session-level abstraction is needed: callers pass their
 * apply/reject functions directly.
 */
/**
 * Tags preview-fallback handlers installed in the session's standing-resolve
 * slot so newer previews can replace older ones (latest-preview-wins) without
 * ever displacing a mode-owned handler such as plan mode's approval handler.
 */
const previewResolveFallbacks = new WeakSet<object>();

function markPreviewResolveFallback(handler: (input: unknown) => Promise<unknown> | unknown): void {
	previewResolveFallbacks.add(handler);
}

function isPreviewResolveFallback(handler: (input: unknown) => Promise<unknown> | unknown): boolean {
	return previewResolveFallbacks.has(handler);
}

export function queueResolveHandler(
	session: ToolSession,
	options: {
		label: string;
		sourceToolName: string;
		apply(reason: string, extra?: Record<string, unknown>): Promise<AgentToolResult<unknown>>;
		reject?(reason: string, extra?: Record<string, unknown>): Promise<AgentToolResult<unknown> | undefined>;
	},
): void {
	const queue = session.getToolChoiceQueue?.();

	const steerReminder = (): void => {
		session.steer?.({
			customType: "resolve-reminder",
			content: [
				"<system-reminder>",
				"This is a preview. Call the `resolve` tool to apply or discard these changes.",
				"</system-reminder>",
			].join("\n"),
			details: { toolName: options.sourceToolName },
		});
	};

	// Re-evaluated on every push (including apply-error re-pushes) so a runtime
	// incapability discovered mid-turn degrades the NEXT push instead of
	// replaying a stale forced choice the model can never satisfy.
	const resolveForcedChoice = (): { forced: ToolChoice | undefined; exactNamed: boolean } => {
		const toolChoiceResult = session.buildToolChoiceResult?.("resolve");
		if (toolChoiceResult !== undefined) {
			return { forced: toolChoiceResult.choice, exactNamed: toolChoiceResult.exactNamed };
		}
		// Legacy bridge fallback: sessions that only provide buildToolChoice
		// (older SDK embedders, test harnesses) keep the previous behavior — a
		// named object choice is treated as exact named forcing.
		const legacyChoice = session.buildToolChoice?.("resolve");
		const isNamedObject = typeof legacyChoice === "object" && legacyChoice !== null;
		return { forced: isNamedObject ? legacyChoice : undefined, exactNamed: isNamedObject };
	};

	const clearFallback = (): void => {
		// Identity-aware: only clear the shared standing slot when it still holds
		// THIS preview's fallback. Plan mode (or a newer preview) may have
		// replaced it in the meantime — leave theirs untouched.
		if (session.peekStandingResolveHandler?.() === invoke) {
			session.setStandingResolveHandler?.(null);
		}
	};

	const invoke = async (input: unknown): Promise<AgentToolResult<unknown>> => {
		const result = await runResolveInvocation(input as ResolveParams, {
			sourceToolName: options.sourceToolName,
			label: options.label,
			apply: options.apply,
			reject: options.reject,
			onApplyError: () => {
				// Apply threw (e.g. ast_edit overlapping replacements). Re-push the
				// same directive so the preview remains pending and the model can
				// `discard` or fix-and-retry on the next turn instead of being
				// stranded with no pending action to address. The re-push goes
				// through the exactNamed gate again — degraded models fall back
				// to the reminder alone. The standing fallback stays installed so
				// a voluntary resolve can still reach the pending action.
				pushDirective();
				steerReminder();
			},
		});
		// Apply succeeded or the preview was discarded: the pending action is
		// finished, so the voluntary-dispatch fallback must not linger.
		clearFallback();
		return result;
	};
	markPreviewResolveFallback(invoke);

	// Voluntary-dispatch fallback: when forcing is unavailable (statically
	// degraded) or later removed (runtime degradeInFlight drops the queue
	// directive that owns the invoker), the model can still call `resolve`.
	// ResolveTool.execute consults the queue invoker first, so the standing
	// handler only serves degraded paths. Latest preview wins (mirroring the
	// queue's pushOnce now:true semantics): a newer preview's fallback replaces
	// an older preview's, but NEVER clobbers a non-preview standing handler
	// (e.g. plan mode's approval handler).
	const installFallback = (): void => {
		if (!session.setStandingResolveHandler) return;
		const existing = session.peekStandingResolveHandler?.();
		if (existing === invoke) return;
		if (existing !== undefined && !isPreviewResolveFallback(existing)) return;
		session.setStandingResolveHandler(invoke);
	};

	const pushDirective = (): boolean => {
		const { forced, exactNamed } = resolveForcedChoice();
		if (!queue || !forced || !exactNamed) {
			installFallback();
			return false;
		}
		queue.pushOnce(forced, {
			label: `pending-action:${options.sourceToolName}`,
			now: true,
			onRejected: () => "requeue",
			onInvoked: invoke,
		});
		// Forced directive may still be degraded mid-turn by a runtime
		// incapability discovery; keep the fallback armed for that case.
		installFallback();
		return true;
	};

	pushDirective();
	steerReminder();
}

/**
 * Shared invocation runner used by both queued (in-flight) handlers and
 * standing handlers (e.g. plan-mode approval). Discriminates on action,
 * routes through the caller's apply/reject, and wraps the resulting tool
 * payload with `ResolveToolDetails` so the renderer and event-controller
 * see a consistent shape.
 */
export async function runResolveInvocation(
	params: ResolveParams,
	options: {
		sourceToolName: string;
		label: string;
		apply(reason: string, extra?: Record<string, unknown>): Promise<AgentToolResult<unknown>>;
		reject?(reason: string, extra?: Record<string, unknown>): Promise<AgentToolResult<unknown> | undefined>;
		/** Invoked synchronously when `apply()` throws, before the error is rethrown.
		 *  The queued caller uses this to re-push the resolve directive so the
		 *  pending preview survives a failed apply (e.g. overlapping ast_edit
		 *  replacements) and the model can `discard` or fix-and-retry. */
		onApplyError?(error: unknown): void;
	},
): Promise<AgentToolResult<ResolveToolDetails>> {
	const baseDetails: ResolveToolDetails = {
		action: params.action,
		reason: params.reason,
		sourceToolName: options.sourceToolName,
		label: options.label,
		...(params.extra != null ? { extra: params.extra } : {}),
	};
	if (params.action === "apply") {
		let result: AgentToolResult<unknown>;
		try {
			result = await options.apply(params.reason, params.extra);
		} catch (error) {
			try {
				options.onApplyError?.(error);
			} catch {
				// Requeue hook must not mask the original apply failure.
			}
			if (error instanceof ToolError) throw error;
			const message = error instanceof Error ? error.message : String(error);
			throw new ToolError(`Apply failed: ${message}`);
		}
		return {
			...result,
			details: {
				...baseDetails,
				...(result.details != null ? { sourceResultDetails: result.details } : {}),
			},
		};
	}
	if (params.action === "discard" && options.reject != null) {
		const result = await options.reject(params.reason, params.extra);
		if (result != null) {
			return {
				...result,
				details: {
					...baseDetails,
					...(result.details != null ? { sourceResultDetails: result.details } : {}),
				},
			};
		}
	}
	return {
		content: [{ type: "text" as const, text: `Discarded: ${options.label}. Reason: ${params.reason}` }],
		details: baseDetails,
	};
}

export class ResolveTool implements AgentTool<typeof resolveSchema, ResolveToolDetails> {
	readonly name = "resolve";
	readonly label = "Resolve";
	readonly hidden = true;
	readonly description: string;
	readonly parameters = resolveSchema;
	readonly strict = true;
	readonly intent = (args: Partial<ResolveParams>) => {
		if (args.action === "discard") {
			return args.reason ? `discarding: ${args.reason}` : "discarding changes";
		}
		return args.reason ? `accepting: ${args.reason}` : "accepting changes";
	};

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(resolveDescription);
	}

	async execute(
		_toolCallId: string,
		params: ResolveParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<ResolveToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<ResolveToolDetails>> {
		return untilAborted(signal, async () => {
			const invoker = this.session.peekQueueInvoker?.() ?? this.session.peekStandingResolveHandler?.();
			if (!invoker) {
				throw new ToolError("No pending action to resolve. Nothing to apply or discard.");
			}
			const result = (await invoker(params)) as AgentToolResult<ResolveToolDetails>;
			return result;
		});
	}
}

export const resolveToolRenderer = {
	renderCall(args: ResolveParams, _options: RenderResultOptions, uiTheme: Theme): Component {
		const reasonTrimmed = args.reason?.trim();
		const reason = reasonTrimmed ? truncateToWidth(reasonTrimmed, 72, Ellipsis.Omit) : undefined;
		const text = renderStatusLine(
			{
				icon: "pending",
				title: "Resolve",
				description: args.action,
				badge: {
					label: args.action === "apply" ? "proposed -> resolved" : "proposed -> rejected",
					color: args.action === "apply" ? "success" : "warning",
				},
				meta: reason ? [uiTheme.fg("muted", reason)] : undefined,
			},
			uiTheme,
		);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: ResolveToolDetails; isError?: boolean },
		_options: RenderResultOptions,
		uiTheme: Theme,
	): Component {
		const details = result.details;
		const label = replaceTabs(details?.label ?? "pending action");
		const reason = replaceTabs(details?.reason?.trim() || "No reason provided");
		const action = details?.action ?? "apply";
		const isApply = action === "apply" && !result.isError;
		const isFailedApply = action === "apply" && result.isError;
		const bgColor = result.isError ? "error" : isApply ? "success" : "warning";
		const icon = isApply ? uiTheme.status.success : uiTheme.status.error;
		const verb = isApply ? "Accept" : isFailedApply ? "Failed" : "Discard";
		const separator = ": ";
		const separatorIndex = label.indexOf(separator);
		const sourceLabel = separatorIndex > 0 ? label.slice(0, separatorIndex).trim() : undefined;
		const summaryLabel = separatorIndex > 0 ? label.slice(separatorIndex + separator.length).trim() : label;
		const sourceBadge = sourceLabel
			? uiTheme.bold(`${uiTheme.format.bracketLeft}${sourceLabel}${uiTheme.format.bracketRight}`)
			: undefined;
		const headerLine = `${icon} ${uiTheme.bold(`${verb}:`)} ${summaryLabel}${sourceBadge ? ` ${sourceBadge}` : ""}`;
		const lines = ["", headerLine, "", uiTheme.italic(reason), ""];

		return {
			render(width: number) {
				const lineWidth = Math.max(3, width);
				const innerWidth = Math.max(1, lineWidth - 2);
				return lines.map(line => {
					const truncated = truncateToWidth(line, innerWidth, Ellipsis.Omit);
					const framed = ` ${padToWidth(truncated, innerWidth)} `;
					const padded = padToWidth(framed, lineWidth);
					return uiTheme.inverse(uiTheme.fg(bgColor, padded));
				});
			},
			invalidate() {},
		};
	},

	inline: true,
	mergeCallAndResult: true,
};
