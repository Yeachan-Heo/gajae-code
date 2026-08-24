import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { YAML } from "bun";
import {
	COORDINATOR_MCP_PROTOCOL_VERSION,
	COORDINATOR_MCP_SERVER_NAME,
	COORDINATOR_MCP_TOOL_NAMES,
} from "../coordinator/contract";
import { createCoordinatorMcpServer } from "../coordinator-mcp/server";
import operatorInstructionsTemplate from "./hermes/templates/operator-instructions.v1.md" with { type: "text" };

export type HermesMutationClass = "sessions" | "questions" | "reports";
export type HermesSetupMode = "render" | "install" | "check" | "smoke";

export interface HermesSetupFlags {
	json?: boolean;
	check?: boolean;
	smoke?: boolean;
	install?: boolean;
	force?: boolean;
	root?: string[];
	repo?: string;
	profile?: string;
	sessionCommand?: string;
	noWorktree?: boolean;
	worktreeName?: string;
	requireWorktree?: boolean;
	stateRoot?: string;
	codingAgentDir?: string;
	mutation?: string[];
	artifactByteCap?: string;
	serverKey?: string;
	gjcCommand?: string;
	target?: string;
	profileDir?: string;
}

export interface CoordinatorSetupSpec {
	schemaVersion: 1;
	coordinator: "hermes";
	serverKey: string;
	serverName: typeof COORDINATOR_MCP_SERVER_NAME;
	protocolVersion: typeof COORDINATOR_MCP_PROTOCOL_VERSION;
	gjcCommand: string;
	args: string[];
	roots: string[];
	namespace: {
		profile?: string;
		repo?: string;
	};
	sessionCommand?: string;
	sessionCommandSource: "default" | "explicit";
	worktree: {
		enabled: boolean;
		name?: string;
		/** Refuse a session creation that did not name its own worktree. */
		required: boolean;
	};
	stateRoot?: string;
	/** Agent-directory override (GJC_CODING_AGENT_DIR). Distinct from the coordinator state root. */
	codingAgentDir?: string;
	mutationPolicy: {
		classes: HermesMutationClass[];
		perCallConsentRequired: true;
	};
	artifactByteCap?: number;
	installTarget?: {
		kind: "profile-dir" | "config-file";
		path: string;
	};
	operatorTemplateVersion: 1;
	contractDocVersion: 1;
}

export interface HermesSetupResult {
	ok: boolean;
	mode: HermesSetupMode;
	files_written: string[];
	previews: Array<{ path: string; content: string }>;
	warnings: string[];
	smoke: null | {
		ok: boolean;
		protocolVersion: string;
		serverName: string;
		requiredTools: string[];
		missingTools: string[];
	};
	check: null | {
		ok: boolean;
		mismatches: Array<{ path: string; kind: "missing" | "invalid" | "signature" | "operator_digest" }>;
	};
}

class HermesSetupError extends Error {
	readonly exitCode: number;
	constructor(message: string, exitCode: number) {
		super(message);
		this.name = "HermesSetupError";
		this.exitCode = exitCode;
	}
}

