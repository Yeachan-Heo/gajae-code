import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CliParseError } from "@gajae-code/utils/cli";
import { Settings } from "../config/settings";
import {
	assertCanonicalCoordinatorWorkdir,
	assertCoordinatorAuthorityUnchanged,
	type FrozenCoordinatorAuthority,
	freezeCoordinatorAuthority,
} from "../master/authority";
import type { MasterCoordinatorGateway } from "../master/coordinator-gateway";
import {
	MasterDaemonController,
	type MasterDaemonOperationResult,
	type MasterDaemonStatus,
} from "../master/daemon-control";
import { MasterDomainStore } from "../master/domain-store";
import { assertCanonicalMasterName, isCanonicalMasterName } from "../master/paths";
import {
	type ConfigureCapacityResult,
	DEFAULT_MAX_CONCURRENT_WORKERS,
	type MasterDomainStoreOptions,
	type MasterListItem,
	type MasterProvider,
	type MasterRecord,
	MasterStoreError,
} from "../master/types";
import { getNotificationConfig, isProviderComplete, isProviderEffectivelyEnabled } from "../sdk/bus/config";

export type MasterCommandAction = "create" | "list" | "configure";

export interface MasterCommandArgs {
	action: MasterCommandAction;
	name?: string;
	workdir?: string;
	maxConcurrentWorkers?: number;
	json?: boolean;
}

export interface MasterFs {
	lstat(target: string): Promise<{
		isDirectory(): boolean;
		isSymbolicLink(): boolean;
	}>;
	realpath(target: string): Promise<string>;
}

export interface MasterDaemonControlLike {
	readonly status?: () => Promise<MasterDaemonStatus>;
	readonly reload: () => Promise<MasterDaemonOperationResult>;
}

export interface MasterStoreLike {
	readRecord(): Promise<MasterRecord>;
	configureMaxConcurrentWorkers(maxConcurrentWorkers: number): Promise<ConfigureCapacityResult>;
}

export interface MasterCommandDeps {
	readonly masterRootDir?: string;
	readonly configRootDir?: string;
	readonly rootDir?: string;
	readonly now?: () => Date;
	readonly env?: NodeJS.ProcessEnv;
	readonly configuredProviders?: readonly MasterProvider[];
	readonly fs?: MasterFs;
	readonly authority?: FrozenCoordinatorAuthority;
	readonly coordinatorGateway?: MasterCoordinatorGateway;
	readonly createAuthority?: (env: NodeJS.ProcessEnv) => Promise<FrozenCoordinatorAuthority>;
	readonly admitWorkdir?: (workdir: string) => string | Promise<string>;
	readonly assertAuthority?: (action: MasterCommandAction) => void | Promise<void>;
	readonly authorize?: (workdir: string, action: MasterCommandAction) => boolean | Promise<boolean>;
	readonly daemonController?: MasterDaemonControlLike;
	readonly daemon?: MasterDaemonControlLike;
	readonly controller?: MasterDaemonControlLike;
	readonly createStore?: (options: MasterDomainStoreOptions) => Promise<MasterStoreLike>;
	readonly openStore?: (options: MasterDomainStoreOptions) => Promise<MasterStoreLike>;
	readonly listStores?: (options: Omit<MasterDomainStoreOptions, "masterName">) => Promise<MasterListItem[]>;
	readonly writeStdout?: (text: string) => void;
	readonly writeStderr?: (text: string) => void;
}

export interface MasterCommandResult {
	readonly action: MasterCommandAction;
	readonly ok: boolean;
	readonly record?: MasterRecord;
	readonly masters?: readonly MasterListItem[];
	readonly capacity?: ConfigureCapacityResult;
	readonly daemon?: MasterDaemonOperationResult;
	readonly error?: string;
}

export class MasterCommandError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "MasterCommandError";
		this.code = code;
	}
}

const ACTIONS: readonly MasterCommandAction[] = ["create", "list", "configure"];
const FLAG_NAMES = new Set(["--json", "--workdir", "--max-concurrent-workers"]);

function fail(message: string): never {
	throw new CliParseError(message);
}

