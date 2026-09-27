/**
 * Session-dependent descriptions for tools whose prompt text varies with session settings.
 *
 * A discoverable tool is advertised before its implementation loads. The facade renders these
 * descriptions from the session itself, so the text sent before the first call is the text the
 * loaded tool reports afterwards, and the provider-visible `tools` block (and with it the
 * prompt-cache prefix) does not change when the implementation loads (#5992).
 */
import { prompt } from "@gajae-code/utils";
import evalDescription from "../prompts/tools/eval.md" with { type: "text" };
import searchDescription from "../prompts/tools/search.md" with { type: "text" };
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import type { ToolSession } from ".";
import { resolveEvalBackends } from "./eval-backends";

export interface EvalToolDescriptionOptions {
	py?: boolean;
	js?: boolean;
}

export function getEvalToolDescription(options: EvalToolDescriptionOptions = {}): string {
	const py = options.py ?? true;
	const js = options.js ?? true;
	return prompt.render(evalDescription, { py, js });
}

export function evalToolDescriptionForSession(session: ToolSession | null | undefined): string {
	if (!session) return getEvalToolDescription();
	const backends = resolveEvalBackends(session);
	return getEvalToolDescription({ py: backends.python, js: backends.js });
}

export function searchToolDescriptionForSession(session: ToolSession): string {
	const displayMode = resolveFileDisplayMode(session);
	return prompt.render(searchDescription, {
		IS_HL_MODE: displayMode.hashLines,
		IS_LINE_NUMBER_MODE: !displayMode.hashLines && displayMode.lineNumbers,
	});
}
