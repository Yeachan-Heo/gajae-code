import { APP_SERVER_PROJECTION_CUSTOM_ENTRY_TYPE, type SessionEntry } from "./session-manager";

export interface AppServerProjectionEnvelope {
	schemaVersion: 1;
	recordKind: string;
	sourceKey: string;
	payload: unknown;
}

export interface AppServerProjectionStore {
	getEntries(): readonly SessionEntry[];
	appendAppServerProjectionEntry(data: unknown): string;
	flush(): Promise<void>;
}

interface PersistedAppServerProjectionEnvelope extends AppServerProjectionEnvelope {
	projectionOrdinal: number;
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}

function projectionError(code: "invalid_input" | "idempotency_conflict" | "projection_corrupt", message: string): Error {
	return Object.assign(new Error(message), { code });
}

export function validateAppServerProjectionEnvelope(value: unknown): AppServerProjectionEnvelope {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw projectionError("invalid_input", "projection.append requires an envelope object.");
	const envelope = value as Record<string, unknown>;
	if (
		Object.keys(envelope).length !== 4 ||
		Object.keys(envelope)
			.sort()
			.some((key, index) => key !== ["payload", "recordKind", "schemaVersion", "sourceKey"][index]) ||
		envelope.schemaVersion !== 1 ||
		typeof envelope.recordKind !== "string" ||
		!envelope.recordKind ||
		typeof envelope.sourceKey !== "string" ||
		!envelope.sourceKey
	)
		throw projectionError(
			"invalid_input",
			"projection.append requires { schemaVersion: 1, recordKind, sourceKey, payload }.",
		);
	return envelope as unknown as AppServerProjectionEnvelope;
}

export function validateAppServerProjectionAfterRevision(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw projectionError("invalid_input", "projection.read afterRevision must be a non-negative integer.");
	return value;
}

function projectionDigest(envelope: AppServerProjectionEnvelope): string {
	return canonicalJson({ schemaVersion: envelope.schemaVersion, recordKind: envelope.recordKind, payload: envelope.payload });
}

function readPersistedProjection(value: unknown): PersistedAppServerProjectionEnvelope {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw projectionError("projection_corrupt", "Persisted app-server projection record is malformed.");
	const persisted = value as Record<string, unknown>;
	if (!Number.isSafeInteger(persisted.projectionOrdinal) || (persisted.projectionOrdinal as number) <= 0)
		throw projectionError("projection_corrupt", "Persisted app-server projection record has an invalid ordinal.");
	try {
		const { projectionOrdinal: _projectionOrdinal, ...envelope } = persisted;
		return { ...validateAppServerProjectionEnvelope(envelope), projectionOrdinal: persisted.projectionOrdinal as number };
	} catch {
		throw projectionError("projection_corrupt", "Persisted app-server projection record is malformed.");
	}
}

function persistedProjections(store: AppServerProjectionStore): Array<{ entry: SessionEntry; persisted: PersistedAppServerProjectionEnvelope }> {
	const projections: Array<{ entry: SessionEntry; persisted: PersistedAppServerProjectionEnvelope }> = [];
	let priorOrdinal = 0;
	for (const entry of store.getEntries()) {
		if (entry.type !== "custom" || entry.customType !== APP_SERVER_PROJECTION_CUSTOM_ENTRY_TYPE) continue;
		const persisted = readPersistedProjection((entry as { data?: unknown }).data);
		if (persisted.projectionOrdinal <= priorOrdinal)
			throw projectionError("projection_corrupt", "Persisted app-server projection ordinals must be unique and strictly increasing.");
		priorOrdinal = persisted.projectionOrdinal;
		projections.push({ entry, persisted });
	}
	return projections;
}

export async function appendAppServerProjection(store: AppServerProjectionStore, value: unknown): Promise<{
	entryId: string;
	revision: number;
	reused?: true;
}> {
	const envelope = validateAppServerProjectionEnvelope(value);
	const existing = persistedProjections(store).find(({ persisted }) => persisted.sourceKey === envelope.sourceKey);
	if (existing) {
		if (projectionDigest(existing.persisted) !== projectionDigest(envelope))
			throw projectionError("idempotency_conflict", "projection.append sourceKey already exists with different content.");
		await store.flush();
		return { entryId: existing.entry.id, revision: existing.persisted.projectionOrdinal, reused: true };
	}
	const projectionOrdinal = Math.max(0, ...persistedProjections(store).map(({ persisted }) => persisted.projectionOrdinal)) + 1;
	const entryId = store.appendAppServerProjectionEntry({ ...envelope, projectionOrdinal });
	await store.flush();
	return { entryId, revision: projectionOrdinal };
}

/** `afterRevision` is the last returned projection ordinal, retained under its wire name. */
export function readAppServerProjections(store: AppServerProjectionStore, afterRevision?: unknown): {
	records: Array<{ entryId: string; envelope: unknown }>;
	revision: number;
} {
	const afterOrdinal = validateAppServerProjectionAfterRevision(afterRevision);
	const projections = persistedProjections(store);
	return {
		records: projections
			.filter(({ persisted }) => afterOrdinal === undefined || persisted.projectionOrdinal > afterOrdinal)
			.map(({ entry, persisted }) => {
				const { projectionOrdinal: _projectionOrdinal, ...envelope } = persisted;
				return { entryId: entry.id, envelope };
			}),
		revision: projections.at(-1)?.persisted.projectionOrdinal ?? 0,
	};
}
