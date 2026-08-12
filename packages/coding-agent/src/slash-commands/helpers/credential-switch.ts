import type { AuthCredentialSelector, AuthCredentialSnapshotEntry } from "@gajae-code/ai/core";
import { parseCliCredentialSelector } from "../../runtime-credential-selector";
import type { SlashCommandRuntime } from "../types";

/** Human-readable label for one stored OAuth credential row. */
function describeCredentialRow(entry: AuthCredentialSnapshotEntry): string {
	if (entry.credential.type !== "oauth") return `id:${entry.id} (api key)`;
	const email = entry.credential.email;
	const accountId = entry.credential.accountId;
	const label = email ?? accountId ?? `row ${entry.id}`;
	return `id:${entry.id} — ${label}`;
}

function formatProviderName(provider: string): string {
	return provider
		.split(/[-_]/g)
		.map(part => (part ? part[0].toUpperCase() + part.slice(1) : ""))
		.join(" ");
}

/** Whether a stored OAuth snapshot row matches a credential selector. */
function selectorMatchesRow(selector: AuthCredentialSelector, entry: AuthCredentialSnapshotEntry): boolean {
	if (entry.credential.type !== "oauth") return false;
	switch (selector.kind) {
		case "id":
			return String(entry.id) === selector.value;
		case "email":
			return (
				typeof entry.credential.email === "string" &&
				entry.credential.email.toLowerCase() === selector.value.toLowerCase()
			);
		case "account":
			return entry.credential.accountId === selector.value;
		case "project":
			return entry.credential.projectId === selector.value;
	}
}

/**
 * Resolve which provider a bare (unqualified) `/credential <selector>`
 * targets. Prefers the current session model's provider when it actually has
 * a matching OAuth row (the common case: switching among a provider's own
 * accounts while that provider is active). Falls back to scanning every
 * provider's stored OAuth rows for a unique match, so `/credential
 * email:me@example.com` still works when the selector uniquely matches a
 * provider other than the active one. Ambiguous or absent matches return an
 * explanatory string instead of a provider id.
 */
function inferProvider(
	runtime: SlashCommandRuntime,
	oauthRows: AuthCredentialSnapshotEntry[],
	selector: AuthCredentialSelector,
	selectorRaw: string,
): { provider: string } | { error: string } {
	const currentProvider = runtime.session.model?.provider;
	if (
		currentProvider &&
		oauthRows.some(entry => entry.provider === currentProvider && selectorMatchesRow(selector, entry))
	) {
		return { provider: currentProvider };
	}
	const matchingProviders = [
		...new Set(oauthRows.filter(entry => selectorMatchesRow(selector, entry)).map(entry => entry.provider)),
	];
	if (matchingProviders.length === 1) return { provider: matchingProviders[0]! };
	if (oauthRows.length === 0) {
		return { error: "No provider has any stored OAuth credentials to switch between." };
	}
	if (matchingProviders.length === 0) {
		return { error: `No stored OAuth credential matches ${selector.kind}:${selector.value}.` };
	}
	return {
		error: `"${selectorRaw}" is ambiguous across providers (${matchingProviders.join(", ")}). Use provider/${selectorRaw}.`,
	};
}

/**
 * List every provider's stored OAuth accounts, marking which row each
 * currently-tracked session is using.
 */
export async function buildCredentialListText(runtime: SlashCommandRuntime): Promise<string> {
	const authStorage = runtime.session.modelRegistry.authStorage;
	const snapshot = authStorage.exportSnapshot();
	const oauthRows = snapshot.credentials.filter(entry => entry.credential.type === "oauth");
	if (oauthRows.length === 0) {
		return "No stored OAuth credentials. Use /login <provider> to add one.";
	}
	const grouped = new Map<string, AuthCredentialSnapshotEntry[]>();
	for (const entry of oauthRows) {
		const rows = grouped.get(entry.provider) ?? [];
		rows.push(entry);
		grouped.set(entry.provider, rows);
	}
	const lines = ["Stored accounts (/credential <selector> to switch this session):"];
	for (const [provider, rows] of [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))) {
		lines.push("", formatProviderName(provider));
		const activeRowId = authStorage.getSessionCredentialRowId(provider, runtime.session.credentialSessionId);
		for (const entry of rows) {
			const active = entry.id === activeRowId ? " (active this session)" : "";
			lines.push(`- ${describeCredentialRow(entry)}${active}`);
		}
	}
	return lines.join("\n");
}

/**
 * Switch the running session's stored OAuth credential for a provider,
 * independent of quota state. Returns the confirmation/error text to show
 * the user; never throws.
 */
export async function switchSessionCredentialCommand(runtime: SlashCommandRuntime, args: string): Promise<string> {
	const trimmed = args.trim();
	if (!trimmed) return await buildCredentialListText(runtime);

	let parsed: ReturnType<typeof parseCliCredentialSelector>;
	try {
		parsed = parseCliCredentialSelector(trimmed);
	} catch {
		return `Invalid selector "${trimmed}". Use email:name@example.com, id:15, account:<id>, project:<id>, or provider/<selector>.`;
	}

	const authStorage = runtime.session.modelRegistry.authStorage;
	const snapshot = authStorage.exportSnapshot();
	const oauthRows = snapshot.credentials.filter(entry => entry.credential.type === "oauth");

	let provider = parsed.provider;
	if (!provider) {
		const inferred = inferProvider(runtime, oauthRows, parsed.selector, trimmed);
		if ("error" in inferred) return inferred.error;
		provider = inferred.provider;
	}

	try {
		authStorage.switchSessionCredential(provider, runtime.session.credentialSessionId, parsed.selector);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}

	const rowId = authStorage.getSessionCredentialRowId(provider, runtime.session.credentialSessionId);
	const matchedRow = oauthRows.find(entry => entry.id === rowId);
	const label = matchedRow ? describeCredentialRow(matchedRow) : `${provider} (${trimmed})`;
	return `Switched this session to ${label}. Takes effect on the next request to ${formatProviderName(provider)}.`;
}