function parseCapacity(raw: string, flagName = "--max-concurrent-workers"): number {
	if (!/^[0-9]+$/.test(raw)) fail(`Expected ${flagName} to be a positive safe integer, got "${raw}"`);
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value <= 0)
		fail(`Expected ${flagName} to be a positive safe integer, got "${raw}"`);
	return value;
}

function parseFlagValue(args: readonly string[], index: number, flag: string): { value: string; next: number } {
	const token = args[index] ?? "";
	if (token === flag) {
		const value = args[index + 1];
		if (value === undefined || value.startsWith("-")) fail(`Missing value for ${flag}`);
		return { value, next: index + 1 };
	}
	const prefix = `${flag}=`;
	if (token.startsWith(prefix)) {
		const value = token.slice(prefix.length);
		if (value.length === 0) fail(`Missing value for ${flag}`);
		return { value, next: index };
	}
	fail(`Unknown option: ${token}`);
}

/** Parse the exact root invocation for `gjc master`. */
export function parseMasterArgs(args: string[]): MasterCommandArgs | undefined {
	if (args.length === 0 || args[0] !== "master") return undefined;
	const rest = args.slice(1);
	if (rest[0] === "--help" || rest[0] === "-h") return { action: "list", json: false };

	let action: MasterCommandAction = "list";
	let index = 0;
	const first = rest[0];
	if (first !== undefined && !first.startsWith("-")) {
		if (!(ACTIONS as readonly string[]).includes(first)) fail(`Unknown master command: ${first}`);
		action = first as MasterCommandAction;
		index = 1;
	}

	let name: string | undefined;
	let workdir: string | undefined;
	let maxConcurrentWorkers: number | undefined;
	let json = false;
	const seen = new Set<string>();
	for (; index < rest.length; index++) {
		const token = rest[index] ?? "";
		if (!token.startsWith("-")) {
			if (name !== undefined) fail(`Unexpected argument: ${JSON.stringify(token)}`);
			name = token;
			continue;
		}
		if (!FLAG_NAMES.has(token) && ![...FLAG_NAMES].some(flag => token.startsWith(`${flag}=`)))
			fail(`Unknown option: ${token}`);
		const flag = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
		if (seen.has(flag)) fail(`Duplicate option: ${flag}`);
		seen.add(flag);
		if (flag === "--json") {
			if (token.includes("=")) fail(`Option ${flag} does not take a value`);
			json = true;
			continue;
		}
		if (flag === "--workdir") {
			const parsed = parseFlagValue(rest, index, flag);
			workdir = parsed.value;
			index = parsed.next;
			continue;
		}
		const parsed = parseFlagValue(rest, index, flag);
		maxConcurrentWorkers = parseCapacity(parsed.value);
		index = parsed.next;
	}

	if (action === "list") {
		if (name !== undefined) fail("list does not accept a master name");
		if (workdir !== undefined || maxConcurrentWorkers !== undefined) fail("list only accepts --json");
		return { action, json };
	}
	if (name === undefined) fail(`${action} requires a master name`);
	try {
		assertCanonicalMasterName(name);
	} catch (error) {
		fail(errorMessage(error));
	}
	if (action === "configure" && workdir !== undefined) fail("configure does not accept --workdir");
	if (action !== "create" && json) fail(`${action} does not accept --json`);
	if (action === "configure" && maxConcurrentWorkers === undefined)
		fail("configure requires --max-concurrent-workers");
	return {
		action,
		name,
		...(workdir === undefined ? {} : { workdir }),
		...(maxConcurrentWorkers === undefined ? {} : { maxConcurrentWorkers }),
		...(json ? { json } : {}),
	};
}

export function printMasterHelp(write: (text: string) => void = text => process.stdout.write(text)): void {
	write(
		"Usage: gjc master <command> [options]\n\n" +
			"Commands:\n" +
			"  create <name> [--workdir <path>] [--max-concurrent-workers <n>]\n" +
			"  list [--json]\n" +
			"  configure <name> --max-concurrent-workers <n>\n",
	);
}

