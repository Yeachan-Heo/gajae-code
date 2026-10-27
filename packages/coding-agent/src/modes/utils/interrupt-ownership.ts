import type { InteractiveModeContext } from "../types";

/** Ordinary focused UI owns interrupt/back before background work does. */
export function focusedUiOwnsInterrupt(
	ctx: Pick<InteractiveModeContext, "ui" | "editor" | "hookSelector" | "hookInput" | "hookEditor">,
): boolean {
	const focused = ctx.ui.getFocusedComponent?.();
	if (!focused?.handleInput || focused === ctx.editor) return false;
	// Non-inline hook prompts deliberately retain workflow-level interruption.
	if (focused === ctx.hookSelector) return ctx.hookSelector.hasActiveInlineInput();
	return focused !== ctx.hookInput && focused !== ctx.hookEditor;
}
