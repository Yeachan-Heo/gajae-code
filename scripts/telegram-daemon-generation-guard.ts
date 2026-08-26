#!/usr/bin/env bun
import { $ } from "bun";
import { parse } from "@babel/parser";
import manifest from "./telegram-daemon-generation-manifest.json" with { type: "json" };
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const root = path.join(import.meta.dir, "..");
const SHA = /^[0-9a-f]{40}$/i;
export const GUARD_CONTRACT_VERSION = 52;
const telegramContract = "packages/coding-agent/src/sdk/bus/telegram-daemon-contract.ts";
const telegramDaemon = "packages/coding-agent/src/sdk/bus/telegram-daemon.ts";
const telegramControl = "packages/coding-agent/src/sdk/bus/telegram-daemon-control.ts";
const telegramReference = "packages/coding-agent/src/sdk/bus/telegram-reference.ts";
const richRender = "packages/coding-agent/src/sdk/bus/rich-render.ts";
const sdkHost = "packages/coding-agent/src/sdk/host/host.ts";

const chatControl = "packages/coding-agent/src/sdk/bus/chat-daemon-control.ts";
const chatCli = "packages/coding-agent/src/sdk/bus/chat-daemon-cli.ts";
const sdkDiscovery = "packages/coding-agent/src/sdk/client/discovery.ts";
const sessionRouter = "packages/coding-agent/src/sdk/router/session-router.ts";
const config = "packages/coding-agent/src/sdk/bus/config.ts";
const busIndex = "packages/coding-agent/src/sdk/bus/index.ts";
const guardScript = "scripts/telegram-daemon-generation-guard.ts";
const manifestScript = "scripts/telegram-daemon-generation-manifest.json";

/**
 * The topic-registry durable-authority snapshot. The guard's deterministic
 * repair path syncs this fixture's generation pin whenever the Telegram
 * generation changes, so a valid bump can never leave the assertion stale
 * while the exact pin still fails closed on accidental drift.
 */
const topicRegistryFixture = "packages/coding-agent/test/notifications-topic-registry.test.ts";
const nativeAuthorityDeclarations = {
	"crates/pi-natives/src/path_identity.rs": [
		"retain_broker_publication",
		"canonical_existing_directory_identity",
		"apply_owner_only_path_security",
		"verify_owner_only_path_security",
		"verify_owner_only_path_security_expected",
		"repair_owner_only_path_security_expected",
		"apply_owner_only_fd_security",
		"verify_owner_only_fd_security",
		"exact_unlink",
		"exact_restore",
		"rename_no_replace_path",
		"rename_path_no_replace_exact",
		"retain_substituted_publication",
		"snapshot_directory_tree",
		"exact_remove_directory_tree",
	],
	"crates/pi-natives/src/ps.rs": ["napi impl Process"],
	"crates/pi-shell/src/process.rs": ["impl Process", "kill_process_group", "current_descendant_pids", "add_new_descendants"],
	"crates/pi-shell/src/shell.rs": ["impl Shell", "run_shell_session", "run_shell_oneshot", "run_shell_oneshot_streams", "run_shell_command", "run_shell_command_streams", "impl builtins::Command for TimeoutCommand"],
	"crates/brush-core-vendored/src/commands.rs": ["execute_external_command"],
	"packages/natives/native/index.d.ts": ["Process"],
	"packages/coding-agent/src/sdk/broker/process-incarnation.ts": ["isProcessIncarnation", "processIncarnation"],
} as const;
const nativeAuthorityFamilies = Object.fromEntries(
	Object.keys(nativeAuthorityDeclarations).map(source => [source, ["telegram", "discord", "slack"]]),
) as unknown as Record<keyof typeof nativeAuthorityDeclarations, readonly Family[]>;
const nativeAuthoritySources = Object.keys(nativeAuthorityDeclarations) as Array<keyof typeof nativeAuthorityDeclarations>;

type Family = "telegram" | "discord" | "slack";
type Inventory = Readonly<Record<Family, Readonly<Record<string, readonly string[]>>>>;
type Declaration = { text: string; canonical: string; valid: boolean } | undefined;
type GuardManifest = {
	contractVersion: number;
	inventory: Inventory;
	digests: Readonly<Record<string, string>>;
	nativeAuthoritySha256: Readonly<Record<(typeof nativeAuthoritySources)[number], string>>;
};



/**
 * This is a deliberately small, exact lifecycle contract. Per-session endpoint
 * generation counters remain separate, while daemon-owned endpoint discovery is
 * protected because old owners must be replaced when that admission path changes.
 */
export const protectedInventory = manifest.inventory as Inventory;
const PROTECTED_INVENTORY_SHA256 = "2e76706a9ebe0362f8a48c191677f0ca682ea6d4a39b29fafedabce8e677c118";

/** Transition-marker generations fence every daemon lifecycle mutation. */
export const TRANSITION_TOKEN_PROTECTED_DECLARATIONS = [
	"DaemonTransitionLock",
	"daemonTransitionLockIsHeld",
	"releaseDaemonTransitionLock",
	"acquireDaemonTransitionLock",
	"NATIVE_PATH_IDENTITY_CONTRACT_VERSION",
	"exactUnlinkNotificationFile",
	"isDaemonTransitionLock",
	"readTransitionMarker",
	"transitionMarkerMatchesLock",
	"detachTransitionMarker",
] as const;

/** Telegram ownership-lock handoffs must remain fenced and reversible. */
export const TELEGRAM_OWNER_LOCK_PROTECTED_DECLARATIONS = [
	"writeJsonAtomic",
	"ownershipLockMatchesState",
	"ownershipLockMatchesMetadata",
	"ownershipLockIsReclaimable",
	"isParentDaemonState",
	"isGenerationAbsentParentDaemonState",
	"isGeneration3ReleaseDaemonState",
	"isLegacyParentDaemonState",
	"legacyOwnershipLockMatchesHandoffState",
	"historicalStateSerializer",
	"legacyParentHandoffDecision",
	"unlinkOwnershipLockExactly",
	"rebindOwnershipLock",
	"rollbackOwnershipLockRebind",
	"retireProvisionalDaemonOwnership",
	"confirmTelegramDaemonSpawn",
] as const;

/** Telegram process authority must distinguish cooperative and hard termination. */
export const TELEGRAM_PROCESS_AUTHORITY_PROTECTED_DECLARATIONS = ["DaemonProcessReference", "defaultProcessReference", "signalCapturedOwner"] as const;


/** Telegram provider authentication, supervisor lifecycle, and Router attachment entry stay generation-fenced. */
export const TELEGRAM_LIFECYCLE_PROTECTED_DECLARATIONS = [
	"validBotToken",
	"requestStop",
	"ensureTelegramDaemonRunningDetailed",
	"TelegramNotificationDaemon.#socketLease",
	"run",
] as const;
/** Callback receipt activation and revocation define durable reply authority. */
export const TELEGRAM_CALLBACK_RECEIPT_PROTECTED_DECLARATIONS = [
	"TelegramNotificationDaemon.#dropSession",
	"TelegramUpdatePoller",
	"TelegramBotTransport",
	"fetchWithRetry",
	"isTransientNetworkError",
	"TelegramEffectSupervisor",
	"callBotApi",
	"createBotApiAdapter",
	"createBotApiPipeline",
	"writeJsonAtomic",
	"syncTelegramFile",
	"syncTelegramDirectory",
	"isUnsupportedTelegramDirectoryBarrier",
	"TelegramNotificationDaemon.#authorizeLease",
	"TelegramNotificationDaemon.#leaseAllows",
	"TelegramNotificationDaemon.#leaseTokenAllows",
	"TelegramNotificationDaemon.#socketLease",
	"TelegramNotificationDaemon.#revokeCallbackAlias",
	"TelegramNotificationDaemon.#stageCallbackActivation",
	"topicAuthorityLeaseFromRegistry",
	"topicLeaseIsCurrent",
	"reissuePendingAction",
] as const;

/** Chat daemon CLI helpers determine whether a prior owner can be replaced. */
export const CHAT_CLI_PROTECTED_DECLARATIONS = ["defaultPidAlive", "loadConfig", "ownerPid"] as const;

/** Provider credentials configure daemon ownership and must stay family-scoped. */
export const CHAT_CONFIG_PROTECTED_DECLARATIONS = {
	discord: [
		"getNotificationConfig",
		"notificationConfigFromFile",
		"resolveNotificationProvider",
		"isDiscordComplete",
		"isProviderEffectivelyEnabled",
		"tokenFingerprint",
	],
	slack: [
		"getNotificationConfig",
		"notificationConfigFromFile",
		"resolveNotificationProvider",
		"isSlackComplete",
		"isProviderEffectivelyEnabled",
		"tokenFingerprint",
	],
} as const;

/** Chat-only endpoint isolation must replace daemon owners that cannot discover it. */
export const CHAT_ENDPOINT_DISCOVERY_PROTECTED_DECLARATIONS = {
	[sessionRouter]: [
		"SessionRouter.#attach",
		"SessionRouter.#createAttachedClient",
		"SessionRouter.#publishAttachment",
	],
	[sdkDiscovery]: ["readSdkSessionEndpoint"],
} as const;

/** Telegram tool-activity defaults and delivery admission must stay generation-fenced. */
export const TELEGRAM_TOOL_ACTIVITY_PROTECTED_DECLARATIONS = {
	[config]: ["parseNotificationSettingsSnapshot"],
	[sdkHost]: ["TOOL_ACTIVITY_CAPABILITY"],
	[telegramDaemon]: [
		"TOOL_ACTIVITY_CAPABILITY",
		"LEGACY_TOOL_ACTIVITY_CAPABILITY",
		"negotiateToolActivityCapability",
		"toolActivityOwner",
		"toolActivityAuthorityIsCurrent",
		"toolActivityDeliveryIsCurrent",
		"handleSessionMessage",
		"processTelegramUpdate",
	],
} as const;

