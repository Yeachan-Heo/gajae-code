#!/usr/bin/env bun
import { $ } from "bun";
import { parse } from "@babel/parser";
import manifest from "./telegram-daemon-generation-manifest.json" with { type: "json" };
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const root = path.join(import.meta.dir, "..");
const SHA = /^[0-9a-f]{40}$/i;
export const GUARD_CONTRACT_VERSION = 25;
const telegramContract = "packages/coding-agent/src/sdk/bus/telegram-daemon-contract.ts";
const telegramDaemon = "packages/coding-agent/src/sdk/bus/telegram-daemon.ts";
const telegramControl = "packages/coding-agent/src/sdk/bus/telegram-daemon-control.ts";

const chatControl = "packages/coding-agent/src/sdk/bus/chat-daemon-control.ts";
const chatCli = "packages/coding-agent/src/sdk/bus/chat-daemon-cli.ts";
const config = "packages/coding-agent/src/sdk/bus/config.ts";
const guardScript = "scripts/telegram-daemon-generation-guard.ts";
const manifestScript = "scripts/telegram-daemon-generation-manifest.json";
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
		"snapshot_directory_tree",
		"exact_remove_directory_tree",
	],
	"crates/pi-natives/src/ps.rs": ["napi impl Process"],
	"crates/pi-shell/src/process.rs": ["impl Process", "kill_process_group", "current_descendant_pids", "add_new_descendants"],
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
 * This is a deliberately small, exact lifecycle contract. Do not include session
 * endpoint or provider generations: they do not replace daemon owners.
 */
export const protectedInventory = manifest.inventory as Inventory;
const PROTECTED_INVENTORY_SHA256 = "a49bcbb42416097468002151a3e75636fe28b6e2ac4ab8fbc5692bf14f1d1541";

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


/** Telegram authentication and lifecycle control must remain generation-fenced. */
export const TELEGRAM_LIFECYCLE_PROTECTED_DECLARATIONS = ["validBotToken", "requestStop", "startLifecycleControl", "run"] as const;

/** Chat daemon CLI helpers determine whether a prior owner can be replaced. */
export const CHAT_CLI_PROTECTED_DECLARATIONS = ["defaultPidAlive", "loadConfig", "ownerPid"] as const;

/** Provider credentials configure daemon ownership and must stay family-scoped. */
export const CHAT_CONFIG_PROTECTED_DECLARATIONS = {
	discord: ["getNotificationConfig", "notificationConfigFromFile", "isDiscordConfigured", "tokenFingerprint"],
	slack: ["getNotificationConfig", "notificationConfigFromFile", "isSlackConfigured", "tokenFingerprint"],
} as const;

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
	if (GUARD_CONTRACT_VERSION !== 25) throw new Error("telegram-daemon-generation-guard: unsupported guard contract version");
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
	validateChatOwnerLockInventory(inventory);
	validateChatCliInventory(inventory);
	validateChatConfigInventory(inventory);
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
	if (JSON.stringify(Object.entries(actual.digests).sort()) !== expected)
		throw new Error("telegram-daemon-generation-guard: semantic manifest declaration digests do not byte-match the current tree");
	if (JSON.stringify(actual.nativeAuthoritySha256) !== JSON.stringify(manifest.nativeAuthoritySha256))
		throw new Error("telegram-daemon-generation-guard: native authority digests do not byte-match the current tree");
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
	const prefix = declarationName === "napi impl Process"
		? "#\\[napi\\](?:\\s*#\\[[^\\]]+\\])*\\s*impl\\s+Process\\b"
		: declarationName === "impl Process"
			? "impl\\s+Process\\b"
			: `(?:#\\[[^\\]]+\\]\\s*)*pub(?:\\(super\\))?\\s+(?:async\\s+)?fn\\s+${declarationName}\\b`;
	const pattern = new RegExp(prefix, "g");
	const matches = [...lexical.code.matchAll(pattern)];
	if (matches.length === 0) return undefined;
	const declarations: string[] = [];
	for (const match of matches) {
		const start = match.index!;
		const headerEnd = start + match[0].length;
		const open = lexical.code.indexOf("{", headerEnd);
		if (open === -1 || /;|\b(?:pub\s+)?(?:async\s+)?fn\b|\bimpl\b/.test(lexical.code.slice(headerEnd, open))) return malformedDeclaration();
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
	for (const source of nativeAuthoritySources) {
		if (!base.has(source) && !head.has(source)) continue;
		const before = nativeAuthorityDigest(source, base.get(source));
		const after = nativeAuthorityDigest(source, head.get(source));
		const label = `${source}:authority`;
		if (!before || !after) malformedDeclarations.push(label);
		if (before !== after) for (const family of nativeAuthorityFamilies[source]) protectedChanges.push(`${family}:${label}`);
	}
	const nativeAuthorityChanges = protectedChanges.filter(change => change.endsWith(":authority"));
	const guardPolicyChanged =
		!bootstrapping &&
		(canonicalSource(base.get(guardScript) ?? "") !== canonicalSource(head.get(guardScript) ?? "") ||
			manifestPolicySignature(base.get(manifestScript)) !== manifestPolicySignature(head.get(manifestScript)));
	const baseGuardContractVersion = guardContractVersion(base.get(guardScript));
	const headGuardContractVersion = guardContractVersion(head.get(guardScript));
	const guardContractBumped =
		headGuardContractVersion !== undefined &&
		(headGuardContractVersion > (baseGuardContractVersion ?? Number.POSITIVE_INFINITY));
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
		throw new Error(`telegram-daemon-generation-guard: protected Telegram lifecycle change requires a strictly higher DAEMON_GENERATION: ${telegramChanges.join(", ")}`);
	for (const kind of ["discord", "slack"] as const) {
		const changes = decision.protectedChanges.filter(change => change.startsWith(`${kind}:`));
		if (changes.length > 0 && !decision.chatGenerationBumped[kind])
			throw new Error(`telegram-daemon-generation-guard: protected ${kind} lifecycle change requires a strictly higher CHAT_DAEMON_GENERATIONS.${kind}: ${changes.join(", ")}`);
	}
	console.log(`telegram-daemon-generation-guard: v${GUARD_CONTRACT_VERSION} ${decision.protectedChanges.length === 0 ? "no protected changes" : "required generation bump verified"}`);
}

if (import.meta.main) {
	try {
		if (process.argv.includes("--validate-current-tree")) await validateCurrentTreeManifest();
		else if (process.argv.includes("--write-manifest")) await writeManifest();
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