const MUTATION_CLASSES: HermesMutationClass[] = ["sessions", "questions", "reports"];
const MANAGED_BY = "gjc";
const SETUP_SCHEMA_VERSION = "1";
const DEFAULT_SERVER_KEY = "gjc_coordinator";
const DEFAULT_GJC_COMMAND = "gjc";
const DEFAULT_TIMEOUT = 180;
const DEFAULT_CONNECT_TIMEOUT = 60;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalTrim(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function normalizeRoots(roots: string[] | undefined): string[] {
	if (!roots || roots.length === 0) {
		throw new HermesSetupError("Hermes setup requires at least one --root <path>.", 2);
	}
	const seen = new Set<string>();
	const normalized: string[] = [];
	const home = path.resolve(os.homedir());
	for (const root of roots) {
		const trimmed = root.trim();
		if (!trimmed) {
			throw new HermesSetupError("Hermes setup root entries must not be empty.", 2);
		}
		const resolved = path.resolve(trimmed);
		if (resolved === path.parse(resolved).root || resolved === path.resolve("/home") || resolved === home) {
			throw new HermesSetupError(`Refusing broad Hermes MCP root: ${resolved}`, 2);
		}
		if (!seen.has(resolved)) {
			seen.add(resolved);
			normalized.push(resolved);
		}
	}
	return normalized;
}
/**
 * Validate --coding-agent-dir with the same guard normalizeRoots applies to
 * --root: absolute (path.isAbsolute covers POSIX and Windows drive/UNC), never
 * the filesystem root, /home, or the account home.
 */
function normalizeCodingAgentDir(value: string | undefined): string | undefined {
	const trimmed = optionalTrim(value);
	if (!trimmed) return undefined;
	if (!path.isAbsolute(trimmed)) {
		throw new HermesSetupError(`--coding-agent-dir must be an absolute path; got: ${trimmed}`, 2);
	}
	const resolved = path.resolve(trimmed);
	if (
		resolved === path.parse(resolved).root ||
		resolved === path.resolve("/home") ||
		resolved === path.resolve(os.homedir())
	) {
		throw new HermesSetupError(`Refusing broad Hermes coding agent dir: ${resolved}`, 2);
	}
	return resolved;
}

function parseMutationClasses(values: string[] | undefined): HermesMutationClass[] {
	if (!values || values.length === 0) return [];
	const classes: HermesMutationClass[] = [];
	for (const raw of values) {
		for (const part of raw.split(",")) {
			const value = part.trim();
			if (!value) continue;
			if (value === "all") {
				for (const cls of MUTATION_CLASSES) {
					if (!classes.includes(cls)) classes.push(cls);
				}
				continue;
			}
			if (!MUTATION_CLASSES.includes(value as HermesMutationClass)) {
				throw new HermesSetupError(`Invalid Hermes mutation class: ${value}`, 2);
			}
			if (!classes.includes(value as HermesMutationClass)) classes.push(value as HermesMutationClass);
		}
	}
	return classes;
}

function parseByteCap(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new HermesSetupError("--artifact-byte-cap must be a positive integer.", 2);
	}
	return parsed;
}

function normalizeWorktreeName(value: string | undefined): string | undefined {
	const trimmed = optionalTrim(value);
	if (!trimmed) return undefined;
	if (trimmed.startsWith("-") || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(trimmed)) {
		throw new HermesSetupError(`Invalid Hermes worktree name: ${trimmed}`, 2);
	}
	return trimmed;
}

function resolveHermesWorktree(flags: HermesSetupFlags): CoordinatorSetupSpec["worktree"] {
	if (flags.noWorktree && flags.worktreeName) {
		throw new HermesSetupError("Use either --no-worktree or --worktree-name, not both.", 2);
	}
	// Requiring a per-session worktree from a coordinator configured to run in
	// place would refuse every session it ever creates.
	if (flags.requireWorktree && flags.noWorktree) {
		throw new HermesSetupError("--require-worktree cannot be combined with --no-worktree.", 2);
	}
	const name = normalizeWorktreeName(flags.worktreeName);
	const required = flags.requireWorktree === true;
	return flags.noWorktree
		? { enabled: false, required: false }
		: { enabled: true, required, ...(name ? { name } : {}) };
}

function validateHermesSessionCommand(command: string): void {
	const [executable, ...args] = command.trim().split(/\s+/);
	if (executable !== DEFAULT_GJC_COMMAND) {
		throw new HermesSetupError(
			"GJC_COORDINATOR_MCP_SESSION_COMMAND must be exactly gjc with an optional --worktree [name] selector.",
			2,
		);
	}
	if (
		args.length > 0 &&
		(args[0] !== "--worktree" ||
			args.length > 2 ||
			(args[1] !== undefined && (args[1].length === 0 || args[1].startsWith("-"))))
	) {
		throw new HermesSetupError(
			"GJC_COORDINATOR_MCP_SESSION_COMMAND supports only gjc or gjc --worktree [name] under SDK lifecycle control.",
			2,
		);
	}
}

