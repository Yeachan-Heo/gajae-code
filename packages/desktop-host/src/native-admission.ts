import type { NativeEmbeddedRuntime, NativeInvocationResult } from "@gajae-code/coding-agent/sdk";

/**
 * Admit one SDK operation on a conversation that may be an exclusive native runtime.
 *
 * A cooperative (borrowed) conversation has no runtime, so the raw SDK path runs
 * unchanged. A native conversation may only mutate through the runtime family the
 * SDK opened for it; a refusal is reported, never silently downgraded to the raw call.
 */
export type NativeAdmission = <T>(
	run: (runtime: NativeEmbeddedRuntime) => Promise<NativeInvocationResult<T>>,
	raw: () => Promise<T>,
) => Promise<T>;

export function createNativeAdmission(runtime: NativeEmbeddedRuntime | undefined): NativeAdmission {
	if (!runtime) return (_run, raw) => raw();
	return async (run, raw) => {
		const result = await run(runtime);
		if (result.kind !== "applied") throw new Error(`Native runtime refused: ${result.reason}`);
		return result.value;
	};
}