/** Topic admission must preserve session eligibility from identity production through registry load. */
export const TELEGRAM_TOPIC_ADMISSION_PROTECTED_DECLARATIONS = {
	[config]: ["isTelegramSessionEligible"],
	[busIndex]: ["buildIdentity", "createNotificationsExtension"],
	[telegramDaemon]: [
		"TelegramNotificationDaemon.#topicAdmissionAllows",
		"TelegramNotificationDaemon.#rejectTopicAdmission",
		"loadTopics",
	],
} as const;
/** Callback recovery receipt and routing primitives must remain generation-fenced. */
export const TELEGRAM_CALLBACK_RECOVERY_PROTECTED_DECLARATIONS = {
	[telegramDaemon]: [
		"handleTelegramUpdate",
		"loadAliases",
		"persistAliases",
		"revokeCallbackAliases",
	],
	[telegramReference]: ["createAliasTable", "routeInboundUpdate"],
	[richRender]: ["deliverRichActionWithFallback"],
} as const;

function validateTelegramCallbackRecoveryInventory(inventory: Inventory): void {
	for (const [file, required] of Object.entries(TELEGRAM_CALLBACK_RECOVERY_PROTECTED_DECLARATIONS)) {
		const symbols = inventory.telegram[file];
		if (!symbols || required.some(symbol => !symbols.includes(symbol)))
			throw new Error("telegram-daemon-generation-guard: Telegram callback recovery primitives must be protected by the Telegram generation contract");
	}
}

/** Shutdown must fence new session work and await admitted handlers before durable release. */
export const TELEGRAM_SHUTDOWN_DRAIN_PROTECTED_DECLARATIONS = [
	"TelegramEffectSupervisor",
	"handleSessionMessage",
	"run",
] as const;

/** Chat credential, provenance, and persistence are shared takeover authority. */
export const CHAT_OWNER_LOCK_PROTECTED_DECLARATIONS = [
	"identityFor",
	"fingerprint",
	"defaultPidAlive",
	"defaultPidIncarnation",
	"withStateWriteLock",
	"readJson",
	"writeJson",
	"isExactPreUpgradeUnavailableChatDaemonState",
	"hasChatDaemonStatePid",
	"createChatDaemonOwnerLock",
	"reclaimChatDaemonOwnerLock",
	"acquireChatDaemonReclaimLock",
	"canReclaimChatDaemonOwnerLock",
	"captureChatDaemonOwnerLockLease",
	"unlinkExactChatDaemonOwnerLock",
	"staleChatDaemonLockLease",
	"ownsChatDaemonOwnerLock",
	"isChatDaemonOwnerLock",
] as const;

function validateChatOwnerLockInventory(inventory: Inventory): void {
	for (const family of ["discord", "slack"] as const) {
		const symbols = inventory[family][chatControl];
		if (!symbols || CHAT_OWNER_LOCK_PROTECTED_DECLARATIONS.some(symbol => !symbols.includes(symbol)))
			throw new Error(`telegram-daemon-generation-guard: chat owner-lock primitives must be protected by the ${family} generation contract`);
	}
}

function validateChatCliInventory(inventory: Inventory): void {
	for (const family of ["discord", "slack"] as const) {
		const symbols = inventory[family][chatCli];
		if (!symbols || CHAT_CLI_PROTECTED_DECLARATIONS.some(symbol => !symbols.includes(symbol)))
			throw new Error(`telegram-daemon-generation-guard: chat CLI ownership primitives must be protected by the ${family} generation contract`);
	}
}

function validateChatConfigInventory(inventory: Inventory): void {
	for (const family of ["discord", "slack"] as const) {
		const symbols = inventory[family][config];
		if (!symbols || CHAT_CONFIG_PROTECTED_DECLARATIONS[family].some(symbol => !symbols.includes(symbol)))
			throw new Error(`telegram-daemon-generation-guard: chat configuration primitives must be protected by the ${family} generation contract`);
	}
}

function validateChatEndpointDiscoveryInventory(inventory: Inventory): void {
	for (const family of ["discord", "slack"] as const) {
		for (const [file, required] of Object.entries(CHAT_ENDPOINT_DISCOVERY_PROTECTED_DECLARATIONS)) {
			const symbols = inventory[family][file];
			if (!symbols || required.some(symbol => !symbols.includes(symbol))) {
				throw new Error(
					`telegram-daemon-generation-guard: isolated chat endpoint discovery must be protected by the ${family} generation contract`,
				);
			}
		}
	}
}

function validateTelegramToolActivityInventory(inventory: Inventory): void {
	for (const [file, required] of Object.entries(TELEGRAM_TOOL_ACTIVITY_PROTECTED_DECLARATIONS)) {
		const symbols = inventory.telegram[file];
		if (!symbols || required.some(symbol => !symbols.includes(symbol)))
			throw new Error("telegram-daemon-generation-guard: Telegram tool-activity configuration and delivery policy must be protected by the Telegram generation contract");
	}
}

function validateTelegramTopicAdmissionInventory(inventory: Inventory): void {
	for (const [file, required] of Object.entries(TELEGRAM_TOPIC_ADMISSION_PROTECTED_DECLARATIONS)) {
		const symbols = inventory.telegram[file];
		if (!symbols || required.some(symbol => !symbols.includes(symbol)))
			throw new Error(
				"telegram-daemon-generation-guard: Telegram topic-admission provenance, identity, and registry authorities must be protected by the Telegram generation contract",
			);
	}
}

function validateTelegramOwnerLockInventory(inventory: Inventory): void {
	const symbols = inventory.telegram[telegramDaemon];
	if (!symbols || TELEGRAM_OWNER_LOCK_PROTECTED_DECLARATIONS.some(symbol => !symbols.includes(symbol)))
		throw new Error("telegram-daemon-generation-guard: Telegram owner-lock handoff primitives must be protected by the Telegram generation contract");
}

function validateTelegramLifecycleInventory(inventory: Inventory): void {
	const symbols = inventory.telegram[telegramDaemon];
	if (!symbols || TELEGRAM_LIFECYCLE_PROTECTED_DECLARATIONS.some(symbol => !symbols.includes(symbol)))
		throw new Error("telegram-daemon-generation-guard: Telegram authentication and lifecycle primitives must be protected by the Telegram generation contract");
}
function validateTelegramShutdownDrainInventory(inventory: Inventory): void {
	const symbols = inventory.telegram[telegramDaemon];
	if (!symbols || TELEGRAM_SHUTDOWN_DRAIN_PROTECTED_DECLARATIONS.some(symbol => !symbols.includes(symbol)))
		throw new Error("telegram-daemon-generation-guard: Telegram shutdown admission and durable drain primitives must be protected by the Telegram generation contract");
}

function validateTelegramCallbackReceiptInventory(inventory: Inventory): void {
	const symbols = inventory.telegram[telegramDaemon];
	if (!symbols || TELEGRAM_CALLBACK_RECEIPT_PROTECTED_DECLARATIONS.some(symbol => !symbols.includes(symbol)))
		throw new Error("telegram-daemon-generation-guard: Telegram callback receipt authority primitives must be protected by the Telegram generation contract");
}


function validateTransitionTokenInventory(inventory: Inventory): void {
	const symbols = inventory.telegram["packages/coding-agent/src/sdk/bus/notification-service.ts"];
	if (!symbols || TRANSITION_TOKEN_PROTECTED_DECLARATIONS.some(symbol => !symbols.includes(symbol)))
		throw new Error("telegram-daemon-generation-guard: transition-token primitives must be protected by the Telegram generation contract");
}

function validateTelegramProcessAuthorityInventory(inventory: Inventory): void {
	const symbols = inventory.telegram[telegramControl];
	if (!symbols || TELEGRAM_PROCESS_AUTHORITY_PROTECTED_DECLARATIONS.some(symbol => !symbols.includes(symbol)))
		throw new Error("telegram-daemon-generation-guard: Telegram process termination authority must be protected by the Telegram generation contract");
}




function inventoryHash(inventory: Inventory): string {
	return crypto.createHash("sha256").update(JSON.stringify(inventory)).digest("hex");
}

export function validateInventory(inventory: Inventory = protectedInventory): void {
	if (GUARD_CONTRACT_VERSION < 32) throw new Error("telegram-daemon-generation-guard: unsupported guard contract version");
	for (const [family, files] of Object.entries(inventory)) {
		for (const [file, symbols] of Object.entries(files)) {
			if (!file || symbols.length === 0 || new Set(symbols).size !== symbols.length)
				throw new Error(`telegram-daemon-generation-guard: invalid ${family} contract inventory`);
		}
	}
	validateTransitionTokenInventory(inventory);
	validateTelegramOwnerLockInventory(inventory);
	validateTelegramLifecycleInventory(inventory);
	validateTelegramProcessAuthorityInventory(inventory);
	validateTelegramCallbackReceiptInventory(inventory);
	validateChatOwnerLockInventory(inventory);
	validateChatCliInventory(inventory);
	validateChatConfigInventory(inventory);
	validateChatEndpointDiscoveryInventory(inventory);
	validateTelegramToolActivityInventory(inventory);
	validateTelegramTopicAdmissionInventory(inventory);
	validateTelegramCallbackRecoveryInventory(inventory);
	validateTelegramShutdownDrainInventory(inventory);
}