function resolveHermesSessionCommand(flags: HermesSetupFlags): string {
	const explicit = optionalTrim(flags.sessionCommand);
	if (flags.sessionCommand !== undefined) {
		if (!explicit) {
			throw new HermesSetupError(
				"GJC_COORDINATOR_MCP_SESSION_COMMAND must be exactly gjc with an optional --worktree [name] selector.",
				2,
			);
		}
		if (flags.noWorktree || flags.worktreeName || flags.requireWorktree) {
			throw new HermesSetupError(
				"Use either --session-command or Hermes worktree flags; explicit session commands are preserved exactly.",
				2,
			);
		}
		validateHermesSessionCommand(explicit);
		return explicit;
	}
	const worktree = resolveHermesWorktree(flags);
	if (!worktree.enabled) return DEFAULT_GJC_COMMAND;
	return worktree.name ? `${DEFAULT_GJC_COMMAND} --worktree ${worktree.name}` : `${DEFAULT_GJC_COMMAND} --worktree`;
}
/**
 * Quote-aware argv tokenizer for `--gjc-command`. Mirrors the SDK
 * lifecycle-command tokenizer: single/double quotes group one token and
 * backslash escapes `\\`, quotes, and whitespace. Returns undefined for an
 * unbalanced quote. The value is never evaluated by a shell.
 */
function parseHermesCommandTokens(value: string): string[] | undefined {
	const tokens: string[] = [];
	let token = "";
	let quote: '"' | "'" | undefined;
	let started = false;
	for (let index = 0; index < value.length; index++) {
		const character = value[index]!;
		if (character === "\\") {
			const next = value[index + 1];
			if (next !== undefined && (next === "\\" || next === '"' || next === "'" || /\s/u.test(next))) {
				token += next;
				index++;
			} else token += character;
			started = true;
			continue;
		}
		if (quote) {
			if (character === quote) quote = undefined;
			else token += character;
			started = true;
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			started = true;
			continue;
		}
		if (/\s/u.test(character)) {
			if (started) {
				tokens.push(token);
				token = "";
				started = false;
			}
			continue;
		}
		token += character;
		started = true;
	}
	if (quote) return undefined;
	if (started) tokens.push(token);
	return tokens;
}

/**
 * `--gjc-command` accepts the full command the controller execs (#4877):
 * - omitted → the default `gjc` + GJC-owned `mcp-serve coordinator` args;
 * - a single token → executable-only substitute for `gjc` (`/opt/gjc`), still
 *   followed by GJC-owned `mcp-serve coordinator` args (byte-identical to the
 *   historical render);
 * - multiple tokens → the full server command, split quote-aware into
 *   controller argv and rendered verbatim with nothing appended, so a wrapper
 *   that already starts the coordinator never receives doubled argv.
 * The value is tokenized, never evaluated by a shell.
 */
function resolveHermesLaunchCommand(flags: HermesSetupFlags): { command: string; args: string[] } {
	const explicit = optionalTrim(flags.gjcCommand);
	if (!explicit) return { command: DEFAULT_GJC_COMMAND, args: ["mcp-serve", "coordinator"] };
	const tokens = parseHermesCommandTokens(explicit);
	if (!tokens) {
		throw new HermesSetupError("--gjc-command has an unbalanced quote; it is tokenized, never shell-evaluated.", 2);
	}
	if (tokens[0] === "") {
		throw new HermesSetupError("--gjc-command must name a non-empty executable.", 2);
	}
	if (tokens.length === 1) return { command: tokens[0]!, args: ["mcp-serve", "coordinator"] };
	return { command: tokens[0]!, args: tokens.slice(1) };
}

