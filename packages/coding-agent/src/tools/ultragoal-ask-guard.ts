import type { AgentTool } from "@gajae-code/agent-core";
import {
	consumeUltragoalAskNudge,
	isUltragoalAskBlocked,
	type UltragoalAskBlockDiagnostic,
} from "../gjc-runtime/ultragoal-guard";
import { ToolError } from "./tool-errors";

const ULTRAGOAL_ASK_GUARD = Symbol.for("gajae-code.ultragoalAskGuard");

type GuardedTool = AgentTool & { [ULTRAGOAL_ASK_GUARD]?: true };

export function formatUltragoalAskBlockMessage(diagnostic: UltragoalAskBlockDiagnostic): string {
	return [
		diagnostic.message,
		`Ultragoal ask guard blocked ask (source: ${diagnostic.source}; reason: ${diagnostic.reason}).`,
		"Use `gjc ultragoal record-review-blockers` to record the blocker instead of asking the user.",
	].join("\n");
}

export async function assertUltragoalAskAllowed(cwd: string): Promise<void> {
	const diagnostic = await isUltragoalAskBlocked(cwd);
	if (!diagnostic.active) return;
	const nudge = await consumeUltragoalAskNudge(cwd);
	if (nudge.nudged) throw new ToolError(nudge.message);
	throw new ToolError(formatUltragoalAskBlockMessage(diagnostic));
}

export function guardToolForUltragoalAsk<T extends AgentTool>(tool: T, getCwd: () => string): T {
	if (tool.name !== "ask") return tool;
	const candidate = tool as GuardedTool;
	if (candidate[ULTRAGOAL_ASK_GUARD]) return tool;
	const wrapped = new Proxy(tool, {
		get(target, prop, receiver) {
			if (prop === ULTRAGOAL_ASK_GUARD) return true;
			if (prop !== "execute") return Reflect.get(target, prop, receiver);
			return async (...args: unknown[]): Promise<unknown> => {
				await assertUltragoalAskAllowed(getCwd());
				return Reflect.apply(target.execute, target, args);
			};
		},
	}) as T & GuardedTool;
	wrapped[ULTRAGOAL_ASK_GUARD] = true;
	return wrapped as T;
}