function rootOptions(deps: MasterCommandDeps): Omit<MasterDomainStoreOptions, "masterName"> {
	return {
		...(deps.masterRootDir === undefined ? {} : { masterRootDir: deps.masterRootDir }),
		...(deps.configRootDir === undefined ? {} : { configRootDir: deps.configRootDir }),
		...(deps.rootDir === undefined ? {} : { rootDir: deps.rootDir }),
		...(deps.now === undefined ? {} : { now: deps.now }),
	};
}

function storeOptions(
	command: MasterCommandArgs,
	deps: MasterCommandDeps,
	workdir?: string,
	security: { authorityFingerprint?: string; configuredProviders?: readonly MasterProvider[] } = {},
): MasterDomainStoreOptions {
	if (!command.name) throw new MasterCommandError("INVALID_MASTER_NAME", "Master name is required.");
	return {
		...rootOptions(deps),
		masterName: command.name,
		...(workdir === undefined ? {} : { defaultWorkdir: workdir }),
		maxConcurrentWorkers: command.maxConcurrentWorkers ?? DEFAULT_MAX_CONCURRENT_WORKERS,
		...(security.authorityFingerprint === undefined
			? {}
			: {
					authorityFingerprint: security.authorityFingerprint,
					expectedAuthorityFingerprint: security.authorityFingerprint,
				}),
		...(security.configuredProviders === undefined ? {} : { configuredProviders: security.configuredProviders }),
	};
}

function writer(deps: MasterCommandDeps, stream: "stdout" | "stderr"): (text: string) => void {
	if (stream === "stdout") return deps.writeStdout ?? (text => process.stdout.write(text));
	return deps.writeStderr ?? (text => process.stderr.write(text));
}