function normalizeInstallTarget(flags: HermesSetupFlags): CoordinatorSetupSpec["installTarget"] {
	if (flags.target && flags.profileDir) {
		throw new HermesSetupError("Use exactly one of --target or --profile-dir for Hermes setup install targets.", 2);
	}
	if (!flags.target && !flags.profileDir) return undefined;
	return flags.profileDir
		? { kind: "profile-dir", path: path.resolve(flags.profileDir) }
		: { kind: "config-file", path: path.resolve(flags.target!) };
}

export function buildHermesSetupSpec(flags: HermesSetupFlags): CoordinatorSetupSpec {
	const roots = normalizeRoots(flags.root);
	const launch = resolveHermesLaunchCommand(flags);
	const sessionCommand = resolveHermesSessionCommand(flags);
	return {
		schemaVersion: 1,
		coordinator: "hermes",
		serverKey: optionalTrim(flags.serverKey) ?? DEFAULT_SERVER_KEY,
		serverName: COORDINATOR_MCP_SERVER_NAME,
		protocolVersion: COORDINATOR_MCP_PROTOCOL_VERSION,
		gjcCommand: launch.command,
		args: launch.args,
		roots,
		namespace: {
			...(optionalTrim(flags.profile) ? { profile: optionalTrim(flags.profile) } : {}),
			...(optionalTrim(flags.repo) ? { repo: optionalTrim(flags.repo) } : {}),
		},
		worktree: resolveHermesWorktree(flags),
		sessionCommandSource: flags.sessionCommand !== undefined ? "explicit" : "default",
		sessionCommand,
		...(optionalTrim(flags.stateRoot) ? { stateRoot: path.resolve(flags.stateRoot!) } : {}),
		// Preserved/overridden at install time from the managed block, so the
		// spec field only reflects an explicit --coding-agent-dir.
		...(normalizeCodingAgentDir(flags.codingAgentDir)
			? { codingAgentDir: normalizeCodingAgentDir(flags.codingAgentDir) }
			: {}),
		mutationPolicy: {
			classes: parseMutationClasses(flags.mutation),
			perCallConsentRequired: true,
		},
		...(parseByteCap(flags.artifactByteCap) ? { artifactByteCap: parseByteCap(flags.artifactByteCap) } : {}),
		...(normalizeInstallTarget(flags) ? { installTarget: normalizeInstallTarget(flags) } : {}),
		operatorTemplateVersion: 1,
		contractDocVersion: 1,
	};
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(item => canonicalize(item));
	if (!isRecord(value)) return value;
	const output: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) {
		const item = value[key];
		if (item !== undefined) output[key] = canonicalize(item);
	}
	return output;
}

function digest(value: unknown): string {
	return crypto
		.createHash("sha256")
		.update(JSON.stringify(canonicalize(value)))
		.digest("hex");
}

function serverBlockDigest(block: Record<string, unknown>): string {
	const env = isRecord(block.env) ? { ...block.env } : {};
	delete env.GJC_COORDINATOR_MCP_SETUP_SIGNATURE;
	return digest({ ...block, env });
}

export function computeHermesSetupSignature(spec: CoordinatorSetupSpec): string {
	return serverBlockDigest(renderHermesServerBlockWithoutSignature(spec));
}

