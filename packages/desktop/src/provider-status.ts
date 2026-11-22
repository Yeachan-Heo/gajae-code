import type {
	DesktopAuthProvider,
	DesktopAuthState,
	DesktopModel,
	DesktopSession,
} from "@gajae-code/desktop-host/protocol";

/**
 * What a provider row says. `connecting` and `failed` describe the Host's single authorization
 * flow and win over the provider's own state; the rest come from `auth.providers` and the
 * snapshot's available models, in that order of strength: ready > configured > external > none.
 */
export type ProviderStatus = "connecting" | "failed" | "ready" | "configured" | "external" | "none";

export interface ProviderRow {
	id: string;
	/** OAuth catalog name, or the id verbatim. */
	name: string;
	status: ProviderStatus;
	/** This provider's models in the snapshot's available list. */
	models: number;
	/** Effective authentication or at least one available model: the Connected group. */
	connected: boolean;
	configured: boolean;
	/** Current credential presence in the shared store, never a flow outcome. */
	stored: boolean;
	credentialKinds: DesktopAuthProvider["credentialKinds"];
	canSignIn: boolean;
	canStoreKey: boolean;
}

export interface ProviderGroups {
	connected: ProviderRow[];
	available: ProviderRow[];
}

/** The flow still runs: it is authorizing or waiting on an answer. */
export function isActiveFlow(flow: DesktopAuthState | null | undefined): boolean {
	return flow?.status === "authorizing" || flow?.status === "waiting";
}

/** Available models per provider id. */
export function modelCounts(models: readonly DesktopModel[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const model of models) counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);
	return counts;
}

function byName(left: ProviderRow, right: ProviderRow): number {
	return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}

/**
 * Project the Host's provider list into grouped, sorted rows.
 *
 * `ownedFlowIds` are the flows whose outcome this mounted dialog may report: a flow it started
 * or resumed and has not dismissed. A terminal flow it does not own is history and changes no
 * row; an active flow is the Host's current state and always shows as connecting.
 */
export function projectProviders(
	providers: readonly DesktopAuthProvider[],
	models: readonly DesktopModel[],
	flow: DesktopAuthState | null,
	ownedFlowIds: ReadonlySet<string>,
): ProviderGroups {
	const counts = modelCounts(models);
	const groups: ProviderGroups = { connected: [], available: [] };
	for (const provider of providers) {
		const count = counts.get(provider.id) ?? 0;
		const own = flow?.provider === provider.id ? flow : null;
		const status: ProviderStatus = isActiveFlow(own)
			? "connecting"
			: own?.status === "error" && own.catalogRefreshed !== false && ownedFlowIds.has(own.id)
				? "failed"
				: count > 0
					? "ready"
					: provider.configured
						? provider.stored
							? "configured"
							: "external"
						: "none";
		const row: ProviderRow = {
			id: provider.id,
			name: provider.name,
			status,
			models: count,
			connected: provider.configured || count > 0,
			configured: provider.configured,
			stored: provider.stored,
			credentialKinds: provider.credentialKinds,
			canSignIn: provider.canSignIn,
			canStoreKey: provider.canStoreKey,
		};
		(row.connected ? groups.connected : groups.available).push(row);
	}
	groups.connected.sort(byName);
	groups.available.sort(byName);
	return groups;
}

/** Case-insensitive match on the display name or the id; a blank query keeps every row. */
export function filterProviders(groups: ProviderGroups, query: string): ProviderGroups {
	const needle = query.trim().toLocaleLowerCase();
	if (!needle) return groups;
	const matches = (row: ProviderRow) =>
		row.name.toLocaleLowerCase().includes(needle) || row.id.toLocaleLowerCase().includes(needle);
	return { connected: groups.connected.filter(matches), available: groups.available.filter(matches) };
}

export type ApiKeyDraft = { ok: true; key: string } | { ok: false; reason: "empty" | "command" };

/**
 * Mirror the SDK's key rule before sending: surrounding whitespace is trimmed, and a key that
 * starts with `!` is a terminal command reference, which the SDK refuses to store.
 */
export function normalizeApiKeyDraft(draft: string): ApiKeyDraft {
	const key = draft.trim();
	if (!key) return { ok: false, reason: "empty" };
	if (key.startsWith("!")) return { ok: false, reason: "command" };
	return { ok: true, key };
}

/** The flow a dialog may show: the active one, or a finished one it owns. */
export function visibleFlow(flow: DesktopAuthState | null, ownedFlowIds: ReadonlySet<string>): DesktopAuthState | null {
	return flow && (isActiveFlow(flow) || ownedFlowIds.has(flow.id)) ? flow : null;
}

export type FlowOutcome = "active" | "connected" | "saved-refresh-failed" | "failed" | "cancelled";

export function flowOutcome(flow: DesktopAuthState): FlowOutcome {
	if (isActiveFlow(flow)) return "active";
	if (flow.status === "complete") return "connected";
	if (flow.status === "cancelled") return "cancelled";
	return flow.catalogRefreshed === false ? "saved-refresh-failed" : "failed";
}

/** The authorization URL when the system browser may open it: HTTPS without credentials. */
export function safeAuthorizationUrl(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value);
		return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
	} catch {
		return undefined;
	}
}

/** What the open conversation's own model catalog said for its current control generation. */
export type ConversationCatalogAnswer = "models" | "empty" | "error";

export interface ConversationCatalog {
	sessionId: string;
	generation: number | null;
	models: readonly DesktopModel[];
	loading: boolean;
	error?: string;
}

/** The catalog's answer when it has settled for this conversation's current generation. */
export function settledCatalogAnswer(
	catalog: ConversationCatalog,
	session: Pick<DesktopSession, "id" | "controlGeneration">,
): ConversationCatalogAnswer | undefined {
	if (
		session.controlGeneration === null ||
		catalog.sessionId !== session.id ||
		catalog.generation !== session.controlGeneration ||
		catalog.loading
	)
		return undefined;
	if (catalog.error) return "error";
	return catalog.models.length > 0 ? "models" : "empty";
}

export interface ProviderOnboardingInput {
	/** The app's own connected state: a snapshot, no fatal error and recovery ready. */
	connected: boolean;
	/** `snapshot.models`; undefined before the first snapshot. */
	models: readonly DesktopModel[] | undefined;
	/**
	 * Null when no conversation is open. Otherwise that conversation's settled catalog answer, or
	 * the last one it settled on while it reloads; undefined until it has settled once.
	 */
	conversation: { answer: ConversationCatalogAnswer | undefined } | null;
}

/**
 * Whether the zero-model notice shows. It needs a connected app with no available model. With a
 * conversation open it also waits for that conversation's catalog: one with models hides it (a
 * runtime-registered provider), and an unknown answer hides it rather than letting it blink while
 * the catalog loads. A catalog error falls back to the snapshot, so it neither shows nor hides it.
 */
export function shouldShowProviderOnboarding(input: ProviderOnboardingInput): boolean {
	if (!input.connected || !input.models || input.models.length > 0) return false;
	if (input.conversation === null) return true;
	return input.conversation.answer === "empty" || input.conversation.answer === "error";
}
