export interface DesktopBtwTurn {
	turnId: string;
	question: string;
	answer: string;
	status: "running" | "cancel_requested" | "completed" | "cancelled" | "failed";
	answerTruncated: boolean;
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
