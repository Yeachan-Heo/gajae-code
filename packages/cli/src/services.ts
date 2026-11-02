import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { homeLayout } from "@gajae-gateway/home";
import { parseRuntimeConfig, type RuntimeConfig, RuntimeConfigError } from "@gajae-gateway/protocol";

const CONFIG_SCHEMA_VERSION = 1;

export const FALLBACK_PATH_DIRS = ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"] as const;
const LOGIN_PATH_COMMAND = 'printf %s "$PATH"';

export type LoginPathRunner = (command: readonly string[]) => string | PromiseLike<string>;
export type PlistWriter = (path: string, contents: string) => void | PromiseLike<void>;

export interface ResolvePathOptions {
	readonly binDir: string;
	/** The operator home used for managed PATH entries and `~/` expansion. */
	readonly home: string;
	readonly runtime?: RuntimeConfig;
	readonly env?: NodeJS.ProcessEnv;
	/** A supplied PATH bypasses shell discovery and is useful for pure tests. */
	readonly loginPath?: string;
	/** Test seam for the `${SHELL} -lc` invocation used by the default path. */
	readonly loginPathRunner?: LoginPathRunner;
}

/** Service managers this CLI can write definitions for. */
export type ServicePlatform = "darwin" | "linux";
export interface ServiceCommandOptions {
	readonly allowFailure?: boolean;
}
export type ServiceCommandRunner = (
	command: readonly string[],
	options?: ServiceCommandOptions,
) => number | PromiseLike<number>;

export interface InstallServicesOptions {
	readonly binDir: string;
	readonly launchAgentsDir?: string;
	/** systemd user-unit directory; defaults to ${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user. */
	readonly unitDir?: string;
	/** Service manager to generate for; defaults to the running platform. */
	readonly platform?: ServicePlatform;
	readonly env?: NodeJS.ProcessEnv;
	/** Render adapter units only when their adapter-<platform>.json exists. */
	readonly configuredAdaptersOnly?: boolean;
	/** Leave unchanged unit files untouched. */
	readonly compareAndWrite?: boolean;
	/** Test seam for the `${SHELL} -lc` invocation used by the default path. */
	readonly loginPathRunner?: LoginPathRunner;
	/** Test seam for counting or inspecting the definition writes. */
	readonly writeFile?: PlistWriter;
}

interface ServiceSpec {
	readonly id: string;
	readonly label: string;
	readonly binary: string;
	readonly args: readonly string[];
	/**
	 * True for every process that holds a live connection to the gateway. A
	 * gateway restart leaves such a process attached to the previous generation:
	 * it neither dies nor loses messages, so no health check catches it, and the
	 * symptom is replies arriving one beat late (issue #251). The service
	 * definition, not an operator convention, has to restart it.
	 */
	readonly dependsOnGateway: boolean;
}

export const BROKER_UNIT = "gajaeway-broker.service";
export const GATEWAY_UNIT = "gajaeway-gateway.service";

const SERVICE_SPECS: readonly ServiceSpec[] = [
	{
		id: "broker",
		label: "dev.gajaeway.broker",
		binary: "gajaeway-gateway",
		args: ["broker"],
		dependsOnGateway: false,
	},
	{
		id: "gateway",
		label: "dev.gajaeway.gateway",
		binary: "gajaeway-gateway",
		args: ["daemon"],
		dependsOnGateway: false,
	},
	{
		id: "adapter-discord",
		label: "dev.gajaeway.adapter-discord",
		binary: "gajaeway-discord",
		args: [],
		dependsOnGateway: true,
	},
	{
		id: "adapter-slack",
		label: "dev.gajaeway.adapter-slack",
		binary: "gajaeway-slack",
		args: [],
		dependsOnGateway: true,
	},
	{
		id: "adapter-telegram",
		label: "dev.gajaeway.adapter-telegram",
		binary: "gajaeway-telegram",
		args: [],
		dependsOnGateway: true,
	},
	{ id: "admin", label: "dev.gajaeway.admin", binary: "gajaeway-admin", args: ["serve"], dependsOnGateway: true },
];

