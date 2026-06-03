/**
 * v1 seams (M11). The control plane is harness-agnostic by design, but v1 ships ONLY the
 * gajae-code adapter. Other harnesses and transports are explicit, designed-not-built seams
 * that fail closed with a clear `seam_unsupported_in_v1` signal rather than silently degrading.
 */
import type { Harness } from "./types";

export const SUPPORTED_HARNESSES: readonly Harness[] = ["gajae-code"];

export const DEFERRED_SEAMS = [
	"codex-adapter",
	"omx-adapter",
	"remote-transport",
	"global-daemon",
	"capability-token-auth",
	"web-viewer",
	"fleet-control-plane",
	"rich-tui-coview",
] as const;

export type DeferredSeam = (typeof DEFERRED_SEAMS)[number];

export function isHarnessSupported(harness: string): harness is Harness {
	return (SUPPORTED_HARNESSES as readonly string[]).includes(harness);
}

export interface UnsupportedSeamResult {
	ok: false;
	error: string;
	evidence: { seam: true; name: string; supported: readonly Harness[]; deferred: readonly string[] };
}

export function unsupportedSeam(name: string): UnsupportedSeamResult {
	return {
		ok: false,
		error: `seam_unsupported_in_v1:${name}`,
		evidence: { seam: true, name, supported: SUPPORTED_HARNESSES, deferred: DEFERRED_SEAMS },
	};
}
