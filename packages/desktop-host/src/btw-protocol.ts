export interface DesktopBtwTurn {
	turnId: string;
	question: string;
	answer: string;
	status: "running" | "cancel_requested" | "completed" | "cancelled" | "failed";
	answerTruncated: boolean;
	/** Provider cleanup proof is independent of visible turn status. */
	cleanup?: "pending" | "settled" | "unknown_effect";
	error?: { code: string; message: string };
}

export interface DesktopBtwConversation {
	conversationId: string;
	sessionGeneration: number;
	revision: number;
	turns: DesktopBtwTurn[];
}

export interface DesktopBtwEvent {
	conversation: DesktopBtwConversation | null;
}