export function validateManifest(value: unknown = manifest): asserts value is GuardManifest {
	if (!value || typeof value !== "object") throw new Error("telegram-daemon-generation-guard: invalid semantic manifest");
	const contract = value as GuardManifest;
	if (contract.contractVersion !== GUARD_CONTRACT_VERSION)
		throw new Error("telegram-daemon-generation-guard: semantic manifest contract version must match the guard");
	if (!contract.inventory || typeof contract.inventory !== "object")
		throw new Error("telegram-daemon-generation-guard: semantic manifest has no inventory");
	const families = Object.keys(contract.inventory).sort();
	if (families.join(",") !== "discord,slack,telegram")
		throw new Error("telegram-daemon-generation-guard: semantic manifest families must be exact");
	validateInventory(contract.inventory);
	if (inventoryHash(contract.inventory) !== PROTECTED_INVENTORY_SHA256)
		throw new Error("telegram-daemon-generation-guard: semantic manifest does not match the protected inventory");
	if (!contract.digests || typeof contract.digests !== "object")
		throw new Error("telegram-daemon-generation-guard: semantic manifest has no declaration digests");
	const qualified = Object.entries(contract.inventory).flatMap(([family, files]) =>
		Object.entries(files).flatMap(([file, symbols]) => symbols.map(symbol => `${family}:${file}:${symbol}`)),
	).sort();
	const digestKeys = Object.keys(contract.digests).sort();
	if (digestKeys.join("\n") !== qualified.join("\n") || digestKeys.some(key => !/^[0-9a-f]{64}$/.test(contract.digests[key])))
		throw new Error("telegram-daemon-generation-guard: semantic manifest declaration digests must be exact and qualified");
	const nativeDigests = contract.nativeAuthoritySha256;
	if (
		!nativeDigests ||
		typeof nativeDigests !== "object" ||
		Object.keys(nativeDigests).sort().join("\n") !== [...nativeAuthoritySources].sort().join("\n") ||
		Object.values(nativeDigests).some(digest => typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest))
	)
		throw new Error("telegram-daemon-generation-guard: native authority digests must be exact");
}


export async function currentTreeDigests(): Promise<Record<string, string>> {
	const actual: Record<string, string> = {};
	for (const [family, files] of Object.entries(protectedInventory) as [Family, Inventory[Family]][]) {
		for (const [file, symbols] of Object.entries(files)) {
			const source = await Bun.file(path.join(root, file)).text();
			for (const symbol of symbols) {
				const target = extractDeclaration(source, symbol);
				if (!target?.valid) throw new Error(`telegram-daemon-generation-guard: semantic manifest target is missing, ambiguous, or malformed: ${file}:${symbol}`);
				actual[`${family}:${file}:${symbol}`] = crypto.createHash("sha256").update(target.canonical).digest("hex");
			}
		}
	}
	return actual;
}

export async function manifestForCurrentTree(): Promise<GuardManifest> {
	validateInventory(manifest.inventory as Inventory);
	const nativeAuthoritySha256 = Object.fromEntries(
		await Promise.all(
			nativeAuthoritySources.map(async source => {
				const digest = nativeAuthorityDigest(source, await Bun.file(path.join(root, source)).text());
				if (!digest) throw new Error(`telegram-daemon-generation-guard: native authority declaration is missing, ambiguous, or malformed: ${source}`);
				return [source, digest];
			}),
		),
	) as GuardManifest["nativeAuthoritySha256"];
	return {
		contractVersion: GUARD_CONTRACT_VERSION,
		inventory: manifest.inventory as Inventory,
		digests: Object.fromEntries(Object.entries(await currentTreeDigests()).sort()),
		nativeAuthoritySha256,
	};
}

export async function writeManifest(target = path.join(root, manifestScript)): Promise<void> {
	const output = `${JSON.stringify(await manifestForCurrentTree(), null, 2)}\n`;
	const destination = path.resolve(target);
	const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		await Bun.write(temporary, output);
		await fs.rename(temporary, destination);
	} finally {
		await fs.rm(temporary, { force: true });
	}
}

export async function validateCurrentTreeManifest(): Promise<void> {
	const actual = await manifestForCurrentTree();
	if (manifest.contractVersion !== actual.contractVersion)
		throw new Error("telegram-daemon-generation-guard: semantic manifest contract version does not match the current guard");
	const expected = JSON.stringify(Object.entries(manifest.digests).sort());
	const generated = JSON.stringify(Object.entries(actual.digests).sort());
	if (generated !== expected) {
		const expectedDigests = Object.fromEntries(Object.entries(manifest.digests));
		const mismatches = Object.keys(actual.digests)
			.filter(key => actual.digests[key] !== expectedDigests[key])
			.map(key => `${key}: manifest=${expectedDigests[key] ?? "<missing>"} actual=${actual.digests[key]}`);
		throw new Error(
			`telegram-daemon-generation-guard: semantic manifest declaration digests do not byte-match the current tree (${mismatches.join(", ")})`,
		);
	}
	if (JSON.stringify(actual.nativeAuthoritySha256) !== JSON.stringify(manifest.nativeAuthoritySha256))
		throw new Error("telegram-daemon-generation-guard: native authority digests do not byte-match the current tree");
}

/**
 * Fail-closed current-tree validation for a manifest that was just regenerated and
 * written to disk by the local {@link fixGenerations} bootstrap. Unlike
 * `validateCurrentTreeManifest()` — which compares against the module-level
 * `manifest` import and is stale until a repair commits — this byte-compares the
 * provided on-disk manifest source against the current tree so a fresh digest
 * bootstrap can pass its own strict check. It is only invoked from the explicit
 * local developer fix path and must never gate normal/CI guard runs.
 */
export async function validateRegeneratedManifest(manifestSource: string, guardVersion: number | undefined): Promise<void> {
	const diskManifest = JSON.parse(manifestSource) as GuardManifest;
	if (guardVersion === undefined || diskManifest.contractVersion !== guardVersion)
		throw new Error("telegram-daemon-generation-guard: post-fix manifest contract version does not match the guard script");
	const expected = JSON.stringify(Object.entries(await currentTreeDigests()).sort());
	const actual = JSON.stringify(Object.entries(diskManifest.digests).sort());
	if (expected !== actual) throw new Error("telegram-daemon-generation-guard: post-fix manifest digests do not byte-match the current tree");
}

function bootstrapGuardContract(): void {
	validateInventory();
	validateManifest();
}

export function validateSha(name: string, value: string | undefined): string {
	if (!value || !SHA.test(value)) throw new Error(`telegram-daemon-generation-guard: ${name} must be an exact 40-hex commit SHA`);
	return value.toLowerCase();
}

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function validateCiInputs(input: {
	eventName: "pull_request" | "push" | "workflow_dispatch";
	baseSha: string | undefined;
	headSha: string | undefined;
	baseRepository: string | undefined;
	headRepository: string | undefined;
	repository: string | undefined;
}): void {
	validateSha("base SHA", input.baseSha);
	validateSha("head SHA", input.headSha);
	for (const [name, value] of Object.entries({ baseRepository: input.baseRepository, headRepository: input.headRepository, repository: input.repository })) {
		if (!value || !REPOSITORY.test(value)) throw new Error(`telegram-daemon-generation-guard: ${name} must be an owner/repository name`);
	}
	if (input.baseRepository !== input.repository) throw new Error("telegram-daemon-generation-guard: base repository must be this repository");
	if ((input.eventName === "push" || input.eventName === "workflow_dispatch") && input.headRepository !== input.repository)
		throw new Error(`telegram-daemon-generation-guard: ${input.eventName} head repository must be this repository`);
}

/**
 * Prove that a CI run operates on the exact, authoritative event revisions. The
 * event head SHA must match both the checked-out head and the fetched head-branch
 * ref, and the event base SHA must resolve to a real object in the authoritative
 * base repository. Pull requests intentionally prove only their immutable event
 * base object because the live ref can advance while queued; a workflow_dispatch
 * explicitly pins a live base ref and therefore proves that ref still resolves to
 * the requested base SHA. Repository/ref provenance and event ownership are
 * enforced via {@link validateCiInputs}.
 */
export function assertGuardAuthority(input: {
	eventName: string | undefined;
	baseSha: string | undefined;
	headSha: string | undefined;
	baseRepository: string | undefined;
	headRepository: string | undefined;
	repository: string | undefined;
	checkedOutHead: string | undefined;
	headRefSha: string | undefined;
	baseObjectSha: string | undefined;
	baseRefSha: string | undefined;
}): void {
	if (input.eventName !== "pull_request" && input.eventName !== "push" && input.eventName !== "workflow_dispatch")
		throw new Error("telegram-daemon-generation-guard: unsupported CI event");
	validateCiInputs({ ...input, eventName: input.eventName });
	const headSha = validateSha("head SHA", input.headSha);
	const baseSha = validateSha("base SHA", input.baseSha);
	const checkedOutHead = validateSha("checked-out head object", input.checkedOutHead);
	const headRefSha = validateSha("head ref object", input.headRefSha);
	const baseObjectSha = validateSha("base object", input.baseObjectSha);
	if (checkedOutHead !== headSha)
		throw new Error("telegram-daemon-generation-guard: checked-out head object does not equal event head SHA");
	if (headRefSha !== headSha)
		throw new Error("telegram-daemon-generation-guard: head ref does not resolve to event head SHA");
	if (baseObjectSha !== baseSha)
		throw new Error("telegram-daemon-generation-guard: base object does not equal event base SHA");
	if (input.eventName === "workflow_dispatch" && validateSha("base ref object", input.baseRefSha) !== baseSha)
		throw new Error("telegram-daemon-generation-guard: dispatch base ref does not resolve to requested base SHA");
}

function nodeName(node: any): string | undefined {
	if (node?.id?.type === "Identifier") return node.id.name;
	if (node?.key?.type === "Identifier") return node.key.name;
	if (node?.key?.type === "PrivateName" && node.key.id?.type === "Identifier") return `#${node.key.id.name}`;
	if (node?.key?.type === "StringLiteral") return node.key.value;
}

