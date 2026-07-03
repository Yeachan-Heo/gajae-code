import { $pickenv } from "@gajae-code/utils/env";

/** Minimal UI-capability fields needed to decide whether bash can use the local PTY overlay. */
export interface BashPtyContext {
	hasUI?: boolean;
	ui?: unknown;
}

/** Return whether a bash tool call should use the local interactive PTY overlay. */
export function canUseInteractiveBashPty(pty: boolean, ctx: BashPtyContext | undefined): boolean {
	if (!pty) return false;
	if ($pickenv("GJC_NO_PTY", "PI_NO_PTY") === "1") return false;
	return ctx?.hasUI === true && ctx.ui !== undefined;
}