export function serviceSpecs(): readonly ServiceSpec[] {
	return SERVICE_SPECS;
}

/**
 * The `adapter-<platform>.json` an adapter reads at startup, or undefined for services
 * that are not adapters. A unit whose file is absent can never come up — the adapter
 * exits on the credential read — so supervisors skip it instead of looping on it.
 */
export function adapterConfigPath(home: string, specId: string): string | undefined {
	if (!specId.startsWith("adapter-")) return undefined;
	return join(home, `adapter-${specId.slice("adapter-".length)}.json`);
}

function homeForEnvironment(env: NodeJS.ProcessEnv): string {
	return env.GAJAEWAY_HOME || join(env.HOME || homedir(), ".gajaeway");
}

function expandHome(value: string, home: string): string {
	return value.startsWith("~/") ? join(home, value.slice(2)) : value;
}

function normalizedEntries(entries: readonly string[], home: string): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const raw of entries) {
		if (raw.length === 0) continue;
		const entry = expandHome(raw, home);
		if (seen.has(entry)) continue;
		seen.add(entry);
		result.push(entry);
	}
	return result;
}

export function mergePathEntries(binDir: string, userHome: string, loginPath: string): string[] {
	return normalizedEntries(
		[
			expandHome(binDir, userHome),
			join(userHome, "bin"),
			join(userHome, ".local", "bin"),
			join(userHome, ".bun", "bin"),
			...loginPath.replace(/(?:\r\n|\n)+$/, "").split(":"),
			...FALLBACK_PATH_DIRS,
		],
		userHome,
	);
}