// Object-literal property/method usages (e.g. `{ ...state, identity }`) share a
// name with real declarations but are NOT declaration sites; excluding them keeps
// protected method/type names from resolving ambiguously.
const NON_DECLARATION_NODE_TYPES = new Set(["ObjectProperty", "ObjectMethod"]);

function declarationNodes(node: any, name: string, found: any[] = []): any[] {
	if (!node || typeof node !== "object") return found;
	// Never descend into function/method bodies: protected declarations are module
	// top-level or class members, never locals. Otherwise a local `const identity`
	// inside a method body would collide with a protected method of the same name.
	if (node.type === "BlockStatement") return found;
	if (node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration") return declarationNodes(node.declaration, name, found);
	if (node.type === "VariableDeclaration") {
		if (node.declarations.some((declaration: any) => declaration.id?.type === "Identifier" && declaration.id.name === name)) found.push(node);
		return found;
	}
	if (nodeName(node) === name && /(?:Declaration|Method|Property)$/.test(node.type) && !NON_DECLARATION_NODE_TYPES.has(node.type))
		found.push(node);
	for (const value of Object.values(node)) {
		if (Array.isArray(value)) for (const child of value) declarationNodes(child, name, found);
		else if (value && typeof value === "object" && typeof (value as any).type === "string") declarationNodes(value, name, found);
	}
	return found;
}

function resolveDeclaration(node: any, name: string): { node?: any; ambiguous: boolean } {
	const [className, privateMethod] = name.split(".#");
	if (privateMethod) {
		const classes = declarationNodes(node, className);
		if (classes.length !== 1 || classes[0]?.type !== "ClassDeclaration") return { ambiguous: classes.length > 1 };
		const methods = classes[0].body?.body?.filter((member: any) => nodeName(member) === `#${privateMethod}`) ?? [];
		return methods.length === 1 ? { node: methods[0], ambiguous: false } : { ambiguous: methods.length > 1 };
	}
	const [rootName, property] = name.split(".");
	const matches = declarationNodes(node, rootName);
	// More than one match is ambiguous and must fail closed as malformed; zero is
	// simply missing. A protected file that adds a second class method — e.g.
	// another `stop`/`status` — must never be silently hashed as matches[0].
	if (matches.length !== 1) return { ambiguous: matches.length > 1 };
	if (!property) return { node: matches[0], ambiguous: false };
	const declaration = matches[0].declarations?.find((item: any) => item.id?.name === rootName);
	const object = declaration?.init?.type === "TSAsExpression" ? declaration.init.expression : declaration?.init;
	const properties = object?.properties?.filter((item: any) => nodeName(item) === property) ?? [];
	if (properties.length === 1) return { node: properties[0], ambiguous: false };
	return { ambiguous: properties.length > 1 };
}

function declarationNode(node: any, name: string): any | undefined {
	return resolveDeclaration(node, name).node;
}

/** AST-backed extraction prevents comments, strings, overloads, and similarly named text from matching. */
export function declaration(source: string, name: string): string | undefined {
	const result = extractDeclaration(source, name);
	return result?.text;
}

const AST_METADATA = new Set(["start", "end", "loc", "comments", "leadingComments", "trailingComments", "innerComments", "extra"]);

function canonicalAst(value: unknown): unknown {
	if (typeof value === "bigint") return `${value}n`;
	if (Array.isArray(value)) return value.map(canonicalAst);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.filter(([key]) => !AST_METADATA.has(key))
			.map(([key, child]) => [key, canonicalAst(child)]),
	);
}

function canonicalSource(source: string): string | undefined {
	try {
		return JSON.stringify(canonicalAst(parse(source, { sourceType: "module", plugins: ["typescript"] }).program));
	} catch {
		return undefined;
	}
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.keys(value as Record<string, unknown>)
			.sort()
			.map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
			.join(",")}}`;
	return JSON.stringify(value ?? null);
}

/**
 * Canonical signature of the manifest's guard *policy* — its contract version and
 * protected inventory — with the declaration and native-authority attestations
 * removed. Every legitimate protected lifecycle edit MUST refresh those digests to
 * keep the manifest byte-matching the tree; such a refresh is not a policy change
 * and must not force a GUARD_CONTRACT_VERSION bump. Returns undefined for an absent or
 * unparseable manifest so a genuine policy edit still fails closed.
 */
function manifestPolicySignature(source: string | undefined): string | undefined {
	if (source === undefined) return undefined;
	try {
		const parsed = JSON.parse(source);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		const { digests: _digests, nativeAuthoritySha256: _nativeAuthoritySha256, ...policy } = parsed as Record<string, unknown>;
		return stableJson(policy);
	} catch {
		return undefined;
	}
}
function manifestNativeAuthoritySources(source: string | undefined): Set<string> {
	try {
		const parsed = source ? JSON.parse(source) : undefined;
		const native = parsed?.nativeAuthoritySha256;
		if (!native || typeof native !== "object" || Array.isArray(native)) return new Set();
		return new Set(Object.keys(native));
	} catch {
		return new Set();
	}
}


function malformedDeclaration(): Declaration {
	return { text: "<malformed>", canonical: "<malformed>", valid: false };
}

function declarationFrom(source: string, resolved: { node?: any; ambiguous: boolean }): Declaration {
	// Ambiguity is fail-closed identical to an unparseable declaration: both surface
	// as <malformed> so evaluate()/run() reject them and require a fix, rather than
	// silently hashing the wrong node.
	if (resolved.ambiguous) return malformedDeclaration();
	const node = resolved.node;
	return node && typeof node.start === "number" && typeof node.end === "number"
		? { text: source.slice(node.start, node.end), canonical: JSON.stringify(canonicalAst(node)), valid: true }
		: undefined;
}

function extractDeclaration(source: string, name: string): Declaration {
	try {
		const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
		return declarationFrom(source, resolveDeclaration(ast.program, name));
	} catch {
		return malformedDeclaration();
	}
}

function extractDeclarations(source: string, names: readonly string[]): Map<string, Declaration> {
	try {
		const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
		return new Map(names.map(name => [name, declarationFrom(source, resolveDeclaration(ast.program, name))] as const));
	} catch {
		return new Map(names.map(name => [name, malformedDeclaration()] as const));
	}
}

function generation(source: string | undefined, kind?: "discord" | "slack"): number | undefined {
	if (!source) return undefined;
	try {
		const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
		const variable = declarationNode(ast.program, kind ? `CHAT_DAEMON_GENERATIONS.${kind}` : "DAEMON_GENERATION");
		if (!variable) return undefined;
		if (!kind) {
			const declaration = variable.declarations?.find((item: any) => item.id?.name === "DAEMON_GENERATION");
			return declaration?.init?.type === "NumericLiteral" ? declaration.init.value : undefined;
		}
		return variable.value?.type === "NumericLiteral" ? variable.value.value : undefined;
	} catch {
		return undefined;
	}
}

function guardContractVersion(source: string | undefined): number | undefined {
	if (!source) return undefined;
	try {
		const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
		const variable = declarationNode(ast.program, "GUARD_CONTRACT_VERSION");
		const declaration = variable?.declarations?.find((item: any) => item.id?.name === "GUARD_CONTRACT_VERSION");
		return declaration?.init?.type === "NumericLiteral" ? declaration.init.value : undefined;
	} catch {
		return undefined;
	}
}


export function isLegacyBootstrapBase(base: ReadonlyMap<string, string | undefined>): boolean {
	if (base.get(guardScript) !== undefined || base.get(manifestScript) !== undefined) return false;
	const contract = base.get(telegramContract);
	const daemon = base.get(telegramDaemon);
	const chat = base.get(chatControl);
	if (!contract || !daemon || !chat || /\b(?:ownershipPhase|acquisitionId)\b/.test(daemon) || !declaration(daemon, "acquireDaemonOwnership")) return false;
	try {
		const program = parse(contract, { sourceType: "module", plugins: ["typescript"] }).program;
		const chatProgram = parse(chat, { sourceType: "module", plugins: ["typescript"] }).program;
		const exportedNames = program.body.flatMap((statement: any) => {
			const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
			if (declaration?.type !== "VariableDeclaration") return [];
			return declaration.declarations.map((item: any) => item.id?.name).filter((name: unknown): name is string => typeof name === "string");
		});
		if (exportedNames.sort().join(",") !== "DAEMON_GENERATION,NOTIFICATION_PROTOCOL_VERSION") return false;
		const protocol = declarationNode(program, "NOTIFICATION_PROTOCOL_VERSION");
		const generation = declarationNode(program, "DAEMON_GENERATION");
		const protocolDeclaration = protocol?.declarations?.find((item: any) => item.id?.name === "NOTIFICATION_PROTOCOL_VERSION");
		const generationDeclaration = generation?.declarations?.find((item: any) => item.id?.name === "DAEMON_GENERATION");
		const controller = declarationNode(chatProgram, "ChatDaemonController");
		const hasOperate = controller?.type === "ClassDeclaration" && controller.body?.body.some((member: any) => member.type === "ClassMethod" && nodeName(member) === "operate");
		const protocol3 = protocolDeclaration?.init?.type === "NumericLiteral" && protocolDeclaration.init.value === 3;
		const aliasGeneration = generationDeclaration?.init?.type === "Identifier" && generationDeclaration.init.name === "NOTIFICATION_PROTOCOL_VERSION";
		const numericGeneration6 = generationDeclaration?.init?.type === "NumericLiteral" && generationDeclaration.init.value === 6;
		return protocol3 &&
			(aliasGeneration || numericGeneration6) &&
			!declarationNode(chatProgram, "CHAT_DAEMON_GENERATIONS") &&
			!declarationNode(chatProgram, "chatDaemonGeneration") &&
			hasOperate;
	} catch {
		return false;
	}
}

export type Evaluation = {
	protectedChanges: string[];
	nativeAuthorityChanges: string[];
	telegramGenerationBumped: boolean;
	chatGenerationBumped: Record<"discord" | "slack", boolean>;
	malformedDeclarations: string[];
	guardPolicyChanged: boolean;
	guardContractBumped: boolean;
};

function nativeAuthorityDigest(source: keyof typeof nativeAuthorityDeclarations, content: string | undefined): string | undefined {
	const declarations = extractNativeDeclarations(source, content);
	if ([...declarations.values()].some(declaration => !declaration?.valid)) return undefined;
	return crypto.createHash("sha256").update([...declarations.values()].map(declaration => declaration!.canonical).join("\n")).digest("hex");
}

function rustLexicalSource(source: string): { code: string; valid: boolean } {
	const code = source.split("");
	const blank = (start: number, end: number) => {
		for (let index = start; index < end; index++) if (code[index] !== "\n") code[index] = " ";
	};
	const isIdentifier = (value: string | undefined) => value !== undefined && /[A-Za-z0-9_]/.test(value);
	for (let index = 0; index < source.length;) {
		if (source.startsWith("//", index)) {
			const end = source.indexOf("\n", index);
			blank(index, end === -1 ? source.length : end);
			index = end === -1 ? source.length : end;
			continue;
		}
		if (source.startsWith("/*", index)) {
			const start = index;
			let depth = 1;
			index += 2;
			while (index < source.length && depth > 0) {
				if (source.startsWith("/*", index)) {
					depth++;
					index += 2;
				} else if (source.startsWith("*/", index)) {
					depth--;
					index += 2;
				} else index++;
			}
			if (depth !== 0) return { code: code.join(""), valid: false };
			blank(start, index);
			continue;
		}
		const raw = /^(?:br|r)(#+)?"/.exec(source.slice(index));
		if (raw && !isIdentifier(source[index - 1])) {
			const start = index;
			const hashes = raw[1] ?? "";
			const close = `"${hashes}`;
			index += raw[0].length;
			const end = source.indexOf(close, index);
			if (end === -1) return { code: code.join(""), valid: false };
			index = end + close.length;
			blank(start, index);
			continue;
		}
		const quote = source[index] === '"' ? index : source.startsWith('b"', index) && !isIdentifier(source[index - 1]) ? index + 1 : -1;
		if (quote !== -1) {
			const start = index;
			index = quote + 1;
			let closed = false;
			while (index < source.length) {
				if (source[index] === "\\") index += 2;
				else if (source[index] === '"') {
					index++;
					closed = true;
					break;
				} else if (source[index++] === "\n") return { code: code.join(""), valid: false };
			}
			if (!closed || index > source.length) return { code: code.join(""), valid: false };
			blank(start, index);
			continue;
		}
		const charStart = source[index] === "'" ? index : source.startsWith("b'", index) && !isIdentifier(source[index - 1]) ? index + 1 : -1;
		if (charStart !== -1) {
			const start = index;
			index = charStart + 1;
			let closed = false;
			while (index < source.length && source[index] !== "\n") {
				if (source[index] === "\\") index += 2;
				else if (source[index] === "'") {
					index++;
					closed = true;
					break;
				} else index++;
			}
			if (closed) {
				blank(start, index);
				continue;
			}
			const lifetime = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(charStart + 1));
			const lifetimeEnd = lifetime ? charStart + 1 + lifetime[0].length : -1;
			if (!lifetime || !/[\s,:>+)]/.test(source[lifetimeEnd] ?? "")) return { code: code.join(""), valid: false };
			index = start + 1;
			continue;
		}
		index++;
	}
	return { code: code.join(""), valid: true };
}

