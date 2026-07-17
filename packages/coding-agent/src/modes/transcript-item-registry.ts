export type TranscriptItemKind = "user" | "assistant-text" | "assistant-thinking" | "tool" | "read-group" | "custom";

export type TranscriptItemCapabilities = {
	copyable: boolean;
	foldable: boolean;
	rawViewable: boolean;
};

export type TranscriptSourcePayload = {
	text: string;
	metadata: Readonly<Record<string, unknown>>;
	source: unknown;
};

export type TranscriptItem = {
	id: string;
	kind: TranscriptItemKind;
	source: unknown;
	getPayload?: (source: unknown) => TranscriptSourcePayload;
	capabilities?: Partial<TranscriptItemCapabilities>;
};

export type RegisterTranscriptItem = Omit<TranscriptItem, "id"> & { id?: string };

export type StreamingItemOptions = Omit<RegisterTranscriptItem, "id" | "kind"> & {
	promptGeneration: number | string;
	messageOrdinal: number;
	kind?: "assistant-text" | "assistant-thinking";
};

const DEFAULT_CAPABILITIES: Record<TranscriptItemKind, TranscriptItemCapabilities> = {
	user: { copyable: true, foldable: false, rawViewable: true },
	"assistant-text": { copyable: true, foldable: false, rawViewable: true },
	"assistant-thinking": { copyable: true, foldable: true, rawViewable: true },
	tool: { copyable: true, foldable: true, rawViewable: true },
	"read-group": { copyable: true, foldable: true, rawViewable: true },
	custom: { copyable: true, foldable: false, rawViewable: true },
};

/** Stable transcript identities shared by the inline and overlay projections. */
export const transcriptItemId = {
	entry: (entryId: string): string => `entry:${entryId}`,
	assistantContent: (entryId: string, contentIndex: number): string => `entry:${entryId}:content:${contentIndex}`,
	tool: (toolCallId: string): string => `tool:${toolCallId}`,
	readGroup: (groupId: string): string => `read-group:${groupId}`,
	custom: (customId: string): string => `custom:${customId}`,
	stream: (promptGeneration: number | string, messageOrdinal: number): string =>
		`stream:${promptGeneration}:${messageOrdinal}`,
};

function defaultPayload(source: unknown): TranscriptSourcePayload {
	if (typeof source === "string") return { text: source, metadata: {}, source };
	if (!source || typeof source !== "object") return { text: "", metadata: {}, source };

	const record = source as Record<string, unknown>;
	const text = typeof record.text === "string" ? record.text : extractContentText(record.content);
	const metadata = Object.fromEntries(Object.entries(record).filter(([key]) => key !== "text" && key !== "content"));
	return { text, metadata, source };
}

function extractContentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(item => {
			if (!item || typeof item !== "object") return "";
			const record = item as Record<string, unknown>;
			if (typeof record.text === "string") return record.text;
			if (typeof record.thinking === "string") return record.thinking;
			return "";
		})
		.join("");
}

/**
 * A session-local index of transcript projection items. It deliberately stores only
 * structural sources, allowing interactive mode to supply live streaming objects
 * and persisted session records without importing either implementation here.
 */
export class TranscriptItemRegistry {
	#items = new Map<string, TranscriptItem>();
	#aliases = new Map<string, string>();
	#sessionId: string | undefined;

	get sessionId(): string | undefined {
		return this.#sessionId;
	}