export async function defaultLoginPathRunner(command: readonly string[]): Promise<string> {
	let child: ReturnType<typeof Bun.spawn>;
	try {
		child = Bun.spawn([...command], { stdout: "pipe", stderr: "pipe" });
	} catch (error) {
		throw new Error(`could not run login shell: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!(child.stdout instanceof ReadableStream)) throw new Error("login shell stdout was not piped");
	const stdout = await new Response(child.stdout).text();
	const exitCode = await child.exited;
	if (exitCode !== 0) throw new Error(`login shell exited with status ${exitCode}`);
	return stdout;
}

/**
 * Discover the login shell's PATH by executing it with `-lc`. Fall back through
 * SHELL, passwd shell, /bin/bash, and /bin/sh in order. If all fail to execute,
 * return an empty string so mergePathEntries uses FALLBACK_PATH_DIRS; do not throw.
 * Maintains #39 login-PATH inheritance.
 */
export async function discoverLoginPath(
	env: NodeJS.ProcessEnv = process.env,
	runner: LoginPathRunner = defaultLoginPathRunner,
): Promise<string> {
	const shellCandidates: string[] = [];

	// SHELL env var if set.
	if (env.SHELL) shellCandidates.push(env.SHELL);

	// passwd shell from os.userInfo().
	try {
		const info = userInfo();
		if (info.shell) shellCandidates.push(info.shell);
	} catch {}

	// Standard fallback shells.
	shellCandidates.push("/bin/bash", "/bin/sh");

	for (const shell of shellCandidates) {
		try {
			return await runner([shell, "-lc", LOGIN_PATH_COMMAND]);
		} catch {}
	}

	// All candidates failed. Return empty string so mergePathEntries
	// uses FALLBACK_PATH_DIRS instead of throwing.
	return "";
}

export async function resolvePath(options: ResolvePathOptions): Promise<string> {
	const runtime = options.runtime;
	const env = options.env;
	const shellEnv = env ?? process.env;
	const userHome = options.home;
	let loginPath = "";
	if (runtime?.path !== undefined) loginPath = runtime.path.join(":");
	else if (runtime?.inheritLoginPath !== false)
		loginPath =
			options.loginPath ?? (await discoverLoginPath(shellEnv, options.loginPathRunner ?? defaultLoginPathRunner));
	return mergePathEntries(options.binDir, userHome, loginPath).join(":");
}

export function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

function plistString(value: string): string {
	return `<string>${escapeXml(value)}</string>`;
}

export function renderLaunchAgent(spec: ServiceSpec, binDir: string, home: string, path: string): string {
	const program = join(binDir, spec.binary);
	const argumentsXml = [program, ...spec.args].map(plistString).join("");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key>${plistString(spec.label)}
  <key>ProgramArguments</key><array>${argumentsXml}</array>
  <key>WorkingDirectory</key>${plistString(binDir)}
  <key>EnvironmentVariables</key><dict>
    <key>GAJAEWAY_HOME</key>${plistString(home)}
    <key>PATH</key>${plistString(path)}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key>${plistString(join(home, `${spec.id}.stdout.log`))}
  <key>StandardErrorPath</key>${plistString(join(home, `${spec.id}.stderr.log`))}
</dict></plist>
`;
}

/**
 * systemd reads `Environment=` with its own quoting rules, so a value is wrapped
 * in double quotes with backslashes and quotes escaped. PATH entries containing
 * a space would otherwise silently split into two assignments.
 */
function unitEnvironment(name: string, value: string): string {
	return `Environment="${name}=${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function systemdUnitName(spec: ServiceSpec): string {
	return `gajaeway-${spec.id}.service`;
}

/**
 * `EnvironmentFile=` and `ConditionPathExists=` take one literal absolute path:
 * systemd does not unquote them, so a quoted value is "not absolute" and the
 * directive is silently ignored. Only `%` specifiers need escaping.
 */
function unitPath(path: string): string {
	if (!path.startsWith("/") || /[\n\r\0]/.test(path))
		throw new Error(`unit path must be absolute and single-line: ${path}`);
	return path.replaceAll("%", "%%");
}

function unitEnvironmentFile(path: string): string {
	return `EnvironmentFile=-${unitPath(path)}`;
}

export function renderSystemdUnit(spec: ServiceSpec, binDir: string, home: string, path: string): string {
	const execStart = [join(binDir, spec.binary), ...spec.args].join(" ");
	const unit = [
		"[Unit]",
		`Description=gajaeway ${spec.id}`,
		...(spec.id === "broker"
			? [`ConditionPathExists=${unitPath(homeLayout(home).brokerProvisionManifest)}`]
			: spec.id === "gateway"
				? [`Wants=${BROKER_UNIT}`, `After=${BROKER_UNIT}`]
				: spec.dependsOnGateway
					? [`BindsTo=${GATEWAY_UNIT}`, `After=${GATEWAY_UNIT}`, `PartOf=${GATEWAY_UNIT}`]
					: []),
		"",
		"[Service]",
		`ExecStart=${execStart}`,
		`WorkingDirectory=${binDir}`,
		unitEnvironment("GAJAEWAY_HOME", home),
		unitEnvironment("PATH", path),
		...(spec.id === "broker" ? [unitEnvironmentFile(join(home, "broker.env"))] : []),
		"Restart=always",
		spec.id === "broker" ? "RestartSec=2s" : "RestartSec=2",
		...(spec.id === "broker"
			? // The host propagates `gjc sdk broker run`'s exit code: 143 is its clean SIGTERM stop.
				["KillMode=control-group", "TimeoutStartSec=60s", "TimeoutStopSec=30s", "SuccessExitStatus=143"]
			: spec.id === "gateway"
				? ["KillMode=mixed", "TimeoutStartSec=60s", "TimeoutStopSec=40s"]
				: ["TimeoutStartSec=60s", "TimeoutStopSec=60s"]),
		"",
		"[Install]",
		`WantedBy=${spec.dependsOnGateway ? GATEWAY_UNIT : "default.target"}`,
		"",
	];
	return unit.join("\n");
}

export function systemdUnitDir(env: NodeJS.ProcessEnv, userHome: string): string {
	const base = env.XDG_CONFIG_HOME || join(userHome, ".config");
	return join(base, "systemd", "user");
}

/** Gets the path where a service's LaunchAgent plist is stored on darwin. */
export function launchAgentPlistPath(spec: ServiceSpec, launchAgentsDir: string): string {
	return join(launchAgentsDir, `dev.gajaeway.${spec.id}.plist`);
}

/** Gets the path where a service's systemd unit file is stored on linux. */
export function systemdUnitPath(spec: ServiceSpec, unitDir: string): string {
	return join(unitDir, systemdUnitName(spec));
}

export interface RemoveStaleServicesOptions extends Pick<InstallServicesOptions, "launchAgentsDir" | "unitDir"> {
	readonly binDir: string;
	readonly platform: ServicePlatform;
	readonly uid?: number;
	readonly env?: NodeJS.ProcessEnv;
	readonly reloadSystemd?: boolean;
	readonly run: ServiceCommandRunner;
}

/** Stops and removes service definitions whose executable is no longer installed. */
export async function removeStaleServices(options: RemoveStaleServicesOptions): Promise<void> {
	const env = options.env ?? process.env;
	const userHome = env.HOME || homedir();
	const definitionDir =
		options.platform === "darwin"
			? (options.launchAgentsDir ?? join(userHome, "Library", "LaunchAgents"))
			: (options.unitDir ?? systemdUnitDir(env, userHome));
	const expandedDefinitionDir = expandHome(definitionDir, userHome);
	const staleDefinitions: Array<{ readonly label: string; readonly path: string; readonly unitName: string }> = [];
	for (const spec of SERVICE_SPECS) {
		if (await Bun.file(join(options.binDir, spec.binary)).exists()) continue;
		const path =
			options.platform === "darwin"
				? launchAgentPlistPath(spec, expandedDefinitionDir)
				: systemdUnitPath(spec, expandedDefinitionDir);
		if (await Bun.file(path).exists())
			staleDefinitions.push({ label: spec.label, path, unitName: systemdUnitName(spec) });
	}
	const execute = async (command: readonly string[], allowFailure = false): Promise<number> => {
		const exitCode = await options.run(command, allowFailure ? { allowFailure: true } : undefined);
		if (exitCode !== 0 && !allowFailure) throw new Error(`${command.join(" ")} exited with status ${exitCode}`);
		return exitCode;
	};
	if (options.platform === "linux") {
		if (staleDefinitions.length === 0) return;
		await execute(["systemctl", "--user", "disable", "--now", ...staleDefinitions.map(({ unitName }) => unitName)]);
		for (const { path } of staleDefinitions) await rm(path, { force: true });
		if (options.reloadSystemd ?? true) await execute(["systemctl", "--user", "daemon-reload"]);
		return;
	}
	const target = `gui/${options.uid ?? process.getuid?.() ?? 0}`;
	for (const { label, path } of staleDefinitions) {
		const serviceTarget = `${target}/${label}`;
		if ((await execute(["launchctl", "print", serviceTarget], true)) === 0)
			await execute(["launchctl", "bootout", serviceTarget]);
		await rm(path, { force: true });
	}
}

/**
 * The ordered commands that realign the whole stack.
 *
 * systemd restarts the broker before the gateway; gateway dependencies restart
 * their adapters. launchd has no dependency propagation, so the adapters are
 * restarted while the old gateway still holds the admission drain, then the
 * gateway is restarted last.
 */
export function restartStackCommands(platform: ServicePlatform, uid?: number): readonly (readonly string[])[] {
	if (platform === "linux")
		return [
			["systemctl", "--user", "restart", BROKER_UNIT],
			["systemctl", "--user", "restart", GATEWAY_UNIT],
		];
	if (platform === "darwin") {
		const target = uid ?? process.getuid?.() ?? 0;
		return restartOrder(platform).map((spec) => ["launchctl", "kickstart", "-k", `gui/${target}/${spec.label}`]);
	}
	throw new Error(`unsupported service platform: ${platform}`);
}

/** Platform-specific order; launchd keeps the draining gateway alive until dependents restart. */
export function restartOrder(platform: ServicePlatform): readonly ServiceSpec[] {
	const core = SERVICE_SPECS.filter((spec) => !spec.dependsOnGateway && spec.id !== "gateway");
	const gateway = SERVICE_SPECS.filter((spec) => spec.id === "gateway");
	const dependents = SERVICE_SPECS.filter((spec) => spec.dependsOnGateway);
	return platform === "darwin" ? [...core, ...dependents, ...gateway] : [...core, ...gateway, ...dependents];
}

function requirePlatform(platform: string): ServicePlatform {
	if (platform !== "darwin" && platform !== "linux") throw new Error(`unsupported service platform: ${platform}`);
	return platform;
}

export function currentPlatform(): ServicePlatform {
	if (process.platform === "darwin" || process.platform === "linux") return process.platform;
	throw new Error(`unsupported service platform: ${process.platform}`);
}

async function readRuntime(home: string): Promise<RuntimeConfig | undefined> {
	const configPath = join(home, "config.json");
	let raw: string;
	try {
		raw = await readFile(configPath, "utf8");
	} catch (error) {
		throw new Error(`could not read ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`could not parse ${configPath}: malformed JSON`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		throw new Error(`invalid configuration ${configPath}: config must be an object`);
	const input = parsed as Record<string, unknown>;
	if (input.schemaVersion !== CONFIG_SCHEMA_VERSION)
		throw new Error(`invalid configuration ${configPath}: schemaVersion must be ${CONFIG_SCHEMA_VERSION}`);
	try {
		return parseRuntimeConfig(input.runtime);
	} catch (error) {
		const message = error instanceof RuntimeConfigError ? error.message : String(error);
		throw new Error(`invalid runtime configuration ${configPath}: ${message}`);
	}
}

export async function installServices(options: InstallServicesOptions): Promise<readonly string[]> {
	if (options.binDir.length === 0) throw new Error("services requires a non-empty --bin-dir DIR");
	const env = options.env ?? process.env;
	const platform = options.platform === undefined ? currentPlatform() : requirePlatform(options.platform);
	const userHome = env.HOME || homedir();
	const home = homeForEnvironment(env);
	const binDir = expandHome(options.binDir, userHome);
	const targetDir =
		platform === "darwin"
			? expandHome(options.launchAgentsDir ?? join(userHome, "Library", "LaunchAgents"), userHome)
			: expandHome(options.unitDir ?? systemdUnitDir(env, userHome), userHome);
	const runtime = await readRuntime(home);
	const path = await resolvePath({
		binDir,
		home: userHome,
		runtime,
		env,
		loginPathRunner: options.loginPathRunner,
	});
	await mkdir(targetDir, { recursive: true, mode: 0o700 });
	const specs: ServiceSpec[] = [];
	for (const spec of SERVICE_SPECS) {
		if (!(await Bun.file(join(binDir, spec.binary)).exists())) continue;
		const adapterConfig = adapterConfigPath(home, spec.id);
		if (options.configuredAdaptersOnly && adapterConfig !== undefined && !(await Bun.file(adapterConfig).exists()))
			continue;
		specs.push(spec);
	}
	const definitions = specs.map((spec) =>
		platform === "darwin"
			? {
					path: join(targetDir, `dev.gajaeway.${spec.id}.plist`),
					contents: renderLaunchAgent(spec, binDir, home, path),
				}
			: { path: join(targetDir, systemdUnitName(spec)), contents: renderSystemdUnit(spec, binDir, home, path) },
	);
	const write = options.writeFile;
	for (const definition of definitions) {
		if (options.compareAndWrite) {
			try {
				if ((await readFile(definition.path, "utf8")) === definition.contents) continue;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		if (write) await write(definition.path, definition.contents);
		else {
			await writeFile(definition.path, definition.contents, { encoding: "utf8", mode: 0o600 });
			await chmod(definition.path, 0o600);
		}
	}
	return definitions.map((definition) => definition.path);
}

export function serviceUsage(): string {
	return "usage: gajaeway services install|repair --bin-dir DIR [--launch-agents-dir DIR] [--unit-dir DIR] [--platform darwin|linux]";
}