function writeLine(deps: MasterCommandDeps, text: string, stream: "stdout" | "stderr" = "stdout"): void {
	writer(deps, stream)(`${text}\n`);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function asCommandError(error: unknown): MasterCommandError {
	if (error instanceof MasterCommandError) return error;
	if (error instanceof MasterStoreError) return new MasterCommandError(error.code, error.message);
	return new MasterCommandError("MASTER_COMMAND_FAILED", errorMessage(error));
}

async function runAuthorizationCallback(command: MasterCommandArgs, deps: MasterCommandDeps): Promise<void> {
	if (deps.assertAuthority !== undefined) await deps.assertAuthority(command.action);
	if (deps.authorize !== undefined) {
		const requested = command.workdir ?? process.cwd();
		if (!(await deps.authorize(requested, command.action)))
			throw new MasterCommandError("AUTHORITY_DENIED", "Master authority denied this operation.");
	}
}

async function assertRealCanonicalWorkdir(target: string, deps: MasterCommandDeps): Promise<string> {
	const resolved = path.resolve(target);
	const fsImpl = deps.fs ?? fs;
	let stat: { isDirectory(): boolean; isSymbolicLink(): boolean };
	try {
		stat = await fsImpl.lstat(resolved);
	} catch (error) {
		throw new MasterCommandError(
			"INVALID_WORKDIR",
			`Master workdir does not exist: ${resolved} (${errorMessage(error)})`,
		);
	}
	if (!stat.isDirectory() || stat.isSymbolicLink())
		throw new MasterCommandError("INVALID_WORKDIR", "Master workdir must be a real directory, not a symlink.");
	const canonical = await fsImpl.realpath(resolved);
	if (canonical !== resolved)
		throw new MasterCommandError("INVALID_WORKDIR", "Master workdir must use its canonical realpath.");
	return canonical;
}

async function loadAuthority(deps: MasterCommandDeps): Promise<FrozenCoordinatorAuthority> {
	if (deps.authority !== undefined) return deps.authority;
	return await (deps.createAuthority ?? ((env: NodeJS.ProcessEnv) => freezeCoordinatorAuthority(env)))(
		deps.env ?? process.env,
	);
}

async function admitWorkdir(command: MasterCommandArgs, deps: MasterCommandDeps): Promise<string> {
	await runAuthorizationCallback(command, deps);
	const requested = command.workdir ?? process.cwd();
	if (deps.admitWorkdir !== undefined)
		return await assertRealCanonicalWorkdir(await deps.admitWorkdir(requested), deps);
	if (
		(deps.authorize !== undefined || deps.assertAuthority !== undefined) &&
		deps.authority === undefined &&
		deps.coordinatorGateway === undefined &&
		deps.createAuthority === undefined
	)
		return await assertRealCanonicalWorkdir(requested, deps);
	if (deps.coordinatorGateway !== undefined) return await deps.coordinatorGateway.assertAdmittedWorkdir(requested);
	const authority = await loadAuthority(deps);
	await assertCoordinatorAuthorityUnchanged(authority, deps.env ?? (authority.env as NodeJS.ProcessEnv));
	return await assertCanonicalCoordinatorWorkdir(authority, requested);
}

async function assertMutationAuthority(command: MasterCommandArgs, deps: MasterCommandDeps): Promise<void> {
	await runAuthorizationCallback(command, deps);
	if (deps.coordinatorGateway !== undefined) {
		await assertCoordinatorAuthorityUnchanged(
			deps.coordinatorGateway.authority,
			deps.env ?? (deps.coordinatorGateway.authority.env as NodeJS.ProcessEnv),
		);
		return;
	}
	if (
		(deps.authorize !== undefined || deps.assertAuthority !== undefined) &&
		deps.authority === undefined &&
		deps.coordinatorGateway === undefined &&
		deps.createAuthority === undefined
	)
		return;
	const authority = await loadAuthority(deps);
	await assertCoordinatorAuthorityUnchanged(authority, deps.env ?? (authority.env as NodeJS.ProcessEnv));
}

async function resolveStoreAuthorityFingerprint(deps: MasterCommandDeps): Promise<string | undefined> {
	if (deps.coordinatorGateway !== undefined) return deps.coordinatorGateway.authority.fingerprint;
	if (deps.authority !== undefined) return deps.authority.fingerprint;
	if (
		(deps.authorize !== undefined || deps.assertAuthority !== undefined || deps.admitWorkdir !== undefined) &&
		deps.createAuthority === undefined
	)
		return undefined;
	const authority = await loadAuthority(deps);
	await assertCoordinatorAuthorityUnchanged(authority, deps.env ?? (authority.env as NodeJS.ProcessEnv));
	return authority.fingerprint;
}

async function resolveConfiguredProviders(
	workdir: string,
	deps: MasterCommandDeps,
): Promise<readonly MasterProvider[]> {
	if (deps.configuredProviders !== undefined) return [...deps.configuredProviders];
	if (deps.createStore !== undefined) return [];
	const settings = await Settings.init({ cwd: workdir });
	const config = getNotificationConfig(settings);
	return (["telegram", "discord"] as const).filter(
		provider => isProviderEffectivelyEnabled(config, provider) && isProviderComplete(config, provider),
	);
}

async function createStore(options: MasterDomainStoreOptions, deps: MasterCommandDeps): Promise<MasterStoreLike> {
	return await (deps.createStore ?? (async value => MasterDomainStore.create(value)))(options);
}

async function openStore(options: MasterDomainStoreOptions, deps: MasterCommandDeps): Promise<MasterStoreLike> {
	return await (deps.openStore ?? (async value => MasterDomainStore.open(value)))(options);
}

async function daemonController(
	deps: MasterCommandDeps,
	expectedAuthorityFingerprint?: string,
): Promise<MasterDaemonControlLike> {
	return (
		deps.daemonController ??
		deps.daemon ??
		deps.controller ??
		new MasterDaemonController({
			...(deps.masterRootDir === undefined ? {} : { masterRootDir: deps.masterRootDir }),
			...(deps.configRootDir === undefined ? {} : { configRootDir: deps.configRootDir }),
			...(deps.rootDir === undefined ? {} : { rootDir: deps.rootDir }),
			...(expectedAuthorityFingerprint === undefined ? {} : { expectedAuthorityFingerprint }),
		})
	);
}

function renderList(items: readonly MasterListItem[]): string {
	if (items.length === 0) return "No masters registered.";
	const lines = ["master\tworkdir\tmax-concurrent-workers\tactive-workers\tcapacity-state\tupdated-at"];
	for (const item of items) {
		lines.push(
			[
				item.masterName,
				item.defaultWorkdir,
				String(item.maxConcurrentWorkers),
				String(item.activeWorkerCount),
				item.capacityState,
				item.updatedAt,
			].join("\t"),
		);
	}
	return lines.join("\n");
}

async function reloadAfterPersistence(
	deps: MasterCommandDeps,
	expectedAuthorityFingerprint?: string,
): Promise<MasterDaemonOperationResult> {
	const controller = await daemonController(deps, expectedAuthorityFingerprint);
	try {
		return await controller.reload();
	} catch (error) {
		return {
			ok: false,
			warnings: [errorMessage(error)],
			message: "Master daemon reload failed; the persisted master record remains stopped and recoverable.",
		};
	}
}

async function runCreate(command: MasterCommandArgs, deps: MasterCommandDeps): Promise<MasterCommandResult> {
	if (!command.name) throw new MasterCommandError("INVALID_MASTER_NAME", "create requires a master name");
	const workdir = await admitWorkdir(command, deps);
	const authorityFingerprint = await resolveStoreAuthorityFingerprint(deps);
	const configuredProviders = await resolveConfiguredProviders(workdir, deps);
	const store = await createStore(
		storeOptions(command, deps, workdir, { authorityFingerprint, configuredProviders }),
		deps,
	);
	const record = await store.readRecord();
	const daemon = await reloadAfterPersistence(deps, authorityFingerprint);
	writeLine(
		deps,
		`Created master ${record.masterName} (workdir=${record.defaultWorkdir}, max-concurrent-workers=${record.maxConcurrentWorkers}).`,
	);
	if (!daemon.ok) writeLine(deps, `${daemon.message} ${daemon.warnings.join(" ")}`.trim(), "stderr");
	return { action: "create", ok: daemon.ok, record, daemon, ...(daemon.ok ? {} : { error: daemon.message }) };
}

async function runList(command: MasterCommandArgs, deps: MasterCommandDeps): Promise<MasterCommandResult> {
	const masters =
		deps.listStores === undefined
			? await MasterDomainStore.list(rootOptions(deps))
			: await deps.listStores(rootOptions(deps));
	if (command.json) writeLine(deps, JSON.stringify(masters, null, 2));
	else writeLine(deps, renderList(masters));
	return { action: "list", ok: true, masters };
}

async function runConfigure(command: MasterCommandArgs, deps: MasterCommandDeps): Promise<MasterCommandResult> {
	if (!command.name) throw new MasterCommandError("INVALID_MASTER_NAME", "configure requires a master name");
	if (command.maxConcurrentWorkers === undefined)
		throw new MasterCommandError("INVALID_CAPACITY", "configure requires --max-concurrent-workers");
	await assertMutationAuthority(command, deps);
	const authorityFingerprint = await resolveStoreAuthorityFingerprint(deps);
	const store = await openStore(storeOptions(command, deps, undefined, { authorityFingerprint }), deps);
	const capacity = await store.configureMaxConcurrentWorkers(command.maxConcurrentWorkers);
	const record = await store.readRecord();
	const daemon = await reloadAfterPersistence(deps, authorityFingerprint);
	writeLine(
		deps,
		`Configured master ${record.masterName}: max-concurrent-workers=${capacity.maxConcurrentWorkers} (previous=${capacity.previousMaxConcurrentWorkers}).`,
	);
	if (!daemon.ok) writeLine(deps, `${daemon.message} ${daemon.warnings.join(" ")}`.trim(), "stderr");
	return {
		action: "configure",
		ok: daemon.ok,
		record,
		capacity,
		daemon,
		...(daemon.ok ? {} : { error: daemon.message }),
	};
}

export async function runMasterCommand(
	command: MasterCommandArgs,
	deps: MasterCommandDeps = {},
): Promise<MasterCommandResult> {
	try {
		if (command.action === "create") return await runCreate(command, deps);
		if (command.action === "list") return await runList(command, deps);
		return await runConfigure(command, deps);
	} catch (error) {
		const failure = asCommandError(error);
		writeLine(deps, failure.message, "stderr");
		throw failure;
	}
}

export function assertMasterCommandName(name: unknown): asserts name is string {
	if (!isCanonicalMasterName(name)) assertCanonicalMasterName(name);
}
