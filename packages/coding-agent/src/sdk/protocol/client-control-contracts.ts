export type SdkOperatorOperation = "operator.execute" | "operator.read" | "operator.cancel";
export type SdkOperatorQueryOperation = "operator.read";

export function isSdkOperatorOperation(value: unknown): value is SdkOperatorOperation {
	return value === "operator.execute" || value === "operator.read" || value === "operator.cancel";
}

export function isSdkOperatorQueryOperation(value: unknown): value is SdkOperatorQueryOperation {
	return value === "operator.read";
}

/** Installed by a trusted local application in SessionRouter, never accepted from a wire request. */