function rustDeclaration(source: string, selector: string): Declaration {
	const lexical = rustLexicalSource(source);
	if (!lexical.valid) return malformedDeclaration();
	const declarationName = selector;
	if (declarationName.startsWith("const ")) {
		const name = declarationName.slice("const ".length);
		const pattern = new RegExp(`(?:#\\[[^\\]]+\\]\\s*)*(?:pub(?:\\([^)]*\\))?\\s+)?const\\s+${name}\\b`, "g");
		const matches = [...lexical.code.matchAll(pattern)];
		if (matches.length === 0) return undefined;
		const declarations = matches.map(match => {
			const start = match.index!;
			const end = lexical.code.indexOf(";", start);
			return end < 0 ? undefined : source.slice(start, end + 1);
		});
		if (declarations.some(declaration => declaration === undefined)) return malformedDeclaration();
		const text = declarations.join("\n");
		return { text, canonical: text.replace(/\/\*[\s\S]*?\*\/|\/\/.*|\s+/g, ""), valid: true };
	}
	const prefix = declarationName === "napi impl Process"
		? "#\\[napi\\](?:\\s*#\\[[^\\]]+\\])*\\s*impl\\s+Process\\b"
		: declarationName === "impl Process"
			? "impl\\s+Process\\b"
			: declarationName.startsWith("impl ")
				? declarationName.replaceAll(" ", "\\s+")
				: declarationName.startsWith("trait ")
					? `(?:#\\[[^\\]]+\\]\\s*)*pub\\s+trait\\s+${declarationName.slice("trait ".length)}\\b`
					: `(?:#\\[[^\\]]+\\]\\s*)*(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?fn\\s+${declarationName}\\b`;
	const pattern = new RegExp(prefix, "g");
	const matches = [...lexical.code.matchAll(pattern)];
	if (matches.length === 0) return undefined;
	const declarations: string[] = [];
	for (const match of matches) {
		const start = match.index!;
		const headerEnd = start + match[0].length;
		const open = lexical.code.indexOf("{", headerEnd);
		if (open === -1 || /;|\b(?:pub\s+)?(?:async\s+)?fn\b/.test(lexical.code.slice(headerEnd, open))) return malformedDeclaration();
		let depth = 0;
		let end = -1;
		for (let index = open; index < lexical.code.length; index++) {
			if (lexical.code[index] === "{") depth++;
			else if (lexical.code[index] === "}" && --depth === 0) {
				end = index + 1;
				break;
			}
		}
		if (end === -1) return malformedDeclaration();
		declarations.push(source.slice(start, end));
	}
	const text = declarations.join("\n");
	return { text, canonical: text.replace(/\/\*[\s\S]*?\*\/|\/\/.*|\s+/g, ""), valid: true };
}

function extractNativeDeclarations(source: keyof typeof nativeAuthorityDeclarations, content: string | undefined): Map<string, Declaration> {
	const selectors = nativeAuthorityDeclarations[source];
	if (content === undefined) return new Map(selectors.map(selector => [selector, undefined]));
	if (source.endsWith(".rs")) return new Map(selectors.map(selector => [selector, rustDeclaration(content, selector)]));
	return extractDeclarations(content, selectors);
}

function inventoryFromManifestSource(source: string | undefined): Inventory | undefined {
	if (source === undefined) return undefined;
	try {
		const inventory = (JSON.parse(source) as { inventory?: unknown }).inventory;
		if (!inventory || typeof inventory !== "object" || Array.isArray(inventory)) return undefined;
		if (Object.keys(inventory).sort().join(",") !== "discord,slack,telegram") return undefined;
		for (const files of Object.values(inventory as Record<string, unknown>)) {
			if (!files || typeof files !== "object" || Array.isArray(files)) return undefined;
			for (const symbols of Object.values(files as Record<string, unknown>))
				if (!Array.isArray(symbols) || symbols.some(symbol => typeof symbol !== "string")) return undefined;
		}
		return inventory as Inventory;
	} catch {
		return undefined;
	}
}

function inventorySymbols(inventory: Inventory, family: Family, file: string): readonly string[] {
	return inventory[family]?.[file] ?? [];
}