function renderHermesServerBlockWithoutSignature(spec: CoordinatorSetupSpec): Record<string, unknown> {
	const env: Record<string, string> = {
		GJC_COORDINATOR_MCP_WORKDIR_ROOTS: spec.roots.join(path.delimiter),
		GJC_COORDINATOR_MCP_SETUP_MANAGED_BY: MANAGED_BY,
		GJC_COORDINATOR_MCP_SETUP_SCHEMA_VERSION: SETUP_SCHEMA_VERSION,
	};
	if (spec.namespace.profile) env.GJC_COORDINATOR_MCP_PROFILE = spec.namespace.profile;
	if (spec.namespace.repo) env.GJC_COORDINATOR_MCP_REPO = spec.namespace.repo;
	if (spec.stateRoot) env.GJC_COORDINATOR_MCP_STATE_ROOT = spec.stateRoot;
	if (spec.codingAgentDir) env.GJC_CODING_AGENT_DIR = spec.codingAgentDir;
	if (spec.mutationPolicy.classes.length > 0)
		env.GJC_COORDINATOR_MCP_MUTATIONS = spec.mutationPolicy.classes.join(",");
	if (spec.artifactByteCap !== undefined) env.GJC_COORDINATOR_MCP_ARTIFACT_BYTE_CAP = String(spec.artifactByteCap);
	if (spec.sessionCommand) env.GJC_COORDINATOR_MCP_SESSION_COMMAND = spec.sessionCommand;
	if (spec.worktree.required) env.GJC_COORDINATOR_MCP_REQUIRE_WORKTREE = "true";
	return {
		command: spec.gjcCommand,
		args: spec.args,
		env,
		timeout: DEFAULT_TIMEOUT,
		connect_timeout: DEFAULT_CONNECT_TIMEOUT,
		enabled: true,
	};
}

export function renderHermesServerBlock(spec: CoordinatorSetupSpec): Record<string, unknown> {
	const block = renderHermesServerBlockWithoutSignature(spec);
	const env = block.env as Record<string, string>;
	env.GJC_COORDINATOR_MCP_SETUP_SIGNATURE = serverBlockDigest(block);
	return block;
}

function renderConfigYaml(spec: CoordinatorSetupSpec): string {
	return YAML.stringify({ mcp_servers: { [spec.serverKey]: renderHermesServerBlock(spec) } }, null, 2);
}

const OPERATOR_DIGEST_MARKER = /<!-- GJC Hermes operator instructions digest v(\d+): ([a-f0-9]{64}) -->/;
const OPERATOR_DIGEST_MARKER_SLOT =
	/<!-- GJC Hermes operator instructions digest v\d+: (?:[a-f0-9]{64}|\{\{OPERATOR_INSTRUCTIONS_DIGEST\}\}|) -->/;

function operatorInstructionsDigest(content: string): string {
	return crypto.createHash("sha256").update(content.replace(OPERATOR_DIGEST_MARKER_SLOT, "")).digest("hex");
}

function renderOperatorTemplate(spec: CoordinatorSetupSpec): string {
	const rendered = operatorInstructionsTemplate
		.replaceAll("{{SERVER_KEY}}", spec.serverKey)
		.replaceAll("{{TOOL_PREFIX}}", "gjc_coordinator")
		.replaceAll("{{TEMPLATE_VERSION}}", String(spec.operatorTemplateVersion));
	return rendered.replaceAll("{{OPERATOR_INSTRUCTIONS_DIGEST}}", operatorInstructionsDigest(rendered));
}

function serverBlockIsManaged(block: unknown): boolean {
	if (!isRecord(block) || !isRecord(block.env)) return false;
	const env = block.env;
	return (
		env.GJC_COORDINATOR_MCP_SETUP_MANAGED_BY === MANAGED_BY &&
		env.GJC_COORDINATOR_MCP_SETUP_SCHEMA_VERSION === SETUP_SCHEMA_VERSION &&
		typeof env.GJC_COORDINATOR_MCP_SETUP_SIGNATURE === "string" &&
		env.GJC_COORDINATOR_MCP_SETUP_SIGNATURE === serverBlockDigest(block)
	);
}

function operatorInstructionsAreManaged(content: string, spec: CoordinatorSetupSpec): boolean {
	const marker = content.match(OPERATOR_DIGEST_MARKER);
	return (
		marker?.[1] === String(spec.operatorTemplateVersion) &&
		marker[2] === operatorInstructionsDigest(content) &&
		content === renderOperatorTemplate(spec)
	);
}

