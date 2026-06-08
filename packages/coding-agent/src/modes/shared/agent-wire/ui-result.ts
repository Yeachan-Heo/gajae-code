/**
 * Typed UI/manipulation result semantics for bridge-capability handling.
 *
 * `unsupported` is distinct from both a real value and user cancellation. This
 * prevents local-only or undeclared `ExtensionUIContext` surfaces from becoming
 * silent no-ops that look like user intent.
 */
export interface BridgeUiValue<TValue> {
	status: "value";
	value: TValue;
}

export interface BridgeUiCancelled {
	status: "cancelled";
	reason?: "user" | "timeout" | "abort" | "disconnect";
}

export interface BridgeUiUnsupported {
	status: "unsupported";
	capability: string;
	reason: string;
}

export type BridgeUiResult<TValue> = BridgeUiValue<TValue> | BridgeUiCancelled | BridgeUiUnsupported;

export function uiValue<TValue>(value: TValue): BridgeUiValue<TValue> {
	return { status: "value", value };
}

export function uiCancelled(reason?: BridgeUiCancelled["reason"]): BridgeUiCancelled {
	return reason ? { status: "cancelled", reason } : { status: "cancelled" };
}

export function uiUnsupported(capability: string, reason: string): BridgeUiUnsupported {
	return { status: "unsupported", capability, reason };
}

export function isUiUnsupported<TValue>(result: BridgeUiResult<TValue>): result is BridgeUiUnsupported {
	return result.status === "unsupported";
}

export function isUiCancelled<TValue>(result: BridgeUiResult<TValue>): result is BridgeUiCancelled {
	return result.status === "cancelled";
}

export function isUiValue<TValue>(result: BridgeUiResult<TValue>): result is BridgeUiValue<TValue> {
	return result.status === "value";
}
