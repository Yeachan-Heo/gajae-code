import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@gajae-code/agent-core";
import type { Component } from "@gajae-code/tui";
import { Text } from "@gajae-code/tui";
import { formatNumber, prompt } from "@gajae-code/utils";
import * as z from "zod/v4";
import type { RenderResultOptions } from "../../extensibility/custom-tools/types";
import {
	assertCanCompleteCurrentGoal,
	assertUltragoalDropAllowed,
	assertUltragoalPauseAllowed,
} from "../../gjc-runtime/ultragoal-guard";
import type { Theme, ThemeColor } from "../../modes/theme/theme";
import goalDescription from "../../prompts/tools/goal.md" with { type: "text" };
import { formatDuration } from "../../slash-commands/helpers/format";
import type { ToolSession } from "../../tools";
import { formatErrorMessage, TRUNCATE_LENGTHS } from "../../tools/render-utils";
import { ToolError } from "../../tools/tool-errors";
import { renderStatusLine, truncateToWidth } from "../../tui";
import { validateGoalObjective } from "../runtime";
import type { Goal, GoalStatus, GoalToolDetails } from "../state";

const goalSchema = z.object({
	op: z
		.enum(["create", "get", "complete", "resume", "drop", "pause"])
		.describe(
			"op: get | create | complete | drop | resume | pause — drop clears the active goal without exiting goal mode (tool stays callable for the next create); pause parks an active goal whose remaining work is blocked on human input so the autonomous continuation loop stops until resume",
		),
	objective: z.string().describe("goal objective").optional(),
});

export type GoalToolInput = z.infer<typeof goalSchema>;

export interface GoalToolResponse {
	goal: Goal | null;
}

export function buildGoalToolResponse(goal: Goal | null | undefined): GoalToolResponse {
	return { goal: goal ?? null };
}

function rejectUnsupportedGoalArgs(params: Record<string, unknown>): void {
	if ("token_budget" in params || "tokenBudget" in params) {
		throw new ToolError("token_budget is not supported for goals");
	}
}

function validateCreateParams(params: { objective?: string }): { objective: string } {
	let objective: string;
	try {
		objective = validateGoalObjective(params.objective ?? "", "create");
	} catch (error) {
		throw new ToolError(error instanceof Error ? error.message : String(error));
	}
	return { objective };
}

function renderGoalToolResponse(response: GoalToolResponse): string {
	if (!response.goal) return "No active goal.";

	return `Goal: ${response.goal.objective}\nStatus: ${response.goal.status}\nTokens used: ${response.goal.tokensUsed}`;
}

function buildGoalToolResult(op: GoalToolDetails["op"], response: GoalToolResponse): AgentToolResult<GoalToolDetails> {
	return {
		content: [{ type: "text", text: renderGoalToolResponse(response) }],
		details: {
			op,
			goal: response.goal,
		},
	};
}

function assertGoalOperationAllowed(session: ToolSession, op: GoalToolInput["op"]): void {
	const allowedOps = session.goalToolAllowedOps;
	if (!allowedOps || allowedOps.includes(op)) return;
	throw new ToolError(`Goal mode in this session only allows goal operations: ${allowedOps.join(", ")}.`);
}

async function executeGoalOperation(session: ToolSession, params: GoalToolInput): Promise<GoalToolResponse> {
	rejectUnsupportedGoalArgs(params as Record<string, unknown>);
	assertGoalOperationAllowed(session, params.op);
	if (params.op === "get") {
		const state = session.getGoalModeState?.();
		return buildGoalToolResponse(state?.goal ?? null);
	}

	const runtime = session.getGoalRuntime?.();
	if (!runtime) {
		throw new ToolError("Goal mode is not active.");
	}

	if (params.op === "create") {
		const created = await runtime.createGoal(validateCreateParams(params));
		return buildGoalToolResponse(created.goal);
	}
	if (params.op === "resume") {
		const resumed = await runtime.resumeGoal();
		return buildGoalToolResponse(resumed.goal);
	}
	if (params.op === "pause") {
		try {
			await assertUltragoalPauseAllowed(session.cwd);
		} catch (error) {
			throw new ToolError(error instanceof Error ? error.message : String(error));
		}
		const paused = await runtime.pauseGoal();
		return buildGoalToolResponse(paused?.goal ?? null);
	}
	if (params.op === "drop") {
		try {
			await assertUltragoalDropAllowed({
				cwd: session.cwd,
				currentGoal: session.getGoalModeState?.()?.goal ?? null,
				sessionId: session.getSessionId?.(),
			});
		} catch (error) {
			throw new ToolError(error instanceof Error ? error.message : String(error));
		}
		const dropped = await runtime.dropGoal();
		return buildGoalToolResponse(dropped ?? null);
	}
	try {
		await assertCanCompleteCurrentGoal({
			cwd: session.cwd,
			currentGoal: session.getGoalModeState?.()?.goal ?? null,
			sessionId: session.getSessionId?.(),
		});
	} catch (error) {
		throw new ToolError(error instanceof Error ? error.message : String(error));
	}
	const completed = await runtime.completeGoalFromTool();
	return buildGoalToolResponse(completed);
}