export function evaluate(
	base: ReadonlyMap<string, string | undefined>,
	head: ReadonlyMap<string, string | undefined>,
	inventory: Inventory = protectedInventory,
	baseInventory: Inventory = inventory,
): Evaluation {
	const protectedChanges: string[] = [];
	const malformedDeclarations: string[] = [];
	const bootstrapping = isLegacyBootstrapBase(base);
	for (const family of ["telegram", "discord", "slack"] as const) {
		const files = new Set([...Object.keys(baseInventory[family]), ...Object.keys(inventory[family])]);
		for (const file of files) {
			const symbols = new Set([...inventorySymbols(baseInventory, family, file), ...inventorySymbols(inventory, family, file)]);
			const beforeDeclarations = extractDeclarations(base.get(file) ?? "", [...symbols]);
			const afterDeclarations = extractDeclarations(head.get(file) ?? "", [...symbols]);
			for (const symbol of symbols) {
				const beforeProtected = inventorySymbols(baseInventory, family, file).includes(symbol);
				const afterProtected = inventorySymbols(inventory, family, file).includes(symbol);
				const before = beforeDeclarations.get(symbol);
				const after = afterDeclarations.get(symbol);
				const label = `${family}:${file}:${symbol}`;
				if ((afterProtected && (!after?.valid || !after)) || (!bootstrapping && beforeProtected && (!before?.valid || !before)))
					malformedDeclarations.push(label);
				if ((beforeProtected || afterProtected) && before?.canonical !== after?.canonical) protectedChanges.push(label);
			}
		}
	}
	const baseGuardContractVersion = guardContractVersion(base.get(guardScript));
	const headGuardContractVersion = guardContractVersion(head.get(guardScript));
	const guardContractBumped =
		headGuardContractVersion !== undefined &&
		headGuardContractVersion > (baseGuardContractVersion ?? Number.POSITIVE_INFINITY);
	const baseNativeAuthoritySources = manifestNativeAuthoritySources(base.get(manifestScript));
	const headNativeAuthoritySources = manifestNativeAuthoritySources(head.get(manifestScript));
	const hasManifestNativeAuthority = baseNativeAuthoritySources.size > 0 || headNativeAuthoritySources.size > 0;
	for (const source of nativeAuthoritySources) {
		if (!base.has(source) && !head.has(source)) continue;
		const before = nativeAuthorityDigest(source, base.get(source));
		const after = nativeAuthorityDigest(source, head.get(source));
		const label = `${source}:authority`;
		if (
			((!bootstrapping && !guardContractBumped && (!hasManifestNativeAuthority || baseNativeAuthoritySources.has(source))) && !before) ||
			((!hasManifestNativeAuthority || headNativeAuthoritySources.has(source)) && !after)
		)
			malformedDeclarations.push(label);
		if (before !== after) for (const family of nativeAuthorityFamilies[source]) protectedChanges.push(`${family}:${label}`);
	}
	const nativeAuthorityChanges = protectedChanges.filter(change => change.endsWith(":authority"));
	const guardPolicyChanged =
		!bootstrapping &&
		(canonicalSource(base.get(guardScript) ?? "") !== canonicalSource(head.get(guardScript) ?? "") ||
			manifestPolicySignature(base.get(manifestScript)) !== manifestPolicySignature(head.get(manifestScript)));
	const oldTelegramGeneration = generation(base.get(telegramContract));
	const newTelegramGeneration = generation(head.get(telegramContract));
	const telegramGenerationBumped =
		newTelegramGeneration !== undefined && newTelegramGeneration > (oldTelegramGeneration ?? (bootstrapping ? 0 : Number.POSITIVE_INFINITY));
	const chatGenerationBumped = Object.fromEntries(
		(["discord", "slack"] as const).map(kind => {
			const before = generation(base.get(chatControl), kind);
			const after = generation(head.get(chatControl), kind);
			return [kind, after !== undefined && after > (before ?? (bootstrapping ? 0 : Number.POSITIVE_INFINITY))];
		}),
	) as Evaluation["chatGenerationBumped"];
	return { protectedChanges, nativeAuthorityChanges, telegramGenerationBumped, chatGenerationBumped, malformedDeclarations, guardPolicyChanged, guardContractBumped };
}

async function git(args: string[]): Promise<string> {
	const result = await $`git ${args}`.cwd(root).quiet().nothrow();
	if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || `git ${args.join(" ")} failed`);
	return result.stdout.toString();
}

async function verifyObject(name: string, sha: string): Promise<void> {
	const actual = (await git(["rev-parse", "--verify", `${sha}^{commit}`])).trim().toLowerCase();
	if (actual !== sha) throw new Error(`telegram-daemon-generation-guard: ${name} object is unavailable or does not resolve exactly to ${sha}`);
}

async function blob(revision: string, file: string): Promise<string | undefined> {
	const result = await $`git show ${`${revision}:${file}`}`.cwd(root).quiet().nothrow();
	if (result.exitCode === 0) return result.stdout.toString();
	if (result.exitCode === 128 || result.stderr.toString().includes("does not exist")) return undefined;
	throw new Error(`telegram-daemon-generation-guard: unable to read ${file} from ${revision}`);
}

export async function run(baseInput: string | undefined, headInput: string | undefined): Promise<void> {
	bootstrapGuardContract();
	const base = validateSha("base SHA", baseInput);
	const head = validateSha("head SHA", headInput);
	const eventName = process.env.GUARD_EVENT_NAME;
	if (eventName) {
		if (eventName !== "pull_request" && eventName !== "push" && eventName !== "workflow_dispatch")
			throw new Error("telegram-daemon-generation-guard: unsupported CI event");
		validateCiInputs({
			eventName,
			baseSha: baseInput,
			headSha: headInput,
			baseRepository: process.env.BASE_REPOSITORY,
			headRepository: process.env.HEAD_REPOSITORY,
			repository: process.env.GUARD_REPOSITORY,
		});
	}
	await verifyObject("base", base);
	await verifyObject("head", head);
	// Digest attestations are exempt from the guard-policy bump, so the committed
	// head manifest MUST byte-match the checked-out head tree: a stale or tampered
	// declaration digest fails closed here rather than slipping through as a
	// no-op policy change.
	await validateCurrentTreeManifest();
	if (process.env.GJC_DAEMON_GUARD_DEBUG === "1") console.error("daemon-generation-guard: objects verified");
	// The base manifest can name declarations removed or moved in head, so fetch it
	// before loading sources and compare the complete base/head protected-path union.
	const baseManifestSource = await blob(base, manifestScript);
	const baseInventory = inventoryFromManifestSource(baseManifestSource) ?? protectedInventory;
	const files = [
		guardScript,
		manifestScript,
		...new Set([
			...Object.values(baseInventory).flatMap(inventory => Object.keys(inventory)),
			...Object.values(protectedInventory).flatMap(inventory => Object.keys(inventory)),
			...nativeAuthoritySources,
		]),
	];
	const baseFiles: Array<readonly [string, string | undefined]> = [];
	const headFiles: Array<readonly [string, string | undefined]> = [];
	for (const file of files) {
		baseFiles.push([file, file === manifestScript ? baseManifestSource : await blob(base, file)]);
		headFiles.push([file, await blob(head, file)]);
	}
	if (process.env.GJC_DAEMON_GUARD_DEBUG === "1") {
		for (const [file, source] of headFiles) console.error(`daemon-generation-guard: head ${file} ${source?.length ?? -1}`);
		console.error(`daemon-generation-guard: base-guard ${baseFiles.find(([file]) => file === guardScript)?.[1]?.length ?? -1}`);
	}
	if (process.env.GJC_DAEMON_GUARD_DEBUG === "1") console.error("daemon-generation-guard: blobs loaded");
	const baseMap = new Map(baseFiles);
	const decision = evaluate(baseMap, new Map(headFiles), protectedInventory, baseInventory);
	if (process.env.GJC_DAEMON_GUARD_DEBUG === "1") console.error("daemon-generation-guard: declarations evaluated");
	if (baseMap.get(guardScript) !== undefined && decision.guardPolicyChanged && !decision.guardContractBumped)
		throw new Error(`telegram-daemon-generation-guard: guard policy change requires a strictly higher GUARD_CONTRACT_VERSION`);
	if (decision.malformedDeclarations.length > 0)
		throw new Error(`telegram-daemon-generation-guard: v${GUARD_CONTRACT_VERSION} protected declaration is missing or malformed: ${decision.malformedDeclarations.join(", ")}`);
	const telegramChanges = decision.protectedChanges.filter(change => change.startsWith("telegram:"));
	if (telegramChanges.length > 0 && !decision.telegramGenerationBumped)
		throw new Error(`telegram-daemon-generation-guard: protected Telegram lifecycle change requires a strictly higher DAEMON_GENERATION: ${telegramChanges.join(", ")}\n${FIX_GENERATIONS_REMEDIATION}`);
	for (const kind of ["discord", "slack"] as const) {
		const changes = decision.protectedChanges.filter(change => change.startsWith(`${kind}:`));
		if (changes.length > 0 && !decision.chatGenerationBumped[kind])
			throw new Error(`telegram-daemon-generation-guard: protected ${kind} lifecycle change requires a strictly higher CHAT_DAEMON_GENERATIONS.${kind}: ${changes.join(", ")}\n${FIX_GENERATIONS_REMEDIATION}`);
	}
	console.log(`telegram-daemon-generation-guard: v${GUARD_CONTRACT_VERSION} ${decision.protectedChanges.length === 0 ? "no protected changes" : "required generation bump verified"}`);
}

/** Bounded remediation hint appended to normal guard failures. */
export const FIX_GENERATIONS_REMEDIATION =
	"telegram-daemon-generation-guard: run `bun scripts/telegram-daemon-generation-guard.ts --fix-generations <base-sha>` to apply all required generation bumps atomically";

/**
 * Locate the source span of a unique numeric literal declaration by name, using
 * the same AST resolution as the guard's declaration extractor. Returns undefined
 * for missing, ambiguous (duplicate), or non-numeric declarations — the caller
 * must treat that as a hard failure rather than guessing.
 */
function numericLiteralLocation(source: string, name: string, kind?: "discord" | "slack"): { start: number; end: number } | undefined {
	try {
		const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
		const variable = declarationNode(ast.program, kind ? `${name}.${kind}` : name);
		if (!variable) return undefined;
		const literal = kind ? variable.value : variable.declarations?.find((item: any) => item.id?.name === name)?.init;
		if (literal?.type !== "NumericLiteral" || typeof literal.start !== "number" || typeof literal.end !== "number") return undefined;
		return { start: literal.start, end: literal.end };
	} catch {
		return undefined;
	}
}

/**
 * Replace the numeric literal at a unique declaration site with a new integer,
 * preserving all surrounding source formatting. Throws if the target is missing,
 * ambiguous, or non-numeric — never silently writes a malformed edit.
 */
export function replaceNumericLiteral(source: string, name: string, newValue: number, kind?: "discord" | "slack"): string {
	const location = numericLiteralLocation(source, name, kind);
	if (!location) throw new Error(`telegram-daemon-generation-guard: ${kind ? `${name}.${kind}` : name} must be a unique numeric literal to bump`);
	return `${source.slice(0, location.start)}${String(newValue)}${source.slice(location.end)}`;
}

/**
 * The exact title of the topic-registry durable-authority snapshot test. Its
 * generation number must track DAEMON_GENERATION so behavior pinned to the
 * registry contract is always acknowledged at each generation bump.
 */
