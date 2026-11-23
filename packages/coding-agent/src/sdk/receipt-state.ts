export type ReceiptState = "absent" | "present" | "missing" | "unknown";

export type ExecutionState = "accepted" | "in_flight" | "terminal_ok" | "failed" | "cancelled" | "unknown";

export interface ReceiptSource {
	text?: string | null;
	artifactPath?: string | null;
}

export interface TerminalReceiptInput {
	execution: "accepted" | "in_flight" | "completed" | "failed" | "cancelled" | "unknown";
	reportable: boolean;
}

export interface TerminalReceiptState {
	execution: ExecutionState;
	receipt: ReceiptState;
}

export function reportableReceipt({ text, artifactPath }: ReceiptSource): boolean {
	return Boolean(text?.trim() || artifactPath?.trim());
}

/** Terminal receipt evidence is monotonic: present > missing > unknown. */
export function reduceReceiptState(
	existing: Exclude<ReceiptState, "absent"> | undefined,
	incoming: Exclude<ReceiptState, "absent"> | undefined,
): Exclude<ReceiptState, "absent"> | undefined {
	if (existing === "present" || incoming === "present") return "present";
	if (existing === "missing" || incoming === "missing") return "missing";
	return existing ?? incoming;
}

export function reduceTerminalReceiptState(input: TerminalReceiptInput): TerminalReceiptState {
	switch (input.execution) {
		case "accepted":
			return { execution: "accepted", receipt: "absent" };
		case "in_flight":
			return { execution: "in_flight", receipt: "absent" };
		case "completed":
			return { execution: "terminal_ok", receipt: input.reportable ? "present" : "missing" };
		case "failed":
			return { execution: "failed", receipt: input.reportable ? "present" : "absent" };
		case "cancelled":
			return { execution: "cancelled", receipt: input.reportable ? "present" : "absent" };
		case "unknown":
			return { execution: "unknown", receipt: "unknown" };
	}
}