async function readYamlConfig(configPath: string): Promise<Record<string, unknown>> {
	const exists = await Bun.file(configPath).exists();
	if (!exists) return {};
	const content = await Bun.file(configPath).text();
	if (!content.trim()) return {};
	const parsed = YAML.parse(content);
	if (!isRecord(parsed)) {
		throw new HermesSetupError(`Hermes config must be a YAML object: ${configPath}`, 2);
	}
	return parsed;
}

async function backupFile(filePath: string): Promise<string | null> {
	if (!(await Bun.file(filePath).exists())) return null;
	const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
	const backupPath = `${filePath}.bak.${stamp}`;
	await Bun.write(backupPath, Bun.file(filePath));
	return backupPath;
}

function mergeHermesConfig(
	existing: Record<string, unknown>,
	spec: CoordinatorSetupSpec,
	force: boolean,
): Record<string, unknown> {
	const currentServers = isRecord(existing.mcp_servers) ? existing.mcp_servers : {};
	const existingBlock = currentServers[spec.serverKey];
	if (existingBlock !== undefined && !serverBlockIsManaged(existingBlock) && !force) {
		throw new HermesSetupError(`Hermes MCP server '${spec.serverKey}' already exists and is not managed by GJC.`, 3);
	}
	// An operator-set GJC_CODING_AGENT_DIR in a managed block survives re-install
	// unless --coding-agent-dir explicitly overrides it (issue #4879). The value
	// stays out of the spec so the rendered signature remains flags-derived.
	// Preserve is scoped to GJC-managed blocks: a value we signed ourselves. An
	// unmanaged block (--force) or a tampered one re-renders from flags alone.
	const preservedCodingAgentDir =
		spec.codingAgentDir || !serverBlockIsManaged(existingBlock)
			? undefined
			: readManagedCodingAgentDir(existingBlock);
	return {
		...existing,
		mcp_servers: {
			...currentServers,
			[spec.serverKey]: renderHermesServerBlock(
				preservedCodingAgentDir ? { ...spec, codingAgentDir: preservedCodingAgentDir } : spec,
			),
		},
	};
}

/**
 * Read the GJC_CODING_AGENT_DIR a managed block carries. Callers gate on
 * serverBlockIsManaged first, so only values GJC itself signed can be
 * preserved; unmanaged or tampered blocks re-render from flags alone.
 */
function readManagedCodingAgentDir(existingBlock: unknown): string | undefined {
	if (!isRecord(existingBlock) || !isRecord(existingBlock.env)) return undefined;
	const value = existingBlock.env.GJC_CODING_AGENT_DIR;
	if (typeof value !== "string" || !value.trim()) return undefined;
	return value;
}

function configPathForTarget(spec: CoordinatorSetupSpec): string | null {
	if (!spec.installTarget) return null;
	if (spec.installTarget.kind === "config-file") return spec.installTarget.path;
	return path.join(spec.installTarget.path, "config.yaml");
}

function operatorPathForTarget(spec: CoordinatorSetupSpec): string | null {
	if (spec.installTarget?.kind !== "profile-dir") return null;
	return path.join(spec.installTarget.path, "skills", "autonomous-ai-agents", "gajae-code", "SKILL.md");
}

type StagedFile = { path: string; stagedPath: string };

async function stageFile(filePath: string, content: string, staged: StagedFile[]): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const stagedPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
	staged.push({ path: filePath, stagedPath });
	await fs.writeFile(stagedPath, content, { mode: 0o600 });
}

type FileSnapshot = { path: string; content: Buffer | null };

async function snapshotFile(filePath: string): Promise<FileSnapshot> {
	try {
		return { path: filePath, content: await fs.readFile(filePath) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: filePath, content: null };
		throw error;
	}
}

async function restoreFile(snapshot: FileSnapshot): Promise<void> {
	if (snapshot.content === null) {
		await fs.rm(snapshot.path, { force: true });
		return;
	}
	await fs.writeFile(snapshot.path, snapshot.content);
}

