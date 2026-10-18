/**
 * Handlers for the sole account-management CLI namespace (`gjc accounts`).
 *
 * This surface deliberately consumes AuthStorage's payload-free inventory APIs.
 * Credential payloads are never rendered or copied into settings; persistent pins
 * are written as canonical `id:<row-id>` selectors only.
 */
import {
	type AuthCredentialSelector,
	type AuthStorage,
	type CredentialInventoryRecord,
	type CredentialRemovalTarget,
	isSqliteCorruptionError,
	OAuthCredentialSelectorError,
	type OAuthPinTarget,
	resolveOAuthStorageProvider,
	selectOrganizationMatches,
} from "@gajae-code/ai/core";
import { getAgentDir } from "@gajae-code/utils";
import { ModelRegistry } from "../config/model-registry";
import { type RawSettings, Settings, type SettingsAtomicPatch } from "../config/settings";
import { discoverAuthStorage } from "../sdk/session";
import {
	buildAccountInventorySnapshot,
	checkAccountInventory,
	clearPersistentPinForRemovedRows,
} from "../session/account-inventory";
import { CREDENTIAL_STORE_UNREADABLE_MESSAGE } from "../session/credential-store-errors";
import {
	type CredentialPreferenceEntryValue,
	isValidCredentialPreferenceCap,
	parsePreferenceAccount,
	resolveStartupAuthConfig,
	type StartupAuthConfigSnapshot,
} from "../session/startup-auth-config";

export const ACCOUNTS_ACTIONS = ["list", "check", "pin", "prefer", "logout"] as const;
export type AccountsAction = (typeof ACCOUNTS_ACTIONS)[number];

export interface AccountsCommandArgs {
	action: AccountsAction;
	provider?: string;
	selectors?: readonly string[];
	flags: {
		json?: boolean;
		persistent?: boolean;
		clear?: boolean;
		account?: string;
		all?: boolean;
	};
}

class AccountsCommandError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AccountsCommandError";
	}
}
export function toAccountsCommandError(error: unknown): AccountsCommandError | undefined {
	if (isSqliteCorruptionError(error)) return new AccountsCommandError(CREDENTIAL_STORE_UNREADABLE_MESSAGE);
	if (error instanceof OAuthCredentialSelectorError) return new AccountsCommandError(error.message);
	return undefined;
}

function writeJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeText(lines: readonly string[]): void {
	process.stdout.write(`${lines.join("\n")}\n`);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function cleanReason(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	let reason = value instanceof Error ? value.message : String(value);
	reason = reason.replace(/bearer\s+[^\s,;]+/gi, "Bearer [redacted]");
	reason = reason.replace(/(api[_-]?key|token|secret|authorization)[=:]\s*[^\s,;]+/gi, "$1=[redacted]");
	reason = reason.replace(/[\r\n\t ]+/g, " ").trim();
	if (reason.length > 256) reason = `${reason.slice(0, 253)}...`;
	return reason || undefined;
}

function canonicalProvider(provider: string | undefined): string {
	const value = provider?.trim();
	if (!value) throw new AccountsCommandError("A provider is required.");
	if (/[\u0000-\u001f\u007f]/u.test(value))
		throw new AccountsCommandError("Provider contains invalid control characters.");
	return resolveOAuthStorageProvider(value);
}

function selectorFromInput(raw: string | undefined): AuthCredentialSelector {
	const value = raw?.trim() ?? "";
	if (/^id:[1-9]\d*$/.test(value)) return { kind: "id", value: value.slice(3) };
	if (/^email:[^@\s]+@[^@\s]+$/.test(value)) return { kind: "email", value: value.slice(6) };
	if (/^account:\S+$/.test(value)) return { kind: "account", value: value.slice(8) };
	if (/^org:\S/.test(value)) return { kind: "org", value: value.slice(4).trim() };
	if (/^[^@\s]+@[^@\s]+$/.test(value)) return { kind: "email", value };
	throw new AccountsCommandError(
		"Pin target must be a bare email or an id:<row-id>, email:<email>, account:<account-id>, or org:<organization id or name> selector.",
	);
}

function inventoryIdentity(row: CredentialInventoryRecord): string | undefined {
	return typeof row.identityLabel === "string" ? row.identityLabel : undefined;
}

function formatCandidate(row: CredentialInventoryRecord): string {
	const identity = inventoryIdentity(row) ?? "(no identity)";
	return `  id=${row.id} ${identity}${row.disabled ? " [disabled]" : ""}`;
}

async function withAuthStorageAndModels<T>(
	callback: (storage: AuthStorage, modelRegistry: ModelRegistry, startupAuth: StartupAuthConfigSnapshot) => Promise<T>,
): Promise<T> {
	const startupAuth = await resolveStartupAuthConfig();
	const storage = await discoverAuthStorage(getAgentDir(), startupAuth);
	const modelRegistry = new ModelRegistry(storage);
	try {
		await modelRegistry.refresh("offline");
		return await callback(storage, modelRegistry, startupAuth);
	} finally {
		storage.close();
	}
}

async function runList(flags: AccountsCommandArgs["flags"]): Promise<void> {
	await withAuthStorageAndModels(async (storage, modelRegistry) => {
		const snapshot = buildAccountInventorySnapshot({ authStorage: storage, modelRegistry });
		const accounts = snapshot.rows;
		if (flags.json) {
			writeJson({ ok: true, generatedAt: snapshot.generatedAt, generation: snapshot.generation, accounts });
			return;
		}
		if (accounts.length === 0) {
			writeText(["No stored accounts or configured API-key sources."]);
			return;
		}
		writeText(
			accounts.map(account => {
				const identity = account.identityLabel ?? "(no identity)";
				const usage = account.usage?.freshness ?? "unknown";
				const health = account.health.status;
				return `${account.provider}\tid=${account.id}\t${account.credentialKind}\t${identity}\t${account.source}\t${
					account.disabled ? "disabled" : "active"
				}\thealth=${health}\tusage=${usage}`;
			}),
		);
	});
}

async function runCheck(providerArg: string | undefined, flags: AccountsCommandArgs["flags"]): Promise<void> {
	const provider = providerArg ? canonicalProvider(providerArg) : undefined;
	await withAuthStorageAndModels(async (storage, modelRegistry) => {
		const snapshot = await checkAccountInventory({
			authStorage: storage,
			modelRegistry,
			provider,
		});
		const checks = snapshot.rows
			.filter(row => provider === undefined || row.provider === provider)
			.map(row => ({
				id: row.id,
				provider: row.provider,
				kind: row.credentialKind,
				source: row.source,
				...(row.identityLabel ? { identity: row.identityLabel } : {}),
				ok: row.health.status === "ok" ? true : row.health.status === "failed" ? false : null,
				status: row.health.status === "ok" ? "ok" : row.health.status === "failed" ? "failed" : "unknown",
				...(cleanReason(row.health.reason) ? { reason: cleanReason(row.health.reason) } : {}),
			}));
		if (flags.json) {
			writeJson({ ok: true, ...(provider ? { provider } : {}), checks });
		} else if (checks.length === 0) {
			writeText([provider ? `No account sources for ${provider}.` : "No account sources."]);
		} else {
			writeText(
				checks.map(check => {
					const identity = check.identity ?? "(no identity)";
					const reason = check.reason ? ` — ${check.reason}` : "";
					return `${check.provider}\tid=${check.id}\t${check.kind}\t${check.source}\t${identity}\t${check.status}${reason}`;
				}),
			);
		}
		if (checks.some(check => check.ok === false)) process.exitCode = 1;
	});
}

function assertPersistent(flags: AccountsCommandArgs["flags"]): void {
	if (!flags.persistent) {
		throw new AccountsCommandError("Persistent account pinning requires --persistent.");
	}
}

function pinsFromCurrent(current: Readonly<RawSettings>): Record<string, string> {
	const auth = current.auth;
	if (auth === undefined) return {};
	const authRecord = asRecord(auth);
	if (!authRecord) throw new AccountsCommandError("Global auth configuration is malformed; no pin was written.");
	const rawPins = authRecord.credentialPins;
	if (rawPins === undefined) return {};
	const pins = asRecord(rawPins);
	if (!pins || Object.values(pins).some(value => typeof value !== "string")) {
		throw new AccountsCommandError("Global auth.credentialPins is malformed; no pin was written.");
	}
	return Object.fromEntries(Object.entries(pins).map(([key, value]) => [key, String(value).trim()]));
}

async function writePersistentPin(
	provider: string,
	selector: string | undefined,
	clear: boolean,
	credentialStoreIdentity?: string,
): Promise<void> {
	const settings = await Settings.init();
	await settings.commitAtomicBatchWithCurrent(current => {
		const pins = pinsFromCurrent(current);
		const currentAuth = asRecord(current.auth);
		const existingStoreIdentity =
			typeof currentAuth?.credentialPinStoreIdentity === "string"
				? currentAuth.credentialPinStoreIdentity.trim()
				: undefined;
		if (
			Object.values(pins).some(value => value.startsWith("id:")) &&
			credentialStoreIdentity &&
			existingStoreIdentity !== credentialStoreIdentity
		) {
			for (const [pinnedProvider, pinnedSelector] of Object.entries(pins)) {
				if (pinnedSelector.startsWith("id:")) delete pins[pinnedProvider];
			}
		}
		if (clear) delete pins[provider];
		else if (selector) pins[provider] = selector;
		const patches: SettingsAtomicPatch[] = [{ path: "auth.credentialPins", op: "set", value: pins }];
		const hasNumericPins = Object.values(pins).some(value => value.startsWith("id:"));
		if (hasNumericPins) {
			if (credentialStoreIdentity && (!existingStoreIdentity || existingStoreIdentity === credentialStoreIdentity)) {
				patches.push({ path: "auth.credentialPinStoreIdentity", op: "set", value: credentialStoreIdentity });
			} else if (!clear) {
				throw new AccountsCommandError(
					"Numeric persistent pins require a credential-store identity; no pin was written.",
				);
			}
		} else {
			patches.push({ path: "auth.credentialPinStoreIdentity", op: "unset" });
		}
		return patches;
	});
}

async function runPin(
	providerArg: string | undefined,
	selectorArg: string | undefined,
	flags: AccountsCommandArgs["flags"],
): Promise<void> {
	assertPersistent(flags);
	const provider = canonicalProvider(providerArg);
	if (flags.clear && selectorArg) {
		throw new AccountsCommandError("Use either a pin selector or --clear, not both.");
	}
	if (!flags.clear && !selectorArg) {
		throw new AccountsCommandError("Pin requires a selector, or use --clear to remove the persistent pin.");
	}
	if (flags.clear) {
		await writePersistentPin(provider, undefined, true);
		if (flags.json) writeJson({ ok: true, provider, cleared: true });
		else writeText([`Cleared persistent account pin for ${provider}.`]);
		return;
	}

	const selector = selectorFromInput(selectorArg);
	await withAuthStorageAndModels(async (storage, modelRegistry, startupAuth) => {
		if (
			!modelRegistry.getConfiguredProviderIds().includes(provider) &&
			modelRegistry.getAll().every(model => model.provider !== provider)
		) {
			throw new AccountsCommandError(`Provider ${provider} is not configured; no pin was written.`);
		}
		let target: OAuthPinTarget;
		try {
			target = storage.resolveOAuthPinTarget(provider, selector);
		} catch (error) {
			throw toAccountsCommandError(error) ?? error;
		}
		const canonicalSelector = `${target.canonicalSelector.kind}:${target.canonicalSelector.value}`;
		await writePersistentPin(provider, canonicalSelector, false, startupAuth.credentialStoreIdentity);
		if (flags.json) writeJson({ ok: true, provider, selector: canonicalSelector });
		else writeText([`Pinned ${provider} to ${canonicalSelector}.`]);
	});
}

/**
 * Split `<account>=<percent>` into the account and its usage cap. The cap follows the whole account, so an `=` before
 * the last `@` belongs to an email local part (`user=2@example.com`), and a suffix that does not start with a digit is
 * part of the account (account ids may end in `=`); a digit-led suffix must be a valid cap.
 */
function parsePreferArgument(raw: string): { account: string; cap: number | undefined } {
	const separator = raw.lastIndexOf("=");
	const rawCap = separator < 0 || separator < raw.lastIndexOf("@") ? "" : raw.slice(separator + 1).trim();
	if (!/^\d/.test(rawCap)) return { account: raw.trim(), cap: undefined };
	const cap = /^\d+(\.\d+)?$/.test(rawCap) ? Number(rawCap) : Number.NaN;
	if (!isValidCredentialPreferenceCap(cap)) {
		throw new AccountsCommandError(
			`Usage cap in ${JSON.stringify(raw)} must be a percent above 0 and at most 100, e.g. me@example.com=75; no preference was written.`,
		);
	}
	return { account: raw.slice(0, separator).trim(), cap };
}

/**
 * Portable config text for a resolved OAuth row: its email, else its account id, whichever no other OAuth row of the
 * provider shares. Numeric row ids are never persisted as preferences; a row with neither unique value is refused.
 * Each candidate text is written only when {@link parsePreferenceAccount} reads it back as the same selector, so a
 * successful write neither fails the next startup nor retargets the row: the email is written bare when that
 * round-trips, else as `email:<address>` (an address such as `account:team@example.com` would otherwise parse as an
 * account id, and `email:team@example.com` would lose its prefix).
 */
function portablePreferenceAccount(
	row: CredentialInventoryRecord,
	providerRows: readonly CredentialInventoryRecord[],
): string | undefined {
	const oauthRows = providerRows.filter(other => other.credentialKind === "oauth");
	const email = row.email?.trim().toLowerCase();
	if (email && oauthRows.filter(other => other.email?.trim().toLowerCase() === email).length === 1) {
		const selector: AuthCredentialSelector = { kind: "email", value: row.email!.trim() };
		const written = [selector.value, `email:${selector.value}`].find(text => readsBackAs(text, selector));
		if (written) return written;
	}
	const accountId = row.accountId?.trim();
	if (accountId && oauthRows.filter(other => other.accountId?.trim() === accountId).length === 1) {
		const written = `account:${accountId}`;
		if (readsBackAs(written, { kind: "account", value: accountId })) return written;
	}
	return undefined;
}

/** Whether startup parses `text` as exactly `selector`, kind and value. */
function readsBackAs(text: string, selector: AuthCredentialSelector): boolean {
	const parsed = parsePreferenceAccount(text);
	return parsed?.kind === selector.kind && parsed.value === selector.value;
}

async function writePersistentPreferences(
	provider: string,
	entries: readonly CredentialPreferenceEntryValue[] | undefined,
): Promise<void> {
	const settings = await Settings.init();
	await settings.commitAtomicBatchWithCurrent(current => {
		const currentAuth = current.auth === undefined ? {} : asRecord(current.auth);
		const rawPreferences = currentAuth?.credentialPreferences;
		const preferences = rawPreferences === undefined ? {} : asRecord(rawPreferences);
		if (!currentAuth || !preferences) {
			throw new AccountsCommandError("Global auth.credentialPreferences is malformed; no preference was written.");
		}
		const next: Record<string, unknown> = { ...preferences };
		if (entries) next[provider] = entries;
		else delete next[provider];
		return [{ path: "auth.credentialPreferences", op: "set", value: next }];
	});
}

async function runPrefer(
	providerArg: string | undefined,
	accountArgs: readonly string[] | undefined,
	flags: AccountsCommandArgs["flags"],
): Promise<void> {
	const provider = canonicalProvider(providerArg);
	const accounts = accountArgs ?? [];
	if (flags.clear && accounts.length > 0) {
		throw new AccountsCommandError("Use either preferred accounts or --clear, not both.");
	}
	if (!flags.clear && accounts.length === 0) {
		throw new AccountsCommandError(
			"Prefer requires one or more accounts in order (e.g. me@example.com shared@example.com=75), or --clear.",
		);
	}
	if (flags.clear) {
		await writePersistentPreferences(provider, undefined);
		if (flags.json) writeJson({ ok: true, provider, cleared: true });
		else writeText([`Cleared preferred accounts for ${provider}; selection uses normal ranking.`]);
		return;
	}

	const requested = accounts.map(parsePreferArgument);
	await withAuthStorageAndModels(async (storage, modelRegistry, startupAuth) => {
		if (
			!modelRegistry.getConfiguredProviderIds().includes(provider) &&
			modelRegistry.getAll().every(model => model.provider !== provider)
		) {
			throw new AccountsCommandError(`Provider ${provider} is not configured; no preference was written.`);
		}
		const providerRows = storage.listCredentialInventory(provider);
		const seenIds = new Set<number>();
		const resolved = requested.map(({ account, cap }) => {
			let target: OAuthPinTarget;
			try {
				target = storage.resolveOAuthPinTarget(provider, selectorFromInput(account));
			} catch (error) {
				throw toAccountsCommandError(error) ?? error;
			}
			if (seenIds.has(target.credentialId)) {
				throw new AccountsCommandError(`${account} is listed more than once; no preference was written.`);
			}
			seenIds.add(target.credentialId);
			const row = providerRows.find(candidate => candidate.id === target.credentialId);
			const portable = row ? portablePreferenceAccount(row, providerRows) : undefined;
			if (!portable) {
				throw new AccountsCommandError(
					`${account} has no unique email or account id to store as a preference; no preference was written.`,
				);
			}
			return { account: portable, cap: cap === 100 ? undefined : cap };
		});
		const entries: CredentialPreferenceEntryValue[] = resolved.map(({ account, cap }) =>
			cap === undefined ? account : { [account]: cap },
		);
		await writePersistentPreferences(provider, entries);
		if (flags.json) {
			writeJson({ ok: true, provider, preferences: entries });
			return;
		}
		writeText([
			`Preferred accounts for ${provider}, tried in order:`,
			...resolved.map(
				({ account, cap }, index) =>
					`  ${index + 1}. ${account}${cap === undefined ? " (until rate-limited)" : ` (until ${cap}% used)`}`,
			),
			`Then: remaining accounts by ${startupAuth.credentialRankingMode} ranking. Takes effect for new sessions.`,
		]);
	});
}

function accountMatches(row: CredentialInventoryRecord, rawAccount: string): boolean {
	const value = rawAccount.trim();
	if (value.length === 0) return false;
	if (/^[1-9]\d*$/.test(value) && row.id === Number(value)) return true;
	if (/^id:[1-9]\d*$/i.test(value) && row.id === Number(value.slice(3))) return true;
	// Labels carry the organization name, so a bare email matches every organization of that account.
	if (row.email?.toLowerCase() === value.toLowerCase()) return true;
	const identity = inventoryIdentity(row);
	return identity?.toLowerCase() === value.toLowerCase();
}

/**
 * Rows a `--account` value designates. `org:` prefers an exact organization-id match over display-name
 * matches; more than one result is reported as ambiguous by the caller, never resolved by guessing.
 */
function selectLogoutTargets<T extends { row: CredentialInventoryRecord }>(
	targets: readonly T[],
	rawAccount: string,
): T[] {
	const value = rawAccount.trim();
	if (/^org:/i.test(value)) return selectOrganizationMatches(targets, value.slice(4), target => target.row);
	return targets.filter(target => accountMatches(target.row, value));
}

function removalCandidates(
	inventory: readonly CredentialInventoryRecord[],
	targets: readonly CredentialRemovalTarget[],
): Array<{ row: CredentialInventoryRecord; target: CredentialRemovalTarget }> {
	const targetById = new Map(targets.map(target => [target.id, target]));
	return inventory
		.map(row => ({ row, target: targetById.get(row.id) }))
		.filter((entry): entry is { row: CredentialInventoryRecord; target: CredentialRemovalTarget } => !!entry.target);
}

function throwLogoutResolutionError(
	provider: string,
	account: string | undefined,
	candidates: readonly { row: CredentialInventoryRecord; target: CredentialRemovalTarget }[],
): never {
	const lines =
		candidates.length > 0
			? ["Safe candidates:", ...candidates.map(candidate => formatCandidate(candidate.row))]
			: ["No removable credentials found."];
	const prefix = account
		? `Account ${JSON.stringify(account)} for ${provider} was missing or ambiguous.`
		: `No removable stored credentials found for ${provider}.`;
	throw new AccountsCommandError(`${prefix} No credentials were removed.\n${lines.join("\n")}`);
}

async function runLogout(providerArg: string | undefined, flags: AccountsCommandArgs["flags"]): Promise<void> {
	const provider = canonicalProvider(providerArg);
	if ((flags.all ? 1 : 0) + (flags.account ? 1 : 0) !== 1) {
		throw new AccountsCommandError("Logout requires exactly one of --account <id|email> or --all.");
	}
	const startupAuth = await resolveStartupAuthConfig();
	if (startupAuth.broker) {
		throw new AccountsCommandError(
			"`gjc accounts logout` only mutates local credentials. A broker/gateway is configured; run logout on the broker host with `gjc auth-broker` or unset the broker configuration. No credentials were removed.",
		);
	}
	const storage = await discoverAuthStorage(getAgentDir(), startupAuth);
	try {
		const inventory = storage.listCredentialInventory(provider);
		const targets = removalCandidates(inventory, storage.listCredentialRemovalTargets(provider));
		const selected = flags.all ? targets : selectLogoutTargets(targets, flags.account ?? "");
		if (selected.length !== 1 && !flags.all) throwLogoutResolutionError(provider, flags.account, targets);
		if (selected.length === 0) throwLogoutResolutionError(provider, flags.account, targets);
		const result = storage.removeAuthCredentialsHard(
			provider,
			selected.map(candidate => candidate.target),
		);
		if (result.kind !== "removed") {
			throw new AccountsCommandError(
				`Account inventory changed before logout; no credentials were removed. Retry and choose from current candidates (ids: ${result.currentIds.join(", ") || "none"}).`,
			);
		}
		const settings = await Settings.init();
		await clearPersistentPinForRemovedRows(settings, provider, inventory, result.ids);
		if (flags.json) writeJson({ ok: true, provider, removedIds: [...result.ids] });
		else
			writeText([
				`Removed ${result.ids.length} stored credential${result.ids.length === 1 ? "" : "s"} from ${provider}.`,
			]);
	} finally {
		storage.close();
	}
}

function writeJsonFailure(error: unknown): void {
	// Machine contract: exactly one JSON document on stdout, never secrets/stacks.
	if (error instanceof AccountsCommandError) {
		writeJson({ ok: false, error: { code: "accounts-error", message: cleanReason(error) ?? "Command failed." } });
		return;
	}
	writeJson({
		ok: false,
		error: { code: "internal-error", message: "Accounts command failed; see stderr for diagnostics." },
	});
}

export async function runAccountsCommand(cmd: AccountsCommandArgs): Promise<void> {
	try {
		switch (cmd.action) {
			case "list":
				await runList(cmd.flags);
				return;
			case "check":
				await runCheck(cmd.provider, cmd.flags);
				return;
			case "pin":
				if ((cmd.selectors?.length ?? 0) > 1) {
					throw new AccountsCommandError("Pin takes one selector; use `gjc accounts prefer` for an ordered list.");
				}
				await runPin(cmd.provider, cmd.selectors?.[0], cmd.flags);
				return;
			case "prefer":
				await runPrefer(cmd.provider, cmd.selectors, cmd.flags);
				return;
			case "logout":
				await runLogout(cmd.provider, cmd.flags);
				return;
			default: {
				const exhaustive: never = cmd.action;
				throw new AccountsCommandError(`Unknown accounts action: ${String(exhaustive)}`);
			}
		}
	} catch (error) {
		const normalizedError = toAccountsCommandError(error) ?? error;
		if (cmd.flags.json) {
			if (!(normalizedError instanceof AccountsCommandError)) {
				process.stderr.write(`accounts command failed: ${cleanReason(normalizedError) ?? "Command failed."}\n`);
			}
			process.exitCode = 1;
			writeJsonFailure(normalizedError);
			return;
		}
		if (normalizedError instanceof AccountsCommandError) {
			process.stderr.write(`${normalizedError.message}\n`);
			process.exitCode = 1;
			return;
		}
		throw error;
	}
}

export { AccountsCommandError };
