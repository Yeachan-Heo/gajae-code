export type ReceiptState = "absent" | "present" | "missing" | "unknown";

export type ExecutionState = "accepted" | "in_flight" | "terminal_ok" | "failed" | "unknown";

export interface ReceiptSource {
	text?: string | null;
	artifactPath?: string | null;
}

export function reportableReceipt({ text, artifactPath }: ReceiptSource): boolean {
	return Boolean(text?.trim() || artifactPath?.trim());
}

export function receiptStateForTerminal(source: ReceiptSource): Extract<ReceiptState, "present" | "missing"> {
	return reportableReceipt(source) ? "present" : "missing";
}