async function installConfig(spec: CoordinatorSetupSpec, force: boolean): Promise<string[]> {
	const configPath = configPathForTarget(spec);
	if (!configPath) return [];
	const existing = await readYamlConfig(configPath);
	const configContent = YAML.stringify(mergeHermesConfig(existing, spec, force), null, 2);
	const operatorPath = operatorPathForTarget(spec);
	const operatorContent = operatorPath ? renderOperatorTemplate(spec) : null;

	// Complete all conflict checks before any backup, directory creation, or output write.
	if (operatorPath && (await Bun.file(operatorPath).exists()) && !force) {
		const current = await Bun.file(operatorPath).text();
		if (!operatorInstructionsAreManaged(current, spec)) {
			throw new HermesSetupError(
				`Operator instruction target already exists and is not managed by GJC: ${operatorPath}`,
				3,
			);
		}
	}

	const staged: StagedFile[] = [];
	const snapshots: FileSnapshot[] = [];
	const committed: FileSnapshot[] = [];
	try {
		await stageFile(configPath, configContent, staged);
		if (operatorPath && operatorContent) await stageFile(operatorPath, operatorContent, staged);
		for (const file of staged) snapshots.push(await snapshotFile(file.path));
		if (force) {
			for (const file of staged) await backupFile(file.path);
		}
		for (const [index, file] of staged.entries()) {
			await fs.rename(file.stagedPath, file.path);
			committed.push(snapshots[index]);
		}
	} catch (error) {
		for (const snapshot of committed.reverse()) await restoreFile(snapshot);
		throw error;
	} finally {
		for (const file of staged) await fs.rm(file.stagedPath, { force: true });
	}
	return staged.map(file => file.path);
}

async function checkInstalledHermesSetup(spec: CoordinatorSetupSpec): Promise<NonNullable<HermesSetupResult["check"]>> {
	const configPath = configPathForTarget(spec);
	if (!configPath) {
		throw new HermesSetupError("Hermes setup --check requires --target or --profile-dir.", 2);
	}
	const mismatches: NonNullable<HermesSetupResult["check"]>["mismatches"] = [];
	if (!(await Bun.file(configPath).exists())) {
		mismatches.push({ path: configPath, kind: "missing" });
	} else {
		try {
			const config = await readYamlConfig(configPath);
			const servers = isRecord(config.mcp_servers) ? config.mcp_servers : {};
			const block = servers[spec.serverKey];
			if (block === undefined) mismatches.push({ path: configPath, kind: "missing" });
			else if (!isRecord(block) || !serverBlockIsManaged(block))
				mismatches.push({ path: configPath, kind: "invalid" });
			else if (
				(block.env as Record<string, unknown>).GJC_COORDINATOR_MCP_SETUP_SIGNATURE !==
				computeHermesSetupSignature(spec)
			) {
				mismatches.push({ path: configPath, kind: "signature" });
			}
		} catch {
			mismatches.push({ path: configPath, kind: "invalid" });
		}
	}
	const operatorPath = operatorPathForTarget(spec);
	if (operatorPath) {
		if (!(await Bun.file(operatorPath).exists())) mismatches.push({ path: operatorPath, kind: "missing" });
		else if (!operatorInstructionsAreManaged(await Bun.file(operatorPath).text(), spec)) {
			mismatches.push({ path: operatorPath, kind: "operator_digest" });
		}
	}
	return { ok: mismatches.length === 0, mismatches };
}

