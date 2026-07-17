/** Injectable Discord boundary. The daemon owns all persistence and SDK routing. */
export interface DiscordThread {
	id: string;
	guildId: string;
	parentId: string;
	archived: boolean;
	locked?: boolean;
}

export interface DiscordInboundEvent {
	id: string;
	guildId: string;
	parentId: string;
	threadId: string;
	authorId: string;
	bot?: boolean;
	content?: string;
	interaction?: { id: string; token: string; customId: string; value?: string | number };
}

/** Discord API message components used for action-needed controls. */
export interface DiscordMessageComponent {
	type: 1;
	components: Array<{
		type: 3;
		customId: string;
		placeholder?: string;
		minValues?: number;
		maxValues?: number;
		options: Array<{ label: string; value: string }>;
	}>;
}

export interface DiscordProvider {
	readonly applicationId: string;
	readonly botUserId: string;
	readonly transportHealthy?: boolean;
	/** Starts a generic text-channel thread from a nonce-bearing parent starter message. */
	createThread(input: { guildId: string; parentId: string; name: string; nonce: string }): Promise<DiscordThread>;
	/** Finds a thread created with a caller-generated nonce after an uncertain create. */
	findThreadByNonce(input: { guildId: string; parentId: string; nonce: string }): Promise<DiscordThread | null>;
	/** Finds a posted message by its caller-generated nonce after an uncertain post. */
	findMessageByNonce(input: { threadId: string; nonce: string }): Promise<{ id: string } | null>;
	postMessage(input: {
		threadId: string;
		content: string;
		nonce?: string;
		components?: DiscordMessageComponent[];
	}): Promise<{ id: string }>;
	/** Defers an accepted component interaction before SDK routing can exceed Discord's response deadline. */
	deferInteraction(input: { id: string; token: string }): Promise<void>;
	archiveThread(input: { threadId: string; locked?: boolean }): Promise<void>;
	unarchiveThread(input: { threadId: string }): Promise<void>;
	start(onEvent: (event: DiscordInboundEvent) => Promise<void>, onError?: (error: unknown) => void): Promise<void>;
	stop(): Promise<void>;
}