export class GoalTool implements AgentTool<typeof goalSchema, GoalToolDetails> {
	readonly name = "goal";
	readonly label = "Goal";
	readonly loadMode = "essential" as const;
	readonly description = prompt.render(goalDescription);
	readonly parameters = goalSchema;
	readonly strict = true;
	readonly intent = "omit" as const;
	readonly #session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
	}

	async execute(
		_toolCallId: string,
		params: GoalToolInput,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<GoalToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<GoalToolDetails>> {
		const response = await executeGoalOperation(this.#session, params);
		return buildGoalToolResult(params.op as GoalToolDetails["op"], response);
	}
}

function describeOp(op: string | undefined): string {
	switch (op) {
		case "create":
			return "set";
		case "complete":
			return "complete";
		case "get":
			return "check";
		case "resume":
			return "resume";
		case "pause":
			return "pause";
		case "drop":
			return "drop";
		default:
			return op ?? "?";
	}
}

function goalBadgeColor(status: GoalStatus): ThemeColor {
	switch (status) {
		case "complete":
			return "success";
		case "paused":
		case "dropped":
			return "muted";
		default:
			return "accent";
	}
}

interface GoalRenderArgs {
	op?: GoalToolInput["op"];
	objective?: string;
}

export const goalToolRenderer = {
	renderCall(args: GoalRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const description = describeOp(args.op);
		const meta: string[] = [];
		const trimmedObjective = args.objective?.trim();
		if (args.op === "create" && trimmedObjective) {
			const objective = truncateToWidth(trimmedObjective, TRUNCATE_LENGTHS.TITLE);
			meta.push(uiTheme.italic(uiTheme.fg("muted", `"${objective}"`)));
		}
		const text = renderStatusLine({ icon: "pending", title: "Goal", description, meta }, uiTheme);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: GoalToolDetails; isError?: boolean },
		_options: RenderResultOptions,
		uiTheme: Theme,
		args?: GoalRenderArgs,
	): Component {
		const fallbackText = result.content?.find(c => c.type === "text")?.text ?? "";
		const details = result.details;
		const op = details?.op ?? args?.op;
		const description = describeOp(op);

		if (result.isError) {
			const header = renderStatusLine({ icon: "error", title: "Goal", description }, uiTheme);
			const body = formatErrorMessage(fallbackText || "Goal tool failed", uiTheme);
			return new Text([header, body].join("\n"), 0, 0);
		}

		const goal = details?.goal ?? null;
		if (!goal) {
			const header = renderStatusLine({ icon: "warning", title: "Goal", description }, uiTheme);
			const body = uiTheme.fg("muted", "No active goal.");
			return new Text([header, body].join("\n"), 0, 0);
		}

		const lines: string[] = [];
		lines.push(
			renderStatusLine(
				{
					icon: "success",
					title: "Goal",
					description,
					badge: { label: goal.status, color: goalBadgeColor(goal.status) },
				},
				uiTheme,
			),
		);

		const objectiveText = truncateToWidth(goal.objective.trim(), TRUNCATE_LENGTHS.LONG);
		lines.push(`  ${uiTheme.italic(uiTheme.fg("muted", `"${objectiveText}"`))}`);
		lines.push(`  ${uiTheme.fg("dim", `${formatNumber(goal.tokensUsed)} tokens used`)}`);

		if (goal.timeUsedSeconds > 0) {
			lines.push(`  ${uiTheme.fg("dim", `${formatDuration(goal.timeUsedSeconds * 1000)} elapsed`)}`);
		}

		return new Text(lines.join("\n"), 0, 0);
	},

	mergeCallAndResult: true,
};