async function runSmoke(spec: CoordinatorSetupSpec): Promise<HermesSetupResult["smoke"]> {
	const requiredTools = [...COORDINATOR_MCP_TOOL_NAMES];
	const server = createCoordinatorMcpServer({ env: renderHermesServerBlock(spec).env as NodeJS.ProcessEnv });
	const listed = await server.handleJsonRpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
	const listedResult = isRecord(listed.result) ? listed.result : {};
	const tools = Array.isArray(listedResult.tools) ? listedResult.tools : [];
	const advertised = new Set(tools.map(tool => (isRecord(tool) ? String(tool.name) : "")));
	const missingTools = requiredTools.filter(tool => !advertised.has(tool));
	return {
		ok: missingTools.length === 0,
		protocolVersion: spec.protocolVersion,
		serverName: spec.serverName,
		requiredTools,
		missingTools,
	};
}

export async function runHermesSetup(flags: HermesSetupFlags): Promise<HermesSetupResult> {
	const selectedModes = [flags.install, flags.check, flags.smoke].filter(Boolean).length;
	if (selectedModes > 1) {
		throw new HermesSetupError("Hermes setup accepts only one of --install, --check, or --smoke.", 2);
	}
	const spec = buildHermesSetupSpec(flags);
	if (flags.install && !spec.installTarget) {
		throw new HermesSetupError("Hermes setup --install requires --target or --profile-dir.", 2);
	}
	if (!flags.install && spec.installTarget && !flags.check && !flags.smoke) {
		throw new HermesSetupError(
			"Hermes setup target/profile-dir writes require --install; omit the target for render-only output.",
			2,
		);
	}
	const mode: HermesSetupMode = flags.smoke ? "smoke" : flags.check ? "check" : flags.install ? "install" : "render";
	const configPath = configPathForTarget(spec) ?? "hermes-config.yaml";
	const previews = [
		{ path: configPath, content: renderConfigYaml(spec) },
		{ path: operatorPathForTarget(spec) ?? "operator-instructions.v1.md", content: renderOperatorTemplate(spec) },
	];
	const files_written = flags.install ? await installConfig(spec, Boolean(flags.force)) : [];
	const check = flags.check ? await checkInstalledHermesSetup(spec) : null;
	const smoke = flags.smoke ? await runSmoke(spec) : null;
	if (smoke && !smoke.ok) {
		throw new HermesSetupError(`Hermes MCP smoke failed; missing tools: ${smoke.missingTools.join(", ")}`, 4);
	}
	return {
		ok: check?.ok ?? true,
		mode,
		files_written,
		previews,
		warnings:
			spec.sessionCommandSource === "explicit"
				? ["Using explicit GJC_COORDINATOR_MCP_SESSION_COMMAND validated as a supported GJC lifecycle selector."]
				: spec.worktree.enabled
					? [
							`GJC_COORDINATOR_MCP_SESSION_COMMAND defaults to '${spec.sessionCommand}' so GJC owns worktree creation and resume identity.`,
						]
					: [
							"GJC_COORDINATOR_MCP_SESSION_COMMAND defaults to 'gjc' with worktree isolation disabled by user request.",
						],
		smoke,
		check,
	};
}

export function formatHermesSetupResult(result: HermesSetupResult): string {
	const lines = [`Hermes setup ${result.mode} complete.`];
	if (result.files_written.length > 0) {
		lines.push("Written:");
		for (const file of result.files_written) lines.push(`- ${file}`);
	}
	if (result.files_written.length === 0) {
		lines.push("No files written. Use --install with --target or --profile-dir to apply.");
		for (const preview of result.previews) lines.push(`Preview: ${preview.path}`);
	}
	for (const warning of result.warnings) lines.push(`Warning: ${warning}`);
	if (result.check) {
		lines.push(`Check: ${result.check.ok ? "passed" : "failed"}`);
		for (const mismatch of result.check.mismatches) lines.push(`Mismatch: ${mismatch.kind} (${mismatch.path})`);
	}
	if (result.smoke) {
		lines.push(`Smoke: ${result.smoke.ok ? "passed" : "failed"} (${result.smoke.requiredTools.length} tools)`);
	}
	return lines.join("\n");
}

export function hermesSetupExitCode(error: unknown): number {
	return error instanceof HermesSetupError ? error.exitCode : 1;
}
