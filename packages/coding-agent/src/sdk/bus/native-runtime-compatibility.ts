const REQUIRED_WORKFLOW_ARBITRATION_METHODS = ["registerArbitratedAsk", "retireIfUnclaimed", "stopAndWait"] as const;

export class NativeRuntimeCompatibilityError extends Error {
	readonly code = "native_runtime_incompatible";
	readonly retryable = false;

	constructor(
		readonly runtimeVersion: string,
		readonly nativeVersion: string,
		readonly workflowArbitrationAvailable: boolean,
	) {
		super(
			`Incompatible @gajae-code/natives for @gajae-code/coding-agent@${runtimeVersion}: ` +
				`loaded native version is ${nativeVersion}, and required workflow arbitration methods are ` +
				`${workflowArbitrationAvailable ? "available" : "missing"}. ` +
				`Reinstall matching @gajae-code/coding-agent and @gajae-code/natives packages.`,
		);
		this.name = "NativeRuntimeCompatibilityError";
	}
}

function hasWorkflowArbitrationMethods(notificationServer: unknown): boolean {
	if (!notificationServer || (typeof notificationServer !== "object" && typeof notificationServer !== "function"))
		return false;
	return REQUIRED_WORKFLOW_ARBITRATION_METHODS.every(
		method => typeof (notificationServer as Record<string, unknown>)[method] === "function",
	);
}

export function assertNativeRuntimeCompatibility(input: {
	runtimeVersion: string;
	nativeVersion: string;
	notificationServer: unknown;
}): void {
	const workflowArbitrationAvailable = hasWorkflowArbitrationMethods(input.notificationServer);
	if (input.runtimeVersion !== input.nativeVersion || !workflowArbitrationAvailable)
		throw new NativeRuntimeCompatibilityError(
			input.runtimeVersion,
			input.nativeVersion,
			workflowArbitrationAvailable,
		);
}
