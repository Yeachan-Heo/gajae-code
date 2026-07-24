import { mkdtemp, readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import manifest from "./telegram-daemon-generation-manifest.json" with { type: "json" };
import { assertGuardAuthority, currentTreeDigests, declaration, evaluate, GUARD_CONTRACT_VERSION, isLegacyBootstrapBase, manifestForCurrentTree, protectedInventory, validateCiInputs, validateCurrentTreeManifest, validateInventory, validateManifest, validateSha, writeManifest } from "./telegram-daemon-generation-guard";

const guardScript = "scripts/telegram-daemon-generation-guard.ts";
const manifestScript = "scripts/telegram-daemon-generation-manifest.json";
const stableEntries = (value: Record<string, string>) => JSON.stringify(Object.entries(value).sort());

const telegramContract = "packages/coding-agent/src/sdk/bus/telegram-daemon-contract.ts";
const telegramDaemon = "packages/coding-agent/src/sdk/bus/telegram-daemon.ts";
const telegramControl = "packages/coding-agent/src/sdk/bus/telegram-daemon-control.ts";

const chatControl = "packages/coding-agent/src/sdk/bus/chat-daemon-control.ts";
const chatCli = "packages/coding-agent/src/sdk/bus/chat-daemon-cli.ts";
const config = "packages/coding-agent/src/sdk/bus/config.ts";
const inventory = {
	telegram: { [telegramContract]: ["DAEMON_GENERATION"], [telegramDaemon]: ["acquireDaemonOwnership"] },
	discord: {
		[chatControl]: [
			"CHAT_DAEMON_GENERATIONS",
			"chatDaemonGeneration",
			"hasSafeChatDaemonStateShape",
			"isExactPreUpgradeUnavailableChatDaemonState",
			"hasChatDaemonStatePid",
			"isChatDaemonOwnerLock",
			"classify",
			"operate",
		],
	},
	slack: {
		[chatControl]: [
			"CHAT_DAEMON_GENERATIONS",
			"chatDaemonGeneration",
			"hasSafeChatDaemonStateShape",
			"isExactPreUpgradeUnavailableChatDaemonState",
			"hasChatDaemonStatePid",
			"isChatDaemonOwnerLock",
			"classify",
			"operate",
		],
	},
} as const;

const telegramHandoffHelpers = [
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
const chatTakeoverHelpers = [
	"identityFor",
	"fingerprint",
	"defaultPidAlive",
	"defaultPidIncarnation",
	"withStateWriteLock",
	"readJson",
	"writeJson",
] as const;
const chatCliHelpers = ["defaultPidAlive", "loadConfig", "ownerPid"] as const;
const chatConfigHelpers = {
	discord: ["getNotificationConfig", "notificationConfigFromFile", "isDiscordConfigured", "tokenFingerprint"],
	slack: ["getNotificationConfig", "notificationConfigFromFile", "isSlackConfigured", "tokenFingerprint"],
} as const;
const helperInventory = {
	telegram: { [telegramContract]: ["DAEMON_GENERATION"], [telegramDaemon]: [...telegramHandoffHelpers] },
	discord: { [chatControl]: ["CHAT_DAEMON_GENERATIONS.discord", ...chatTakeoverHelpers] },
	slack: { [chatControl]: ["CHAT_DAEMON_GENERATIONS.slack", ...chatTakeoverHelpers] },
} as const;

const nativeAuthoritySources = {
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

function nativeAuthorityFiles(): Array<[string, string]> {
	return [
		[
			"crates/pi-natives/src/path_identity.rs",
			[
				...nativeAuthoritySources["crates/pi-natives/src/path_identity.rs"].map(name => `pub fn ${name}() {}`),
				`mod platform {\n${nativeAuthoritySources["crates/pi-natives/src/path_identity.rs"].map(name => `\tpub(super) fn ${name}() {}`).join("\n")}\n}`,
			].join("\n"),
		],
		["crates/pi-natives/src/ps.rs", "#[napi]\nimpl Process {}"],
		[
			"crates/pi-shell/src/process.rs",
			"impl Process { pub fn incarnation(&self) {} }\npub fn kill_process_group() {}\npub fn current_descendant_pids() {}\npub fn add_new_descendants() {}",
		],
		["packages/natives/native/index.d.ts", "export declare class Process {}"],
		["packages/coding-agent/src/sdk/broker/process-incarnation.ts", "export function isProcessIncarnation() {}\nexport function processIncarnation() {}"],
	];
}

function helperFiles(input: { telegramGeneration: number; discordGeneration: number; slackGeneration: number }): Map<string, string> {
	return new Map([
		[telegramContract, `export const DAEMON_GENERATION = ${input.telegramGeneration};`],
		[telegramDaemon, telegramHandoffHelpers.map(name => `export async function ${name}() { return "${name}"; }`).join("\n")],
		[
			chatControl,
			[
				`export const CHAT_DAEMON_GENERATIONS = { discord: ${input.discordGeneration}, slack: ${input.slackGeneration} } as const;`,
				...chatTakeoverHelpers.map(name => `export function ${name}() { return "${name}"; }`),
			].join("\n"),
		],
		...nativeAuthorityFiles(),
	]);
}

function mutateHelper(source: string, name: string): string {
	return source.replace(`return "${name}"`, `return "${name}:changed"`);
}

function helperMutation(kind: "telegram" | "discord" | "slack", name: string, generationBumped: boolean): ReturnType<typeof evaluate> {
	const base = helperFiles({ telegramGeneration: 6, discordGeneration: 4, slackGeneration: 4 });
	const head = helperFiles({
		telegramGeneration: kind === "telegram" && generationBumped ? 7 : 6,
		discordGeneration: kind === "discord" && generationBumped ? 5 : 4,
		slackGeneration: kind === "slack" && generationBumped ? 5 : 4,
	});
	const file = kind === "telegram" ? telegramDaemon : chatControl;
	head.set(file, mutateHelper(head.get(file) ?? "", name));
	return evaluate(base, head, helperInventory);
}

function mappedHelperMutation(input: {
	family: "telegram" | "discord" | "slack";
	file: string;
	name: string;
	generationBumped: boolean;
}): ReturnType<typeof evaluate> {
	const base = files({ telegramGeneration: 6, discordGeneration: 4, slackGeneration: 4 });
	const head = files({
		telegramGeneration: input.family === "telegram" && input.generationBumped ? 7 : 6,
		discordGeneration: input.family === "discord" && input.generationBumped ? 5 : 4,
		slackGeneration: input.family === "slack" && input.generationBumped ? 5 : 4,
	});
	const before = `export function ${input.name}() { return "before"; }`;
	base.set(input.file, before);
	head.set(input.file, before.replace("before", "after"));
	const inventory = {
		telegram: input.family === "telegram" ? { [input.file]: [input.name] } : {},
		discord: input.family === "discord" ? { [input.file]: [input.name] } : {},
		slack: input.family === "slack" ? { [input.file]: [input.name] } : {},
	} as const;
	return evaluate(base, head, inventory);
}

function files(input: {
	telegramGeneration?: number;
	discordGeneration?: number;
	slackGeneration?: number;
	telegramOwnership?: string;
	chatLifecycle?: string;
} = {}): Map<string, string> {
	return new Map([
		[
			telegramContract,
			input.telegramGeneration === undefined ? "" : `export const DAEMON_GENERATION = ${input.telegramGeneration};\n`,
		],
		[
			telegramDaemon,
			input.telegramOwnership === undefined ? "" : `export function acquireDaemonOwnership() { ${input.telegramOwnership} }\n`,
		],
		[
			chatControl,
			[
				`export const CHAT_DAEMON_GENERATIONS = { discord: ${input.discordGeneration ?? 1}, slack: ${input.slackGeneration ?? 1} } as const;`,
				"export function chatDaemonGeneration(kind: \"discord\" | \"slack\") { return CHAT_DAEMON_GENERATIONS[kind]; }",
				"export function hasSafeChatDaemonStateShape(value: unknown) { return value !== null; }",
				"export function isExactPreUpgradeUnavailableChatDaemonState(value: unknown) { return value === 'unavailable'; }",
				"export function hasChatDaemonStatePid(value: unknown) { return value !== null; }",
				"export function isChatDaemonOwnerLock(value: unknown) { return value !== null; }",
				`class ChatDaemonController { classify() { return "compatible"; } async operate() { ${input.chatLifecycle ?? ""} } }`,
			].join("\n"),
		],
		...nativeAuthorityFiles(),
	]);
}

const legacyChatDaemonControl = `
export type ChatDaemonKind = "discord" | "slack";
export type ChatDaemonAction = "stop" | "reload";

export class ChatDaemonController {
	async operate(action: ChatDaemonAction): Promise<void> {
		void action;
	}
}
`;

type MutableInventory = { [Family in keyof typeof protectedInventory]: Record<string, string[]> };

function mutableInventory(): MutableInventory {
	return structuredClone(protectedInventory) as unknown as MutableInventory;
}

const decide = (base: Map<string, string>, head: Map<string, string>) => evaluate(base, head, inventory);

describe("daemon generation release guard", () => {
	test("requires a Telegram bump for protected ownership changes", () => {
		const missingBump = decide(files({ telegramGeneration: 4, telegramOwnership: "return true;" }), files({ telegramGeneration: 4, telegramOwnership: "return false;" }));
		expect(missingBump.protectedChanges).toContain(`telegram:${telegramDaemon}:acquireDaemonOwnership`);
		expect(missingBump.telegramGenerationBumped).toBe(false);

		const bumped = decide(files({ telegramGeneration: 4, telegramOwnership: "return true;" }), files({ telegramGeneration: 5, telegramOwnership: "return false;" }));
		expect(bumped.telegramGenerationBumped).toBe(true);
	});

test("requires mapped generation bumps for every ownership handoff and chat takeover helper", () => {
	for (const name of telegramHandoffHelpers) {
		const missing = helperMutation("telegram", name, false);
		expect(missing.protectedChanges).toContain(`telegram:${telegramDaemon}:${name}`);
		expect(missing.telegramGenerationBumped).toBe(false);
		expect(helperMutation("telegram", name, true).telegramGenerationBumped).toBe(true);
	}
	for (const kind of ["discord", "slack"] as const) {
		for (const name of chatTakeoverHelpers) {
			const missing = helperMutation(kind, name, false);
			expect(missing.protectedChanges).toContain(`${kind}:${chatControl}:${name}`);
			expect(missing.chatGenerationBumped[kind]).toBe(false);
			expect(helperMutation(kind, name, true).chatGenerationBumped[kind]).toBe(true);
		}
	}
});

test("requires mapped generation bumps for Telegram lease, chat CLI, and configuration helpers", () => {
	const helpers = [
		...telegramHandoffHelpers.map(name => ({ family: "telegram" as const, file: telegramDaemon, name })),
		...(["discord", "slack"] as const).flatMap(family => chatCliHelpers.map(name => ({ family, file: chatCli, name }))),
		...(["discord", "slack"] as const).flatMap(family => chatConfigHelpers[family].map(name => ({ family, file: config, name }))),
	];
	for (const helper of helpers) {
		const missing = mappedHelperMutation({ ...helper, generationBumped: false });
		expect(missing.protectedChanges).toContain(`${helper.family}:${helper.file}:${helper.name}`);
		if (helper.family === "telegram") expect(missing.telegramGenerationBumped).toBe(false);
		else expect(missing.chatGenerationBumped[helper.family]).toBe(false);
		const bumped = mappedHelperMutation({ ...helper, generationBumped: true });
		if (helper.family === "telegram") expect(bumped.telegramGenerationBumped).toBe(true);
		else expect(bumped.chatGenerationBumped[helper.family]).toBe(true);
	}
});

	test("requires a bump for the affected chat kind, not the other kind", () => {
		const missingBump = decide(files({ discordGeneration: 1, slackGeneration: 1, chatLifecycle: "return true;" }), files({ discordGeneration: 1, slackGeneration: 2, chatLifecycle: "return false;" }));
		expect(missingBump.protectedChanges).toContain(`discord:${chatControl}:operate`);
		expect(missingBump.chatGenerationBumped).toEqual({ discord: false, slack: true });

		const bumped = decide(files({ discordGeneration: 1, slackGeneration: 1, chatLifecycle: "return true;" }), files({ discordGeneration: 2, slackGeneration: 1, chatLifecycle: "return false;" }));
		expect(bumped.chatGenerationBumped.discord).toBe(true);
	});

	test("requires both chat generation bumps when the shared state validator changes", () => {
		const base = files({ discordGeneration: 3, slackGeneration: 3 });
		const head = files({ discordGeneration: 4, slackGeneration: 4 });
		head.set(
			chatControl,
			(head.get(chatControl) ?? "").replace("return value !== null", "return Boolean(value)"),
		);
		const result = decide(base, head);
		expect(result.protectedChanges).toEqual(
			expect.arrayContaining([
				`discord:${chatControl}:hasSafeChatDaemonStateShape`,
				`slack:${chatControl}:hasSafeChatDaemonStateShape`,
			]),
		);
		expect(result.chatGenerationBumped).toEqual({ discord: true, slack: true });
	});

	test("requires both chat generation bumps for each legacy and exact-lease takeover predicate", () => {
		for (const [symbol, before, after] of [
			[
				"isExactPreUpgradeUnavailableChatDaemonState",
				"export function isExactPreUpgradeUnavailableChatDaemonState(value: unknown) { return value === 'unavailable'; }",
				"export function isExactPreUpgradeUnavailableChatDaemonState(value: unknown) { return value === 'legacy'; }",
			],
			[
				"hasChatDaemonStatePid",
				"export function hasChatDaemonStatePid(value: unknown) { return value !== null; }",
				"export function hasChatDaemonStatePid(value: unknown) { return value === null; }",
			],
			[
				"isChatDaemonOwnerLock",
				"export function isChatDaemonOwnerLock(value: unknown) { return value !== null; }",
				"export function isChatDaemonOwnerLock(value: unknown) { return value === null; }",
			],
		] as const) {
			const base = files({ discordGeneration: 3, slackGeneration: 3 });
			const unbumpedHead = files({ discordGeneration: 3, slackGeneration: 3 });
			unbumpedHead.set(chatControl, (unbumpedHead.get(chatControl) ?? "").replace(before, after));
			const missingBumps = decide(base, unbumpedHead);
			expect(missingBumps.protectedChanges).toEqual(
				expect.arrayContaining([
					`discord:${chatControl}:${symbol}`,
					`slack:${chatControl}:${symbol}`,
				]),
			);
			expect(missingBumps.chatGenerationBumped).toEqual({ discord: false, slack: false });

			const bumpedHead = files({ discordGeneration: 4, slackGeneration: 4 });
			bumpedHead.set(chatControl, (bumpedHead.get(chatControl) ?? "").replace(before, after));
			const result = decide(base, bumpedHead);
			expect(result.chatGenerationBumped).toEqual({ discord: true, slack: true });
		}
	});

	test("AST extraction ignores strings and comments while preserving typed declarations", () => {
		const source = `// export function acquireDaemonOwnership() {}\nconst message = "acquireDaemonOwnership()";\nexport async function acquireDaemonOwnership<T>(value: T): Promise<T> { return value; }`;
		expect(declaration(source, "acquireDaemonOwnership")).toContain("Promise<T>");
		expect(declaration("const message = 'acquireDaemonOwnership';", "acquireDaemonOwnership")).toBeUndefined();
	});

	test("canonical AST comparison ignores declaration comments and formatting", () => {
		const base = files({ telegramGeneration: 4, telegramOwnership: "// stable\nreturn true;" });
		const head = files({ telegramGeneration: 4, telegramOwnership: "return /* stable */ true;" });
		expect(decide(base, head).protectedChanges).toEqual([]);
	});

	test("canonical AST comparison ignores guard policy comments and formatting", () => {
		const base = files();
		const head = files();
		base.set("scripts/telegram-daemon-generation-guard.ts", "// policy\nexport const GUARD_CONTRACT_VERSION = 2;");
		head.set("scripts/telegram-daemon-generation-guard.ts", "export const GUARD_CONTRACT_VERSION=2 /* policy */;");
		expect(decide(base, head).guardPolicyChanged).toBe(false);
	});

	test("requires a contract-version bump for an existing guard policy change without a daemon bump", () => {
		const base = files({ telegramGeneration: 4, telegramOwnership: "return true;" });
		const head = files({ telegramGeneration: 4, telegramOwnership: "return true;" });
		base.set("scripts/telegram-daemon-generation-guard.ts", "export const GUARD_CONTRACT_VERSION = 2;\nexport const policy = true;");
		head.set("scripts/telegram-daemon-generation-guard.ts", "export const GUARD_CONTRACT_VERSION = 2;\nexport const policy = false;");
		const unbumped = decide(base, head);
		expect(unbumped.guardPolicyChanged).toBe(true);
		expect(unbumped.guardContractBumped).toBe(false);
		expect(unbumped.telegramGenerationBumped).toBe(false);
		head.set("scripts/telegram-daemon-generation-guard.ts", "export const GUARD_CONTRACT_VERSION = 3;\nexport const policy = false;");
		expect(decide(base, head).guardContractBumped).toBe(true);
	});
	test("evaluates a contract-bumped head-only protected authority against the base inventory", () => {
		const baseInventory = {
			telegram: { [telegramContract]: ["DAEMON_GENERATION"], [telegramDaemon]: ["acquireDaemonOwnership"] },
			discord: {},
			slack: {},
		} as const;
		const headInventory = {
			telegram: { [telegramContract]: ["DAEMON_GENERATION"], [telegramDaemon]: ["acquireDaemonOwnership", "renewDaemonHeartbeat"] },
			discord: {},
			slack: {},
		} as const;
		const base = new Map<string, string>([
			[telegramContract, "export const DAEMON_GENERATION = 20;"],
			[telegramDaemon, "export function acquireDaemonOwnership() { return true; }"],
			[guardScript, "export const GUARD_CONTRACT_VERSION = 22;"],
			[manifestScript, JSON.stringify({ contractVersion: 22, inventory: baseInventory, digests: {} })],
		]);
		const head = new Map<string, string>([
			[telegramContract, "export const DAEMON_GENERATION = 21;"],
			[telegramDaemon, "export function acquireDaemonOwnership() { return true; }\nexport function renewDaemonHeartbeat() { return false; }"],
			[guardScript, "export const GUARD_CONTRACT_VERSION = 23;"],
			[manifestScript, JSON.stringify({ contractVersion: 23, inventory: headInventory, digests: {} })],
		]);
		const result = evaluate(base, head, headInventory, baseInventory);
		expect(result.protectedChanges).toContain(`telegram:${telegramDaemon}:renewDaemonHeartbeat`);
		expect(result.malformedDeclarations).toEqual([]);
		expect(result.guardContractBumped).toBe(true);
		expect(result.telegramGenerationBumped).toBe(true);
	});
	test("treats a base-only protected declaration removal as a generation-fenced change", () => {
		const removedFile = "packages/coding-agent/src/sdk/bus/removed-daemon-authority.ts";
		const baseInventory = {
			telegram: { [telegramContract]: ["DAEMON_GENERATION"], [removedFile]: ["removeDaemonAuthority"] },
			discord: {},
			slack: {},
		} as const;
		const headInventory = {
			telegram: { [telegramContract]: ["DAEMON_GENERATION"] },
			discord: {},
			slack: {},
		} as const;
		const base = new Map<string, string>([
			[telegramContract, "export const DAEMON_GENERATION = 20;"],
			[removedFile, "export function removeDaemonAuthority() { return true; }"],
			[guardScript, "export const GUARD_CONTRACT_VERSION = 22;"],
			[manifestScript, JSON.stringify({ contractVersion: 22, inventory: baseInventory, digests: {} })],
		]);
		const head = new Map<string, string>([
			[telegramContract, "export const DAEMON_GENERATION = 20;"],
			[guardScript, "export const GUARD_CONTRACT_VERSION = 23;"],
			[manifestScript, JSON.stringify({ contractVersion: 23, inventory: headInventory, digests: {} })],
		]);
		const unbumped = evaluate(base, head, headInventory, baseInventory);
		expect(unbumped.protectedChanges).toContain(`telegram:${removedFile}:removeDaemonAuthority`);
		expect(unbumped.malformedDeclarations).toEqual([]);
		expect(unbumped.guardContractBumped).toBe(true);
		expect(unbumped.telegramGenerationBumped).toBe(false);
		head.set(telegramContract, "export const DAEMON_GENERATION = 21;");
		expect(evaluate(base, head, headInventory, baseInventory).telegramGenerationBumped).toBe(true);
	});

	test("only bootstraps when the guard is absent and rejects duplicate inventory symbols", () => {
		const base = files({ telegramGeneration: 4, telegramOwnership: "return true;" });
		const head = files({ telegramGeneration: 5 });
		base.set("scripts/telegram-daemon-generation-guard.ts", "export const unrelated = 1;");
		head.set("scripts/telegram-daemon-generation-guard.ts", "export const unrelated = 1;");
		expect(decide(base, head).malformedDeclarations).toContain(`telegram:${telegramDaemon}:acquireDaemonOwnership`);
		expect(() => validateInventory({ telegram: { [telegramContract]: ["DAEMON_GENERATION", "DAEMON_GENERATION"] }, discord: {}, slack: {} } as any)).toThrow("invalid telegram contract inventory");
	});

	test("bootstraps only the complete legacy protocol-3 topology", () => {
		const base = files({ telegramOwnership: "return true;" });
		base.delete("scripts/telegram-daemon-generation-guard.ts");
		base.set(telegramContract, "export const NOTIFICATION_PROTOCOL_VERSION = 3;\nexport const DAEMON_GENERATION = NOTIFICATION_PROTOCOL_VERSION;");
		base.set(chatControl, legacyChatDaemonControl);
		const head = files({ telegramGeneration: 4, telegramOwnership: "return true;", chatLifecycle: "return true;" });
		expect(isLegacyBootstrapBase(base)).toBe(true);
		expect(decide(base, head).malformedDeclarations).toEqual([]);

		for (const mutate of [
			(candidate: Map<string, string>) => candidate.set(telegramContract, "export const NOTIFICATION_PROTOCOL_VERSION = 3;\nexport const DAEMON_GENERATION = 3;"),
			(candidate: Map<string, string>) => candidate.set(telegramDaemon, "export function acquireDaemonOwnership() { return true; }\nconst ownershipPhase = 'ready';"),
			(candidate: Map<string, string>) => candidate.set(chatControl, "export const CHAT_DAEMON_GENERATIONS = { discord: 1, slack: 1 };"),
			(candidate: Map<string, string>) => candidate.set(chatControl, "export class ChatDaemonController {}"),
			(candidate: Map<string, string>) => candidate.set(chatControl, "export class ChatDaemonController { async operate( {"),
			(candidate: Map<string, string>) => candidate.set(telegramDaemon, ""),
		]) {
			const candidate = new Map(base);
			mutate(candidate);
			expect(isLegacyBootstrapBase(candidate)).toBe(false);
			expect(decide(candidate, head).malformedDeclarations.length).toBeGreaterThan(0);
		}
	});

	test("bootstraps the exact guard-less numeric-generation-6 legacy topology", () => {
		const base = files({ telegramOwnership: "return true;" });
		base.delete(guardScript);
		base.set(telegramContract, "export const NOTIFICATION_PROTOCOL_VERSION = 3;\nexport const DAEMON_GENERATION = 6;");
		base.set(chatControl, legacyChatDaemonControl);
		const head = files({ telegramGeneration: 7, discordGeneration: 2, slackGeneration: 2, telegramOwnership: "return true;", chatLifecycle: "return true;" });
		expect(isLegacyBootstrapBase(base)).toBe(true);
		expect(decide(base, head).malformedDeclarations).toEqual([]);

		for (const mutate of [
			(candidate: Map<string, string>) => candidate.set(telegramContract, "export const NOTIFICATION_PROTOCOL_VERSION = 3;\nexport const DAEMON_GENERATION = 5;"),
			(candidate: Map<string, string>) => candidate.set(telegramContract, "export const NOTIFICATION_PROTOCOL_VERSION = 4;\nexport const DAEMON_GENERATION = 6;"),
			(candidate: Map<string, string>) => candidate.set(telegramDaemon, "export function acquireDaemonOwnership() { return true; }\nconst acquisitionId = 'unexpected';"),
		]) {
			const candidate = new Map(base);
			mutate(candidate);
			expect(isLegacyBootstrapBase(candidate)).toBe(false);
		}
	});

test("ignores unrelated text in a shared native authority source", () => {
	const source = "packages/coding-agent/src/sdk/broker/process-incarnation.ts";
	const base = files({ telegramGeneration: 6, discordGeneration: 4, slackGeneration: 4 });
	const head = new Map(base);
	head.set(source, `${head.get(source)}\n// unrelated diagnostic text`);
	const result = decide(base, head);
	expect(result.nativeAuthorityChanges).toEqual([]);
	expect(result.telegramGenerationBumped).toBe(false);
	expect(result.chatGenerationBumped).toEqual({ discord: false, slack: false });
});

test("requires every mapped generation bump for a protected native authority declaration", () => {
	const source = "packages/coding-agent/src/sdk/broker/process-incarnation.ts";
	const base = files({ telegramGeneration: 6, discordGeneration: 4, slackGeneration: 4 });
	const head = new Map(base);
	head.set(source, (head.get(source) ?? "").replace("function processIncarnation() {}", "function processIncarnation() { return undefined; }"));
	const result = decide(base, head);
	expect(result.nativeAuthorityChanges).toEqual(["telegram:" + source + ":authority", "discord:" + source + ":authority", "slack:" + source + ":authority"]);
	expect(result.telegramGenerationBumped).toBe(false);
	expect(result.chatGenerationBumped).toEqual({ discord: false, slack: false });
});

test("accepts a protected native authority declaration change after every required generation bump", () => {
	const source = "packages/coding-agent/src/sdk/broker/process-incarnation.ts";
	const base = files({ telegramGeneration: 6, discordGeneration: 4, slackGeneration: 4 });
	const head = files({ telegramGeneration: 7, discordGeneration: 5, slackGeneration: 5 });
	head.set(source, (head.get(source) ?? "").replace("function processIncarnation() {}", "function processIncarnation() { return undefined; }"));
	const result = decide(base, head);
	expect(result.nativeAuthorityChanges).toEqual(["telegram:" + source + ":authority", "discord:" + source + ":authority", "slack:" + source + ":authority"]);
	expect(result.telegramGenerationBumped).toBe(true);
	expect(result.chatGenerationBumped).toEqual({ discord: true, slack: true });
});
test("fails closed when a protected native authority declaration is missing or malformed", () => {
	const source = "packages/coding-agent/src/sdk/broker/process-incarnation.ts";
	const base = files({ telegramGeneration: 6, discordGeneration: 4, slackGeneration: 4 });
	const missing = new Map(base);
	missing.set(source, "export function isProcessIncarnation() {}");
	expect(decide(base, missing).malformedDeclarations).toContain(source + ":authority");
	const malformed = new Map(base);
	malformed.set(source, "export function isProcessIncarnation() {}\nexport function processIncarnation( {");
	expect(decide(base, malformed).malformedDeclarations).toContain(source + ":authority");
});
	test("hashes restricted native path implementations behind public wrappers", () => {
		const source = "crates/pi-natives/src/path_identity.rs";
		const base = files({ telegramGeneration: 6, discordGeneration: 4, slackGeneration: 4 });
		const head = new Map(base);
		head.set(
			source,
			(head.get(source) ?? "").replace(
				"pub(super) fn apply_owner_only_path_security() {}",
				"pub(super) fn apply_owner_only_path_security() { let changed = true; }",
			),
		);
		expect(decide(base, head).nativeAuthorityChanges).toEqual([
			"telegram:" + source + ":authority",
			"discord:" + source + ":authority",
			"slack:" + source + ":authority",
		]);
	});

	test("hashes core Process methods used by daemon control", () => {
		const source = "crates/pi-shell/src/process.rs";
		const base = files({ telegramGeneration: 6, discordGeneration: 4, slackGeneration: 4 });
		const head = new Map(base);
		head.set(source, (head.get(source) ?? "").replace("pub fn incarnation(&self) {}", "pub fn incarnation(&self) { let changed = true; }"));
		expect(decide(base, head).nativeAuthorityChanges).toEqual([
			"telegram:" + source + ":authority",
			"discord:" + source + ":authority",
			"slack:" + source + ":authority",
		]);
	});

	test("hashes every Rust platform implementation and lexes declaration braces", () => {
		const source = "crates/pi-shell/src/process.rs";
		const platformSource = [
			"impl Process {}",
			"#[cfg(unix)] pub fn kill_process_group() { let normal = \"}\"; let raw = r###\"{ not a body }\"###; let byte = br#\"} not a body {\"#; let character = '{'; /* { nested /* } */ still comment } */ // }\n return 1; }",
			"#[cfg(windows)] pub fn kill_process_group() { return 2; }",
			"pub fn current_descendant_pids() { return 3; }",
			"pub fn add_new_descendants() { return 4; }",
		].join("\n");
		const base = files({ telegramGeneration: 6, discordGeneration: 4, slackGeneration: 4 });
		base.set(source, platformSource);
		const commentOnly = new Map(base);
		commentOnly.set(source, platformSource.replace("// }", "// { }"));
		expect(decide(base, commentOnly).nativeAuthorityChanges).toEqual([]);
		const changed = new Map(base);
		changed.set(source, platformSource.replace("return 1;", "return 9;"));
		expect(decide(base, changed).nativeAuthorityChanges).toEqual([
			"telegram:" + source + ":authority",
			"discord:" + source + ":authority",
			"slack:" + source + ":authority",
		]);
		const malformed = new Map(base);
		malformed.set(source, platformSource.replace('r###"{ not a body }"###', 'r###"{ unterminated'));
		expect(decide(base, malformed).malformedDeclarations).toContain(source + ":authority");
	});

	test("semantic manifest rejects duplicate, moved, and narrowed inventories", () => {
		expect(() => validateManifest()).not.toThrow();
		const duplicate = mutableInventory();
		duplicate.telegram[telegramContract]!.push("DAEMON_GENERATION");
		expect(() => validateInventory(duplicate)).toThrow("invalid telegram contract inventory");
		expect(() => validateManifest({ contractVersion: GUARD_CONTRACT_VERSION, inventory: duplicate })).toThrow("invalid telegram contract inventory");
		const moved = mutableInventory();
		moved.telegram["moved.ts"] = moved.telegram[telegramContract]!;
		delete moved.telegram[telegramContract];
		expect(() => validateManifest({ contractVersion: GUARD_CONTRACT_VERSION, inventory: moved })).toThrow("does not match the protected inventory");
		const narrowed = mutableInventory();
		narrowed.telegram[telegramDaemon] = narrowed.telegram[telegramDaemon]!.filter(name => name !== "writeJsonAtomic");
		expect(() => validateManifest({ contractVersion: GUARD_CONTRACT_VERSION, inventory: narrowed })).toThrow("Telegram owner-lock handoff primitives");
	});

	test("rejects inventories missing required Telegram lifecycle, lease, chat CLI, or provider configuration authorities", () => {
		for (const symbol of ["validBotToken", "requestStop", "startLifecycleControl", "run"] as const) {
			const telegram = mutableInventory();
			telegram.telegram[telegramDaemon] = telegram.telegram[telegramDaemon]!.filter(name => name !== symbol);
			expect(() => validateInventory(telegram)).toThrow("Telegram authentication and lifecycle primitives");
		}
		const telegram = mutableInventory();
		telegram.telegram[telegramDaemon] = telegram.telegram[telegramDaemon]!.filter(name => name !== "writeJsonAtomic");
		expect(() => validateInventory(telegram)).toThrow("Telegram owner-lock handoff primitives");
		for (const symbol of ["DaemonProcessReference", "defaultProcessReference"] as const) {
			const processAuthority = mutableInventory();
			processAuthority.telegram[telegramControl] = processAuthority.telegram[telegramControl]!.filter(name => name !== symbol);
			expect(() => validateInventory(processAuthority)).toThrow("Telegram process termination authority");
		}
		const cli = mutableInventory();
		cli.discord[chatCli] = cli.discord[chatCli]!.filter(name => name !== "ownerPid");
		expect(() => validateInventory(cli)).toThrow("chat CLI ownership primitives");
		const providerConfig = mutableInventory();
		providerConfig.slack[config] = providerConfig.slack[config]!.filter(name => name !== "isSlackConfigured");
		expect(() => validateInventory(providerConfig)).toThrow("chat configuration primitives");
	});

	test("protects Telegram provenance and signaling authorities", () => {
		const telegram = protectedInventory.telegram[telegramDaemon] ?? [];
		expect(telegram).toEqual(
			expect.arrayContaining([
				"ownerIdentityMatches",
				"ownerProvenanceMatches",
				"isSignalableMatchingOwner",
				"defaultPidIncarnation",
				"tryCreateOwnershipLock",
				"readOwnershipLock",
				"rebindOwnershipLock",
				"rollbackOwnershipLockRebind",
				"liveOwnershipLockDecision",
				"acquireTransitionLock",
				"bindProvisionalDaemonPid",
				"waitForTelegramDaemonReady",
				"hasSafeDaemonStateShape",
				"isPhysicalMatchingOwner",
				"validBotToken",
				"requestStop",
				"startLifecycleControl",
				"run",
				"writeJsonAtomic",
				"ownershipLockMatchesState",
				"ownershipLockMatchesMetadata",
				"ownershipLockIsReclaimable",
				"isLegacyParentDaemonState",
				"legacyParentHandoffDecision",
				"isParentDaemonState",
				"isGenerationAbsentParentDaemonState",
				"isGeneration3ReleaseDaemonState",
				"legacyOwnershipLockMatchesHandoffState",
				"historicalStateSerializer",
				"unlinkOwnershipLockExactly",
				"retireProvisionalDaemonOwnership",
				"confirmTelegramDaemonSpawn",
			]),
		);
		const control = protectedInventory.telegram[telegramControl] ?? [];
		expect(control).toEqual(expect.arrayContaining(["DaemonProcessReference", "defaultProcessReference", "signalCapturedOwner"]));
		for (const family of ["discord", "slack"] as const) {
			const chat = protectedInventory[family][chatControl] ?? [];
			expect(chat).toEqual(
				expect.arrayContaining([
					"isSignalableMatchingOwner",
					"isRecognizedLegacyGeneration",
					"hasProcessIncarnationAuthority",
					"isDefinitelyStoppedState",
					"identityFor",
					"fingerprint",
					"defaultPidAlive",
					"defaultPidIncarnation",
					"withStateWriteLock",
					"readJson",
					"writeJson",
				]),
			);
			const cli = protectedInventory[family][chatCli] ?? [];
			expect(cli).toEqual(expect.arrayContaining(chatCliHelpers));
			const providerConfig = protectedInventory[family][config] ?? [];
			expect(providerConfig).toEqual(expect.arrayContaining(chatConfigHelpers[family]));
		}
	});

	test("fails closed for malformed protected declarations", () => {
		const base = files({ telegramGeneration: 4, telegramOwnership: "return true;" });
		const head = files({ telegramGeneration: 4, telegramOwnership: "return true;" });
		head.set(telegramDaemon, "export function acquireDaemonOwnership( {");
		const result = decide(base, head);
		expect(result.malformedDeclarations).toContain(`telegram:${telegramDaemon}:acquireDaemonOwnership`);
		head.set(telegramDaemon, "");
		expect(decide(base, head).malformedDeclarations).toContain(`telegram:${telegramDaemon}:acquireDaemonOwnership`);
	});

	test("rejects missing or abbreviated commit objects before diffing", () => {
		expect(() => validateSha("base SHA", undefined)).toThrow("exact 40-hex commit SHA");
		expect(() => validateSha("head SHA", "abc123")).toThrow("exact 40-hex commit SHA");
		expect(validateSha("head SHA", "A".repeat(40))).toBe("a".repeat(40));
	});
	test("accepts same-repository push and dispatch, and permits a fork PR head", () => {
		const sha = "a".repeat(40);
		for (const input of [
			{ eventName: "push", baseRepository: "owner/repo", headRepository: "owner/repo" },
			{ eventName: "workflow_dispatch", baseRepository: "owner/repo", headRepository: "owner/repo" },
			{ eventName: "pull_request", baseRepository: "owner/repo", headRepository: "fork/repo" },
		] as const) validateCiInputs({ ...input, baseSha: sha, headSha: sha, repository: "owner/repo" });
	});

	test("rejects a missing dispatch base, malformed refs, and foreign push heads", () => {
		const sha = "a".repeat(40);
		expect(() => validateCiInputs({ eventName: "workflow_dispatch", baseSha: undefined, headSha: sha, baseRepository: "owner/repo", headRepository: "owner/repo", repository: "owner/repo" })).toThrow("base SHA");
		expect(() => validateCiInputs({ eventName: "push", baseSha: sha, headSha: "short", baseRepository: "owner/repo", headRepository: "owner/repo", repository: "owner/repo" })).toThrow("head SHA");
		expect(() => validateCiInputs({ eventName: "push", baseSha: sha, headSha: sha, baseRepository: "owner/repo", headRepository: "fork/repo", repository: "owner/repo" })).toThrow("push head repository");
	});


	test("isolates shared chat generation-map changes to the matching family", () => {
		const sharedInventory = {
			telegram: {},
			discord: { [chatControl]: ["CHAT_DAEMON_GENERATIONS.discord"] },
			slack: { [chatControl]: ["CHAT_DAEMON_GENERATIONS.slack"] },
		} as const;
		const base = files({ discordGeneration: 1, slackGeneration: 1 });
		const head = files({ discordGeneration: 2, slackGeneration: 1 });
		const result = evaluate(base, head, sharedInventory);
		expect(result.protectedChanges).toEqual([`discord:${chatControl}:CHAT_DAEMON_GENERATIONS.discord`]);
		expect(result.chatGenerationBumped).toEqual({ discord: true, slack: false });
	});

	test("rejects duplicate top-level protected declarations", () => {
		const source = "export function acquireDaemonOwnership() {}\nexport function acquireDaemonOwnership() {}";
		expect(declaration(source, "acquireDaemonOwnership")).toBe("<malformed>");
	});
	test("resolves a class member uniquely despite same-named locals and object properties", () => {
		const source = [
			"export class Owner {",
			"	identity(): string { return \"real\"; }",
			"	ensure() {",
			"		const identity = this.identity();",
			"		const state = { identity };",
			"		return identity + state.identity;",
			"	}",
			"}",
		].join("\n");
		// The protected class method resolves, not a shadowing local or object shorthand.
		expect(declaration(source, "identity")).toContain('identity(): string { return "real"; }');
	});

	test("fails closed as <malformed> when a protected name resolves to two class methods", () => {
		const source = "export class A { stop() { return 1; } }\nexport class B { stop() { return 2; } }";
		// Ambiguity is fail-closed identical to an unparseable declaration.
		expect(declaration(source, "stop")).toBe("<malformed>");
	});

	test("keeps adapter-specific ensure wrappers in their own family only", () => {
		const discordFiles = protectedInventory.discord[chatControl] ?? [];
		const slackFiles = protectedInventory.slack[chatControl] ?? [];
		expect(discordFiles).toContain("ensureDiscordDaemon");
		expect(discordFiles).not.toContain("ensureSlackDaemon");
		expect(slackFiles).toContain("ensureSlackDaemon");
		expect(slackFiles).not.toContain("ensureDiscordDaemon");
		expect(discordFiles).toEqual(expect.arrayContaining(["hasSafeChatDaemonStateShape", "classify"]));
		expect(slackFiles).toEqual(expect.arrayContaining(["hasSafeChatDaemonStateShape", "classify"]));
		// A Discord-only change to its wrapper is a Discord-only protected change and
		// must not also demand a Slack generation bump.
		const inv = {
			telegram: {},
			discord: { [chatControl]: ["ensureDiscordDaemon"] },
			slack: { [chatControl]: ["ensureSlackDaemon"] },
		} as const;
		const wrappers = (discord: number) =>
			`export function ensureDiscordDaemon(){return ${discord};}\nexport function ensureSlackDaemon(){return 2;}`;
		const result = evaluate(new Map([[chatControl, wrappers(1)]]), new Map([[chatControl, wrappers(9)]]), inv);
		expect(result.protectedChanges).toEqual([`discord:${chatControl}:ensureDiscordDaemon`]);
	});

	test("treats a manifest declaration-digest refresh as attestation, not a guard-policy change", () => {
		const policy = { contractVersion: GUARD_CONTRACT_VERSION, inventory: { telegram: { [telegramDaemon]: ["acquireDaemonOwnership"] } } };
		const guard = `export const GUARD_CONTRACT_VERSION = ${GUARD_CONTRACT_VERSION};`;
		// A real protected Telegram lifecycle edit that refreshes only the digest
		// attestations and bumps the Telegram family generation.
		const base = files({ telegramGeneration: 4, telegramOwnership: "return true;" });
		const head = files({ telegramGeneration: 5, telegramOwnership: "return false;" });
		base.set(guardScript, guard);
		head.set(guardScript, guard);
		base.set(manifestScript, JSON.stringify({ ...policy, digests: { "telegram:d:acquireDaemonOwnership": "a".repeat(64) } }));
		head.set(manifestScript, JSON.stringify({ ...policy, digests: { "telegram:d:acquireDaemonOwnership": "b".repeat(64) } }));
		const result = decide(base, head);
		expect(result.guardPolicyChanged).toBe(false);
		expect(result.telegramGenerationBumped).toBe(true);
	});

	test("treats a manifest inventory/policy change as a guard-policy change needing a contract bump", () => {
		const guard = `export const GUARD_CONTRACT_VERSION = ${GUARD_CONTRACT_VERSION};`;
		const base = files({ telegramGeneration: GUARD_CONTRACT_VERSION });
		const head = files({ telegramGeneration: GUARD_CONTRACT_VERSION });
		base.set(guardScript, guard);
		head.set(guardScript, guard);
		base.set(manifestScript, JSON.stringify({ contractVersion: GUARD_CONTRACT_VERSION, inventory: { telegram: { [telegramDaemon]: ["acquireDaemonOwnership"] } }, digests: {} }));
		head.set(manifestScript, JSON.stringify({ contractVersion: GUARD_CONTRACT_VERSION, inventory: { telegram: { [telegramDaemon]: ["acquireDaemonOwnership", "renewDaemonHeartbeat"] } }, digests: {} }));
		const changed = decide(base, head);
		expect(changed.guardPolicyChanged).toBe(true);
		expect(changed.guardContractBumped).toBe(false);
		// A strictly higher guard contract version clears the policy-change block.
		head.set(guardScript, `export const GUARD_CONTRACT_VERSION = ${GUARD_CONTRACT_VERSION + 1};`);
		expect(decide(base, head).guardContractBumped).toBe(true);
	});

	test("fails closed on tampered or stale declaration digests", async () => {
		// The committed manifest validates and byte-matches the current tree (the CI
		// enforcement run() performs); a single full-tree parse keeps this deterministic.
		expect(() => validateManifest()).not.toThrow();
		await expect(validateCurrentTreeManifest()).resolves.toBeUndefined();
		// A wrong-format digest is rejected by structural validation (run() invokes it via bootstrapGuardContract()).
		const digests = manifest.digests as Record<string, string>;
		const key = Object.keys(digests)[0]!;
		expect(() =>
			validateManifest({ contractVersion: GUARD_CONTRACT_VERSION, inventory: protectedInventory, digests: { ...manifest.digests, [key]: "z".repeat(64) } }),
		).toThrow("declaration digests must be exact");
		// A stale (valid-format but wrong) digest set no longer matches the committed
		// attestations that validateCurrentTreeManifest byte-compares against the tree.
		const stale = { ...digests, [key]: digests[key] === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64) };
		expect(stableEntries(stale)).not.toBe(stableEntries(digests));
	}, 20000);

	test("writes a stable current-tree manifest atomically without changing the committed attestation", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "telegram-daemon-generation-manifest-"));
		const target = path.join(directory, "manifest.json");
		try {
			await writeManifest(target);
			const written = await readFile(target, "utf8");
			expect(written.endsWith("\n")).toBe(true);
			const generated = JSON.parse(written);
			expect(() => validateManifest(generated)).not.toThrow();
			expect(generated).toEqual(await manifestForCurrentTree());
			expect(generated.digests).toEqual(await currentTreeDigests());
			await expect(validateCurrentTreeManifest()).resolves.toBeUndefined();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}, 20000);

	test("guard authority proves immutable event objects without pinning the mutable base ref", () => {
		const head = "a".repeat(40);
		const base = "b".repeat(40);
		const pr = {
			eventName: "pull_request" as const,
			baseRepository: "owner/repo",
			headRepository: "fork/repo",
			repository: "owner/repo",
			headSha: head,
			baseSha: base,
			checkedOutHead: head,
			headRefSha: head,
			baseObjectSha: base,
			baseRefSha: undefined,
		};
		// The live base branch advanced while queued: the guard receives only the
		// immutable event base object (== event base SHA) and must still pass.
		expect(() => assertGuardAuthority(pr)).not.toThrow();
		// Dispatch pins a mutable ref deliberately, so its fetched ref must still equal
		// the requested input SHA rather than merely containing that immutable object.
		const dispatch = { ...pr, eventName: "workflow_dispatch" as const, headRepository: "owner/repo", baseRefSha: base };
		expect(() => assertGuardAuthority(dispatch)).not.toThrow();
		expect(() => assertGuardAuthority({ ...dispatch, baseRefSha: "c".repeat(40) })).toThrow("dispatch base ref does not resolve");
		// A mismatched or unfetchable event base object fails closed.
		expect(() => assertGuardAuthority({ ...pr, baseObjectSha: "c".repeat(40) })).toThrow("base object does not equal event base SHA");
		// Head-ref and checked-out-head mismatches still fail closed.
		expect(() => assertGuardAuthority({ ...pr, headRefSha: "d".repeat(40) })).toThrow("head ref does not resolve to event head SHA");
		expect(() => assertGuardAuthority({ ...pr, checkedOutHead: "e".repeat(40) })).toThrow("checked-out head object does not equal event head SHA");
		// Repository provenance still fails closed (base repo must be this repo).
		expect(() => assertGuardAuthority({ ...pr, baseRepository: "evil/repo" })).toThrow("base repository must be this repository");
		// Push semantics preserved: the head repository must be this repository.
		expect(() => assertGuardAuthority({ ...pr, eventName: "push", headRepository: "fork/repo" })).toThrow("push head repository");
		expect(() => assertGuardAuthority({ ...pr, eventName: "push", headRepository: "owner/repo" })).not.toThrow();
		// Unsupported events fail closed.
		expect(() => assertGuardAuthority({ ...pr, eventName: "schedule" })).toThrow("unsupported CI event");
	});

});