const TOPIC_REGISTRY_GENERATION_PIN_TITLE = /^publishes exact durable authority generation \d+ at serving epoch \d+$/;

function topicRegistryToBeLiteral(node: unknown): { start: number; end: number } | undefined {
	if (!node || typeof node !== "object") return undefined;
	const candidate = node as { type?: string; start?: number; end?: number; callee?: unknown; property?: unknown; object?: unknown; arguments?: unknown[]; [key: string]: unknown };
	if (
		candidate.type === "CallExpression" &&
		candidate.callee &&
		typeof candidate.callee === "object" &&
		(candidate.callee as { type?: string; object?: unknown; property?: unknown }).type === "MemberExpression" &&
		(candidate.callee as { property?: unknown }).property &&
		typeof (candidate.callee as { property?: unknown }).property === "object" &&
		(candidate.callee as { property: { type?: string; name?: string } }).property.type === "Identifier" &&
		(candidate.callee as { property: { name?: string } }).property.name === "toBe" &&
		(candidate.callee as { object?: unknown }).object &&
		typeof (candidate.callee as { object?: unknown }).object === "object" &&
		(candidate.callee as { object: { type?: string; callee?: unknown; arguments?: unknown[] } }).object.type === "CallExpression" &&
		(candidate.callee as { object: { callee?: unknown } }).object.callee &&
		typeof (candidate.callee as { object: { callee?: unknown } }).object.callee === "object" &&
		(candidate.callee as { object: { callee: { type?: string; name?: string } } }).object.callee.type === "Identifier" &&
		(candidate.callee as { object: { callee: { name?: string } } }).object.callee.name === "expect" &&
		Array.isArray((candidate.callee as { object: { arguments?: unknown[] } }).object.arguments) &&
		(candidate.callee as { object: { arguments: unknown[] } }).object.arguments[0] &&
		typeof (candidate.callee as { object: { arguments: unknown[] } }).object.arguments[0] === "object" &&
		(candidate.callee as { object: { arguments: Array<{ type?: string; name?: string }> } }).object.arguments[0].type === "Identifier" &&
		(candidate.callee as { object: { arguments: Array<{ name?: string }> } }).object.arguments[0].name === "DAEMON_GENERATION" &&
		Array.isArray(candidate.arguments) &&
		candidate.arguments[0] &&
		typeof candidate.arguments[0] === "object" &&
		(candidate.arguments[0] as { type?: string }).type === "NumericLiteral" &&
		typeof (candidate.arguments[0] as { start?: number }).start === "number" &&
		typeof (candidate.arguments[0] as { end?: number }).end === "number"
	) {
		return { start: (candidate.arguments[0] as { start: number }).start, end: (candidate.arguments[0] as { end: number }).end };
	}
	for (const [key, child] of Object.entries(candidate)) {
		if (key === "loc" || key === "extra") continue;
		if (Array.isArray(child)) {
			for (const item of child) {
				const found = topicRegistryToBeLiteral(item);
				if (found) return found;
			}
		} else {
			const found = topicRegistryToBeLiteral(child);
			if (found) return found;
		}
	}
	return undefined;
}

/**
 * Locate the source spans of the topic-registry durable-authority generation
 * pin: the generation digits inside the test title and the numeric literal of
 * the `expect(DAEMON_GENERATION).toBe(...)` assertion inside that test. Uses the
 * same AST-backed extraction as the guard so comments and similarly named text
 * cannot match. Returns undefined when the pin test is missing or ambiguous.
 */
