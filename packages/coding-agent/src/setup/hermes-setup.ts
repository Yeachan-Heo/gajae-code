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
	stateRoot?: string;
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
	args: ["mcp-serve", "coordinator"];
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
	};
	stateRoot?: string;
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
	const name = normalizeWorktreeName(flags.worktreeName);
	return flags.noWorktree ? { enabled: false } : { enabled: true, ...(name ? { name } : {}) };
}

function resolveHermesSessionCommand(gjcCommand: string, flags: HermesSetupFlags): string {
	const explicit = optionalTrim(flags.sessionCommand);
	if (explicit) {
		if (flags.noWorktree || flags.worktreeName) {
			throw new HermesSetupError(
				"Use either --session-command or Hermes worktree flags; explicit session commands are preserved exactly.",
				2,
			);
		}
		return explicit;
	}
	const worktree = resolveHermesWorktree(flags);
	if (!worktree.enabled) return gjcCommand;
	return worktree.name ? `${gjcCommand} --worktree ${worktree.name}` : `${gjcCommand} --worktree`;
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
	const gjcCommand = optionalTrim(flags.gjcCommand) ?? DEFAULT_GJC_COMMAND;
	const sessionCommand = resolveHermesSessionCommand(gjcCommand, flags);
	return {
		schemaVersion: 1,
		coordinator: "hermes",
		serverKey: optionalTrim(flags.serverKey) ?? DEFAULT_SERVER_KEY,
		serverName: COORDINATOR_MCP_SERVER_NAME,
		protocolVersion: COORDINATOR_MCP_PROTOCOL_VERSION,
		gjcCommand,
		args: ["mcp-serve", "coordinator"],
		roots,
		namespace: {
			...(optionalTrim(flags.profile) ? { profile: optionalTrim(flags.profile) } : {}),
			...(optionalTrim(flags.repo) ? { repo: optionalTrim(flags.repo) } : {}),
		},
		worktree: resolveHermesWorktree(flags),
		sessionCommandSource: optionalTrim(flags.sessionCommand) ? "explicit" : "default",
		sessionCommand,
		...(optionalTrim(flags.stateRoot) ? { stateRoot: path.resolve(flags.stateRoot!) } : {}),
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

function signaturePayload(spec: CoordinatorSetupSpec): Record<string, unknown> {
	return {
		args: spec.args,
		artifactByteCap: spec.artifactByteCap,
		command: spec.gjcCommand,
		contractDocVersion: spec.contractDocVersion,
		coordinator: spec.coordinator,
		mutationClasses: spec.mutationPolicy.classes,
		worktree: spec.worktree,
		sessionCommandSource: spec.sessionCommandSource,
		namespace: spec.namespace,
		operatorTemplateVersion: spec.operatorTemplateVersion,
		roots: spec.roots,
		schemaVersion: spec.schemaVersion,
		serverKey: spec.serverKey,
		sessionCommand: spec.sessionCommand,
		stateRoot: spec.stateRoot,
	};
}

export function computeHermesSetupSignature(spec: CoordinatorSetupSpec): string {
	const canonical = JSON.stringify(canonicalize(signaturePayload(spec)));
	return crypto.createHash("sha256").update(canonical).digest("hex");
}

export function renderHermesServerBlock(spec: CoordinatorSetupSpec): Record<string, unknown> {
	const env: Record<string, string> = {
		GJC_COORDINATOR_MCP_WORKDIR_ROOTS: spec.roots.join(path.delimiter),
		GJC_COORDINATOR_MCP_SETUP_MANAGED_BY: MANAGED_BY,
		GJC_COORDINATOR_MCP_SETUP_SCHEMA_VERSION: SETUP_SCHEMA_VERSION,
		GJC_COORDINATOR_MCP_SETUP_SIGNATURE: computeHermesSetupSignature(spec),
	};
	if (spec.namespace.profile) env.GJC_COORDINATOR_MCP_PROFILE = spec.namespace.profile;
	if (spec.namespace.repo) env.GJC_COORDINATOR_MCP_REPO = spec.namespace.repo;
	if (spec.stateRoot) env.GJC_COORDINATOR_MCP_STATE_ROOT = spec.stateRoot;
	if (spec.mutationPolicy.classes.length > 0)
		env.GJC_COORDINATOR_MCP_MUTATIONS = spec.mutationPolicy.classes.join(",");
	if (spec.artifactByteCap !== undefined) env.GJC_COORDINATOR_MCP_ARTIFACT_BYTE_CAP = String(spec.artifactByteCap);
	if (spec.sessionCommand) env.GJC_COORDINATOR_MCP_SESSION_COMMAND = spec.sessionCommand;
	return {
		command: spec.gjcCommand,
		args: spec.args,
		env,
		timeout: DEFAULT_TIMEOUT,
		connect_timeout: DEFAULT_CONNECT_TIMEOUT,
		enabled: true,
	};
}

function renderConfigYaml(spec: CoordinatorSetupSpec): string {
	return YAML.stringify({ mcp_servers: { [spec.serverKey]: renderHermesServerBlock(spec) } }, null, 2);
}

function renderOperatorTemplate(spec: CoordinatorSetupSpec): string {
	return operatorInstructionsTemplate
		.replaceAll("{{SERVER_KEY}}", spec.serverKey)
		.replaceAll("{{TOOL_PREFIX}}", "gjc_coordinator")
		.replaceAll("{{TEMPLATE_VERSION}}", String(spec.operatorTemplateVersion));
}

function serverBlockIsManaged(block: unknown): boolean {
	if (!isRecord(block)) return false;
	const env = block.env;
	return (
		isRecord(env) &&
		env.GJC_COORDINATOR_MCP_SETUP_MANAGED_BY === MANAGED_BY &&
		env.GJC_COORDINATOR_MCP_SETUP_SCHEMA_VERSION === SETUP_SCHEMA_VERSION &&
		typeof env.GJC_COORDINATOR_MCP_SETUP_SIGNATURE === "string"
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
	return {
		...existing,
		mcp_servers: {
			...currentServers,
			[spec.serverKey]: renderHermesServerBlock(spec),
		},
	};
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

async function installConfig(spec: CoordinatorSetupSpec, force: boolean): Promise<string[]> {
	const configPath = configPathForTarget(spec);
	if (!configPath) return [];
	const existing = await readYamlConfig(configPath);
	const merged = mergeHermesConfig(existing, spec, force);
	if (force) await backupFile(configPath);
	await fs.mkdir(path.dirname(configPath), { recursive: true });
	await Bun.write(configPath, YAML.stringify(merged, null, 2));
	const written = [configPath];
	const operatorPath = operatorPathForTarget(spec);
	if (operatorPath) {
		if ((await Bun.file(operatorPath).exists()) && !force) {
			const current = await Bun.file(operatorPath).text();
			if (
				!current.includes("GJC Hermes operator instructions") ||
				!current.includes(`Server key: ${spec.serverKey}`)
			) {
				throw new HermesSetupError(
					`Operator instruction target already exists and is not managed by GJC: ${operatorPath}`,
					3,
				);
			}
		}
		if (force) await backupFile(operatorPath);
		await fs.mkdir(path.dirname(operatorPath), { recursive: true });
		await Bun.write(operatorPath, renderOperatorTemplate(spec));
		written.push(operatorPath);
	}
	return written;
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
	const smoke = flags.smoke ? await runSmoke(spec) : null;
	if (smoke && !smoke.ok) {
		throw new HermesSetupError(`Hermes MCP smoke failed; missing tools: ${smoke.missingTools.join(", ")}`, 4);
	}
	return {
		ok: true,
		mode,
		files_written,
		previews,
		warnings:
			spec.sessionCommandSource === "explicit"
				? [
						"Using explicit GJC_COORDINATOR_MCP_SESSION_COMMAND exactly as supplied; provider/model/worktree validation is not performed.",
					]
				: spec.worktree.enabled
					? [
							`GJC_COORDINATOR_MCP_SESSION_COMMAND defaults to '${spec.sessionCommand}' so GJC owns worktree creation and resume identity.`,
						]
					: [
							"GJC_COORDINATOR_MCP_SESSION_COMMAND defaults to the configured gjc command with worktree isolation disabled by user request.",
						],
		smoke,
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
	if (result.smoke) {
		lines.push(`Smoke: ${result.smoke.ok ? "passed" : "failed"} (${result.smoke.requiredTools.length} tools)`);
	}
	return lines.join("\n");
}

export function hermesSetupExitCode(error: unknown): number {
	return error instanceof HermesSetupError ? error.exitCode : 1;
}