	/** Ordered snapshot for read-only transcript projections. */
	items(): readonly TranscriptItem[] {
		return [...this.#items.values()];
	}

	register(item: RegisterTranscriptItem): string {
		const id = item.id ?? this.#idForKind(item.kind, item.source);
		if (this.#items.has(id)) throw new Error(`Transcript item already registered: ${id}`);
		this.#items.set(id, { ...item, id });
		return id;
	}

	replace(id: string, item: Omit<TranscriptItem, "id">): boolean {
		const canonicalId = this.#resolveId(id);
		if (!canonicalId || !this.#items.has(canonicalId)) return false;
		this.#items.set(canonicalId, { ...item, id: canonicalId });
		return true;
	}

	startStream(options: StreamingItemOptions): string {
		const id = transcriptItemId.stream(options.promptGeneration, options.messageOrdinal);
		if (this.#items.has(id) || this.#aliases.has(id)) throw new Error(`Transcript stream already registered: ${id}`);
		this.#items.set(id, { ...options, id, kind: options.kind ?? "assistant-text" });
		return id;
	}

	/** Reconciles one exact live stream with its persisted canonical item. */
	endStream(streamId: string, item: RegisterTranscriptItem): string | undefined {
		if (!streamId.startsWith("stream:") || !this.#items.has(streamId)) return undefined;
		const canonicalId = item.id ?? this.#idForKind(item.kind, item.source);
		if (canonicalId !== streamId && this.#items.has(canonicalId)) return undefined;
		if (canonicalId === streamId) {
			this.#items.set(streamId, { ...item, id: streamId });
			return streamId;
		}
		this.#items.set(canonicalId, { ...item, id: canonicalId });
		this.#items.delete(streamId);
		this.#aliases.set(streamId, canonicalId);
		return canonicalId;
	}

	retireStream(id: string): boolean {
		if (!id.startsWith("stream:") || !this.#items.delete(id)) return false;
		this.#aliases.delete(id);
		return true;
	}

	coalesceReadGroup(groupId: string, source: unknown, toolCallIds: readonly string[] = []): string {
		const id = transcriptItemId.readGroup(groupId);
		this.#items.set(id, {
			id,
			kind: "read-group",
			source,
			getPayload: value => {
				const payload = defaultPayload(value);
				return { ...payload, metadata: { ...payload.metadata, groupId, toolCallIds } };
			},
		});
		return id;
	}

	rebuild(items: readonly RegisterTranscriptItem[]): void {
		this.#items.clear();
		this.#aliases.clear();
		for (const item of items) this.register(item);
	}

	evict(id: string): boolean {
		const canonicalId = this.#resolveId(id);
		if (!canonicalId || !this.#items.delete(canonicalId)) return false;
		for (const [alias, target] of this.#aliases) {
			if (target === canonicalId) this.#aliases.delete(alias);
		}
		return true;
	}

	switchSession(sessionId: string): void {
		if (this.#sessionId === sessionId) return;
		this.#sessionId = sessionId;
		this.#items.clear();
		this.#aliases.clear();
	}

	resolveSourcePayload(id: string): TranscriptSourcePayload | undefined {
		const canonicalId = this.#resolveId(id);
		const item = canonicalId ? this.#items.get(canonicalId) : undefined;
		if (!item) return undefined;
		return (item.getPayload ?? defaultPayload)(item.source);
	}

	capabilities(id: string): TranscriptItemCapabilities | undefined {
		const canonicalId = this.#resolveId(id);
		const item = canonicalId ? this.#items.get(canonicalId) : undefined;
		if (!item) return undefined;
		return { ...DEFAULT_CAPABILITIES[item.kind], ...item.capabilities };
	}

	has(id: string): boolean {
		const canonicalId = this.#resolveId(id);
		return canonicalId !== undefined && this.#items.has(canonicalId);
	}

	canonicalId(id: string): string | undefined {
		return this.#resolveId(id);
	}

	#resolveId(id: string): string | undefined {
		let resolved = id;
		const seen = new Set<string>();
		while (this.#aliases.has(resolved) && !seen.has(resolved)) {
			seen.add(resolved);
			resolved = this.#aliases.get(resolved)!;
		}
		return this.#items.has(resolved) ? resolved : undefined;
	}

	#idForKind(kind: TranscriptItemKind, source: unknown): string {
		const record = source && typeof source === "object" ? (source as Record<string, unknown>) : {};
		switch (kind) {
			case "user":
				if (typeof record.entryId === "string") return transcriptItemId.entry(record.entryId);
				break;
			case "assistant-text":
			case "assistant-thinking":
				if (typeof record.entryId === "string" && typeof record.contentIndex === "number") {
					return transcriptItemId.assistantContent(record.entryId, record.contentIndex);
				}
				break;
			case "tool":
				if (typeof record.toolCallId === "string") return transcriptItemId.tool(record.toolCallId);
				break;
			case "read-group":
				if (typeof record.groupId === "string") return transcriptItemId.readGroup(record.groupId);
				break;
			case "custom":
				if (typeof record.id === "string") return transcriptItemId.custom(record.id);
				break;
		}
		throw new Error(`Transcript item ${kind} requires an explicit id or canonical source identity.`);
	}
}