function topicRegistryGenerationPinLocation(source: string): { titleDigitsStart: number; titleDigitsEnd: number; toBeStart: number; toBeEnd: number } | undefined {
	try {
		const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
		for (const statement of ast.program.body) {
			if (statement.type !== "ExpressionStatement" || statement.expression.type !== "CallExpression") continue;
			const call = statement.expression;
			if (call.callee.type !== "Identifier" || call.callee.name !== "test" || call.arguments.length < 2) continue;
			const title = call.arguments[0];
			if (!title || title.type !== "StringLiteral") continue;
			const raw = title.extra?.raw;
			if (typeof raw !== "string" || typeof title.start !== "number" || !TOPIC_REGISTRY_GENERATION_PIN_TITLE.test(title.value)) continue;
			const digits = /generation (\d+)/.exec(raw);
			if (!digits) continue;
			const titleDigitsStart = title.start + digits.index + "generation ".length;
			const titleDigitsEnd = titleDigitsStart + digits[1]!.length;
			const callback = call.arguments[1];
			if (!callback || (callback.type !== "ArrowFunctionExpression" && callback.type !== "FunctionExpression")) continue;
			const toBe = topicRegistryToBeLiteral(callback.body);
			if (!toBe) continue;
			return { titleDigitsStart, titleDigitsEnd, toBeStart: toBe.start, toBeEnd: toBe.end };
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/** The pinned generation number the topic-registry durable-authority snapshot asserts. */
export function topicRegistryGenerationPin(source: string): number | undefined {
	const location = topicRegistryGenerationPinLocation(source);
	if (!location) return undefined;
	return Number(source.slice(location.toBeStart, location.toBeEnd));
}

/**
 * Rewrite the topic-registry durable-authority generation pin (the test title
 * digits and the `expect(DAEMON_GENERATION).toBe(...)` assertion) to a new
 * integer, preserving all surrounding source formatting. Throws if the pin test
 * is missing, ambiguous, or non-numeric — never silently writes a malformed edit.
 */
export function replaceTopicRegistryGenerationPin(source: string, newValue: number): string {
	const location = topicRegistryGenerationPinLocation(source);
	if (!location) throw new Error("telegram-daemon-generation-guard: the topic-registry durable-authority generation pin test must be present and unique to sync");
	return `${source.slice(0, location.titleDigitsStart)}${String(newValue)}${source.slice(location.titleDigitsEnd, location.toBeStart)}${String(newValue)}${source.slice(location.toBeEnd)}`;
}

/** A single generation-constant repair edit. */
export type GenerationEdit = { kind: "telegram" | "discord" | "slack"; file: string; from: number; to: number };

/** The complete repair plan for one `--fix-generations` invocation. */
export type RepairPlan = {
	generationEdits: GenerationEdit[];
	/** Deterministic sync of the topic-registry durable-authority snapshot pin. */
	fixtureEdits: GenerationEdit[];
	needsGuardPolicyAuthority: boolean;
	guardContractEdit: { from: number; to: number } | undefined;
	malformedDeclarations: string[];
	noProtectedChanges: boolean;
};

/**
 * Compute the complete set of generation bumps required to clear the guard for
 * the given base→head transition, in one pass. Pure: does not touch the
 * filesystem. Returns malformed declarations without throwing so the caller can
 * present a clear diagnostic; throws only for non-numeric generation constants.
 */
export function computeRepairPlan(
	base: ReadonlyMap<string, string | undefined>,
	head: ReadonlyMap<string, string | undefined>,
	inventory: Inventory = protectedInventory,
	baseInventory: Inventory = inventory,
): RepairPlan {
	const decision = evaluate(base, head, inventory, baseInventory);
	const malformedDeclarations = [...decision.malformedDeclarations];
	const generationEdits: GenerationEdit[] = [];
	const fixtureEdits: GenerationEdit[] = [];
	let telegramTargetGeneration: number | undefined;
	if (decision.malformedDeclarations.length === 0) {
		const telegramAffected = decision.protectedChanges.some(change => change.startsWith("telegram:"));
		if (telegramAffected) {
			const baseGen = generation(base.get(telegramContract));
			const headGen = generation(head.get(telegramContract));
			if (baseGen === undefined || headGen === undefined)
				throw new Error("telegram-daemon-generation-guard: DAEMON_GENERATION is missing or non-numeric in base or head");
			if (headGen <= baseGen) generationEdits.push({ kind: "telegram", file: telegramContract, from: headGen, to: baseGen + 1 });
			telegramTargetGeneration = headGen > baseGen ? headGen : baseGen + 1;
		} else {
			telegramTargetGeneration = generation(head.get(telegramContract));
		}
		// Deterministically reconcile the topic-registry durable-authority snapshot
		// with the canonical head generation — whether the generation moved in this
		// transition or is already current — so a valid bump can never leave the
		// hard-coded pin stale. A present-but-malformed pin fails closed.
		const baseFixture = base.get(topicRegistryFixture);
		const headFixture = head.get(topicRegistryFixture);
		if (telegramTargetGeneration !== undefined && baseFixture !== undefined && headFixture !== undefined) {
			const headPin = topicRegistryGenerationPin(headFixture);
			if (headPin === undefined) {
				malformedDeclarations.push(`telegram:${topicRegistryFixture}:durable-authority-generation-pin`);
			} else if (headPin !== telegramTargetGeneration) {
				fixtureEdits.push({ kind: "telegram", file: topicRegistryFixture, from: headPin, to: telegramTargetGeneration });
			}
		}
	}
	if (malformedDeclarations.length > 0)
		return { generationEdits: [], fixtureEdits: [], needsGuardPolicyAuthority: false, guardContractEdit: undefined, malformedDeclarations, noProtectedChanges: false };
	for (const kind of ["discord", "slack"] as const) {
		const affected = decision.protectedChanges.some(change => change.startsWith(`${kind}:`));
		if (!affected) continue;
		const baseGen = generation(base.get(chatControl), kind);
		const headGen = generation(head.get(chatControl), kind);
		if (baseGen === undefined || headGen === undefined)
			throw new Error(`telegram-daemon-generation-guard: CHAT_DAEMON_GENERATIONS.${kind} is missing or non-numeric in base or head`);
		if (headGen <= baseGen) generationEdits.push({ kind, file: chatControl, from: headGen, to: baseGen + 1 });
	}
	const needsGuardPolicyAuthority = decision.guardPolicyChanged && !decision.guardContractBumped;
	let guardContractEdit: { from: number; to: number } | undefined;
	if (needsGuardPolicyAuthority) {
		const baseVersion = guardContractVersion(base.get(guardScript));
		if (baseVersion === undefined)
			throw new Error("telegram-daemon-generation-guard: GUARD_CONTRACT_VERSION is missing or non-numeric in base");
		guardContractEdit = { from: baseVersion, to: baseVersion + 1 };
	}
	return { generationEdits, fixtureEdits, needsGuardPolicyAuthority, guardContractEdit, malformedDeclarations: [], noProtectedChanges: decision.protectedChanges.length === 0 };
}

/**
 * Explicit local command: compute and apply all required generation bumps
 * atomically. Never runs under CI or guard-event environments. Snapshots all
 * target files and rolls back every edit (source constants + manifest) if any
 * step — manifest regeneration, current-tree validation, or post-fix evaluation
 * — fails.
 */
export async function fixGenerations(baseInput: string | undefined, options: { fixGuardPolicy?: boolean } = {}): Promise<void> {
	if (process.env.CI || process.env.GUARD_EVENT_NAME)
		throw new Error("telegram-daemon-generation-guard: --fix-generations is an explicit local developer command and must not run under CI or guard-event environments");
	bootstrapGuardContract();
	const base = validateSha("base SHA", baseInput);
	await verifyObject("base", base);
	const baseManifestSource = await blob(base, manifestScript);
	const baseInventory = inventoryFromManifestSource(baseManifestSource) ?? protectedInventory;
	const filePaths = [
		guardScript,
		manifestScript,
		topicRegistryFixture,
		...new Set([
			...Object.values(baseInventory).flatMap(inv => Object.keys(inv)),
			...Object.values(protectedInventory).flatMap(inv => Object.keys(inv)),
			...nativeAuthoritySources,
		]),
	];
	const baseFiles: Array<readonly [string, string | undefined]> = [];
	const headFiles: Array<readonly [string, string | undefined]> = [];
	for (const file of filePaths) {
		baseFiles.push([file, file === manifestScript ? baseManifestSource : await blob(base, file)]);
		headFiles.push([file, await Bun.file(path.join(root, file)).text().catch(() => undefined)]);
	}
	const plan = computeRepairPlan(new Map(baseFiles), new Map(headFiles), protectedInventory, baseInventory);
	if (plan.malformedDeclarations.length > 0)
		throw new Error(`telegram-daemon-generation-guard: v${GUARD_CONTRACT_VERSION} protected declaration is missing or malformed: ${plan.malformedDeclarations.join(", ")}`);
	if (plan.needsGuardPolicyAuthority && !options.fixGuardPolicy)
		throw new Error("telegram-daemon-generation-guard: guard policy change requires a strictly higher GUARD_CONTRACT_VERSION; rerun with --fix-guard-policy to bump it automatically");
	const hasGuardContractBump = plan.needsGuardPolicyAuthority && options.fixGuardPolicy === true && plan.guardContractEdit !== undefined;
	if (plan.generationEdits.length === 0 && plan.fixtureEdits.length === 0 && !hasGuardContractBump) {
		console.log(`telegram-daemon-generation-guard: v${GUARD_CONTRACT_VERSION} no generation bumps required`);
		return;
	}
	// Snapshot every file that may be mutated so rollback restores the exact prior state.
	const editFiles = new Set<string>();
	for (const edit of plan.generationEdits) editFiles.add(edit.file);
	for (const edit of plan.fixtureEdits) editFiles.add(edit.file);
	if (hasGuardContractBump) editFiles.add(guardScript);
	editFiles.add(manifestScript);
	const snapshots = new Map<string, string | undefined>();
	for (const file of editFiles) snapshots.set(file, await Bun.file(path.join(root, file)).text().catch(() => undefined));
	try {
		for (const edit of plan.generationEdits) {
			const filePath = path.join(root, edit.file);
			const current = await Bun.file(filePath).text();
			const updated = edit.kind === "telegram"
				? replaceNumericLiteral(current, "DAEMON_GENERATION", edit.to)
				: replaceNumericLiteral(current, "CHAT_DAEMON_GENERATIONS", edit.to, edit.kind);
			await Bun.write(filePath, updated);
		}
		for (const edit of plan.fixtureEdits) {
			const filePath = path.join(root, edit.file);
			const current = await Bun.file(filePath).text();
			await Bun.write(filePath, replaceTopicRegistryGenerationPin(current, edit.to));
		}
		if (hasGuardContractBump && plan.guardContractEdit) {
			const guardPath = path.join(root, guardScript);
			const current = await Bun.file(guardPath).text();
			await Bun.write(guardPath, replaceNumericLiteral(current, "GUARD_CONTRACT_VERSION", plan.guardContractEdit.to));
		}
		// Regenerate the semantic manifest. manifestForCurrentTree() uses the
		// in-memory GUARD_CONTRACT_VERSION import, so when the guard contract was
		// bumped on disk, override the contract version to match the disk state.
		const manifestObj = await manifestForCurrentTree();
		if (hasGuardContractBump && plan.guardContractEdit) manifestObj.contractVersion = plan.guardContractEdit.to;
		const manifestTarget = path.join(root, manifestScript);
		const manifestTemp = `${manifestTarget}.${process.pid}.${crypto.randomUUID()}.tmp`;
		try {
			await Bun.write(manifestTemp, `${JSON.stringify(manifestObj, null, 2)}\n`);
			await fs.rename(manifestTemp, manifestTarget);
		} finally {
			await fs.rm(manifestTemp, { force: true });
		}
		// Validate the regenerated disk manifest byte-matches the current tree.
		// validateCurrentTreeManifest() validates against the module-level `manifest`
		// import, which is stale on a bootstrap where the committed digests do not yet
		// match the tree. Always validate the manifest we just wrote to disk, so a local
		// --fix-generations bootstrap that regenerates stale semantic digests can pass its
		// own strict current-tree check, while validateCurrentTreeManifest() (normal/CI
		// guard) stays fail-closed against the pre-repair committed manifest.
		await validateRegeneratedManifest(
			await Bun.file(manifestTarget).text(),
			guardContractVersion(await Bun.file(path.join(root, guardScript)).text()),
		);
		// Re-evaluate base→updated-tree to confirm the normal guard would pass.
		const updatedHead: Array<readonly [string, string | undefined]> = [];
		for (const file of filePaths) updatedHead.push([file, await Bun.file(path.join(root, file)).text().catch(() => undefined)]);
		const reDecision = evaluate(new Map(baseFiles), new Map(updatedHead), protectedInventory, baseInventory);
		if (reDecision.malformedDeclarations.length > 0)
			throw new Error(`telegram-daemon-generation-guard: post-fix evaluation found malformed declarations: ${reDecision.malformedDeclarations.join(", ")}`);
		const reTelegram = reDecision.protectedChanges.filter(change => change.startsWith("telegram:"));
		if (reTelegram.length > 0 && !reDecision.telegramGenerationBumped)
			throw new Error("telegram-daemon-generation-guard: post-fix evaluation still requires a Telegram generation bump");
		for (const kind of ["discord", "slack"] as const) {
			const reKind = reDecision.protectedChanges.filter(change => change.startsWith(`${kind}:`));
			if (reKind.length > 0 && !reDecision.chatGenerationBumped[kind])
				throw new Error(`telegram-daemon-generation-guard: post-fix evaluation still requires a ${kind} generation bump`);
		}
		// Print a bounded, secret-free summary.
		const parts: string[] = plan.generationEdits.map(edit => `${edit.kind} ${edit.from}→${edit.to}`);
		for (const edit of plan.fixtureEdits) parts.push(`fixture ${edit.from}→${edit.to}`);
		if (hasGuardContractBump && plan.guardContractEdit) parts.push(`guard-contract ${plan.guardContractEdit.from}→${plan.guardContractEdit.to}`);
		console.log(`telegram-daemon-generation-guard: v${GUARD_CONTRACT_VERSION} applied ${parts.join(", ")}`);
	} catch (error) {
		for (const [file, content] of snapshots) {
			const filePath = path.join(root, file);
			if (content !== undefined) await Bun.write(filePath, content);
			else await fs.rm(filePath, { force: true });
		}
		throw error;
	}
}
if (import.meta.main) {
	try {
		if (process.argv.includes("--validate-current-tree")) await validateCurrentTreeManifest();
		else if (process.argv.includes("--write-manifest")) await writeManifest();
		else if (process.argv.includes("--fix-generations")) {
			const baseArg = process.argv[process.argv.indexOf("--fix-generations") + 1];
			await fixGenerations(baseArg, { fixGuardPolicy: process.argv.includes("--fix-guard-policy") });
		}
		else if (process.argv.includes("--check-authority"))
			assertGuardAuthority({
				eventName: process.env.GUARD_EVENT_NAME,
				baseSha: process.env.GITHUB_BASE_SHA,
				headSha: process.env.GITHUB_HEAD_SHA,
				baseRepository: process.env.BASE_REPOSITORY,
				headRepository: process.env.HEAD_REPOSITORY,
				repository: process.env.GUARD_REPOSITORY,
				checkedOutHead: process.env.GUARD_CHECKED_OUT_HEAD,
				headRefSha: process.env.GUARD_HEAD_REF_SHA,
				baseObjectSha: process.env.GUARD_BASE_OBJECT_SHA,
				baseRefSha: process.env.GUARD_BASE_REF_SHA,
			});
		else await run(process.env.GITHUB_BASE_SHA ?? process.argv[2], process.env.GITHUB_HEAD_SHA ?? process.argv[3]);
	} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
