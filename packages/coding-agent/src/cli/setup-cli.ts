/**
 * Setup CLI command handler.
 *
 * Handles `gjc setup [component]` to install the normal defaults or optional feature dependencies.
 */

import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { AuthStorage, SqliteAuthCredentialStore } from "@gajae-code/ai";
import { $which, APP_NAME, getAgentDbPath, getPythonEnvDir } from "@gajae-code/utils";
import { $ } from "bun";
import chalk from "chalk";
import { installDefaultGjcDefinitions } from "../defaults/gjc-defaults";
import {
	getDefaultCodexHooksPath,
	mergeGjcManagedCodexHooksConfig,
	readGjcManagedCodexHooksStatus,
} from "../hooks/codex-native-hooks-config";
import { theme } from "../modes/theme/theme";
import { formatCredentialAutoImportResult, runExternalCredentialAutoImport } from "../setup/credential-auto-import";
import { filterAutoImportOAuthCredentials, formatDiscoverySummary } from "../setup/credential-import";
import {
	formatHermesSetupResult,
	type HermesSetupFlags,
	hermesSetupExitCode,
	runHermesSetup,
} from "../setup/hermes-setup";
import { buildHostPluginSetup, formatHostPluginSetup, type HostPluginKind } from "../setup/host-plugin-setup";
import {
	addApiCompatibleProvider,
	formatProviderPresetList,
	formatProviderSetupResult,
	parseProviderCompatibility,
} from "../setup/provider-onboarding";

export type SetupComponent =
	| "claude"
	| "codex"
	| "credentials"
	| "defaults"
	| "hermes"
	| "hooks"
	| "provider"
	| "python"
	| "stt";

export interface SetupCommandArgs {
	component: SetupComponent;
	flags: {
		json?: boolean;
		check?: boolean;
		force?: boolean;
		preset?: string;
		compat?: string;
		provider?: string;
		baseUrl?: string;
		apiKeyEnv?: string;
		model?: string[];
		modelsPath?: string;
		smoke?: boolean;
		install?: boolean;
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
		yes?: boolean;
		dryRun?: boolean;
		keychain?: boolean;
	};
}

const VALID_COMPONENTS: SetupComponent[] = [
	"claude",
	"codex",
	"credentials",
	"defaults",
	"hermes",
	"hooks",
	"provider",
	"python",
	"stt",
];

function hasProviderSetupFlags(flags: SetupCommandArgs["flags"]): boolean {
	return (
		flags.compat !== undefined ||
		flags.preset !== undefined ||
		flags.provider !== undefined ||
		flags.baseUrl !== undefined ||
		flags.apiKeyEnv !== undefined ||
		flags.model !== undefined ||
		flags.modelsPath !== undefined
	);
}

function rejectProviderFlagsOutsideProvider(component: SetupComponent, flags: SetupCommandArgs["flags"]): void {
	if (component === "provider" || !hasProviderSetupFlags(flags)) {
		return;
	}
	console.error(chalk.red("Provider setup flags require the explicit `provider` component."));
	console.error(
		chalk.dim(
			`Run: ${APP_NAME} setup provider --preset <minimax|glm> or ${APP_NAME} setup provider --compat <openai|anthropic> --provider <id> --base-url <url> --api-key-env <ENV> --model <id>`,
		),
	);
	process.exit(1);
}

const MANAGED_PYTHON_ENV = getPythonEnvDir();

/**
 * Parse setup subcommand arguments.
 * Returns undefined if not a setup command.
 */
export function parseSetupArgs(args: string[]): SetupCommandArgs | undefined {
	if (args.length === 0 || args[0] !== "setup") {
		return undefined;
	}

	let component: SetupComponent = "defaults";
	let componentSeen = false;
	const flags: SetupCommandArgs["flags"] = {};
	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--json") {
			flags.json = true;
		} else if (arg === "--check" || arg === "-c") {
			flags.check = true;
		} else if (arg === "--force" || arg === "-f") {
			flags.force = true;
		} else if (arg === "--smoke") {
			flags.smoke = true;
		} else if (arg === "--install") {
			flags.install = true;
		} else if (arg === "--yes" || arg === "-y") {
			flags.yes = true;
		} else if (arg === "--dry-run") {
			flags.dryRun = true;
		} else if (arg === "--keychain") {
			flags.keychain = true;
		} else if (arg === "--root") {
			flags.root = [...(flags.root ?? []), args[++i] ?? ""];
		} else if (arg === "--repo") {
			flags.repo = args[++i];
		} else if (arg === "--profile") {
			flags.profile = args[++i];
		} else if (arg === "--session-command") {
			flags.sessionCommand = args[++i];
		} else if (arg === "--no-worktree") {
			flags.noWorktree = true;
		} else if (arg === "--worktree-name") {
			flags.worktreeName = args[++i];
		} else if (arg === "--state-root") {
			flags.stateRoot = args[++i];
		} else if (arg === "--mutation") {
			flags.mutation = [...(flags.mutation ?? []), args[++i] ?? ""];
		} else if (arg === "--artifact-byte-cap") {
			flags.artifactByteCap = args[++i];
		} else if (arg === "--server-key") {
			flags.serverKey = args[++i];
		} else if (arg === "--gjc-command") {
			flags.gjcCommand = args[++i];
		} else if (arg === "--target") {
			flags.target = args[++i];
		} else if (arg === "--profile-dir") {
			flags.profileDir = args[++i];
		} else if (arg === "--compat") {
			flags.compat = args[++i];
		} else if (arg === "--preset") {
			flags.preset = args[++i];
		} else if (arg === "--provider") {
			flags.provider = args[++i];
		} else if (arg === "--base-url") {
			flags.baseUrl = args[++i];
		} else if (arg === "--api-key") {
			console.error(chalk.red("Provider setup rejects raw --api-key values; use --api-key-env <ENV> instead."));
			process.exit(1);
		} else if (arg === "--api-key-env") {
			flags.apiKeyEnv = args[++i];
		} else if (arg === "--model" || arg === "--models") {
			flags.model = [...(flags.model ?? []), args[++i] ?? ""];
		} else if (arg === "--models-path") {
			flags.modelsPath = args[++i];
		} else if (!componentSeen && VALID_COMPONENTS.includes(arg as SetupComponent)) {
			component = arg as SetupComponent;
			componentSeen = true;
		} else {
			console.error(chalk.red(`Unknown setup argument: ${arg}`));
			console.error(`Valid components: ${VALID_COMPONENTS.join(", ")}`);
			process.exit(1);
		}
	}

	rejectProviderFlagsOutsideProvider(component, flags);

	return {
		component,
		flags,
	};
}

interface PythonCheckResult {
	available: boolean;
	pythonPath?: string;
	usingManagedEnv?: boolean;
	managedEnvPath?: string;
}

function managedPythonPath(): string {
	return process.platform === "win32"
		? path.join(MANAGED_PYTHON_ENV, "Scripts", "python.exe")
		: path.join(MANAGED_PYTHON_ENV, "bin", "python");
}

/**
 * Check Python environment and kernel dependencies.
 */
async function checkPythonSetup(): Promise<PythonCheckResult> {
	const result: PythonCheckResult = {
		available: false,
		managedEnvPath: MANAGED_PYTHON_ENV,
	};

	const systemPythonPath = $which("python") ?? $which("python3");
	const managedPath = managedPythonPath();
	const hasManagedEnv = await Bun.file(managedPath).exists();

	const pythonPath = systemPythonPath ?? (hasManagedEnv ? managedPath : undefined);
	if (!pythonPath) {
		return result;
	}
	const probe = await $`${pythonPath} -c "import sys;sys.exit(0)"`.quiet().nothrow();
	result.pythonPath = pythonPath;
	result.available = probe.exitCode === 0;
	result.usingManagedEnv = pythonPath === managedPath;
	return result;
}

/**
 * Install Python packages using uv (preferred) or pip.
 */
// Python installation helper removed: the subprocess runner has no Python
// package dependencies beyond a working interpreter. `gjc setup python --check`
// remains as a probe; users install optional libs (pandas, matplotlib, ...)
// directly via pip or the in-process `%pip` magic.

/**
 * Run the setup command.
 */
export async function runSetupCommand(cmd: SetupCommandArgs): Promise<void> {
	rejectProviderFlagsOutsideProvider(cmd.component, cmd.flags);
	switch (cmd.component) {
		case "claude":
			handleHostPluginSetup("claude", cmd.flags);
			break;
		case "codex":
			handleHostPluginSetup("codex", cmd.flags);
			break;
		case "defaults":
			await handleDefaultsSetup(cmd.flags);
			break;
		case "hermes":
			await handleHermesSetup(cmd.flags);
			break;
		case "hooks":
			await handleHooksSetup(cmd.flags);
			break;
		case "provider":
			await handleProviderSetup(cmd.flags);
			break;
		case "python":
			await handlePythonSetup(cmd.flags);
			break;
		case "stt":
			await handleSttSetup(cmd.flags);
			break;
		case "credentials":
			await handleCredentialsSetup(cmd.flags);
			break;
	}
}

async function handleHermesSetup(flags: HermesSetupFlags): Promise<void> {
	try {
		const result = await runHermesSetup(flags);
		if (flags.json) {
			process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
			return;
		}
		process.stdout.write(`${chalk.green(`${theme.status.success} Hermes MCP setup ready`)}\n`);
		process.stdout.write(`${chalk.dim(formatHermesSetupResult(result))}\n`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (flags.json) {
			process.stdout.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
		} else {
			process.stderr.write(`${chalk.red(`${theme.status.error} Hermes MCP setup failed`)}\n`);
			process.stderr.write(`${chalk.dim(message)}\n`);
		}
		process.exit(hermesSetupExitCode(error));
	}
}

function handleHostPluginSetup(host: HostPluginKind, flags: SetupCommandArgs["flags"]): void {
	const result = buildHostPluginSetup(host, {
		json: flags.json,
		check: flags.check,
		root: flags.root,
		repo: flags.repo,
	});
	if (flags.json) {
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		return;
	}
	const label = host === "claude" ? "Claude Code" : "Codex";
	process.stdout.write(`${chalk.green(`${theme.status.success} ${label} plugin setup ready`)}\n`);
	process.stdout.write(`${chalk.dim(formatHostPluginSetup(result))}\n`);
}
async function handleProviderSetup(flags: {
	json?: boolean;
	force?: boolean;
	preset?: string;
	compat?: string;
	provider?: string;
	baseUrl?: string;
	apiKeyEnv?: string;
	model?: string[];
	modelsPath?: string;
}): Promise<void> {
	try {
		const missing: string[] = [];
		if (!flags.preset) {
			if (!flags.compat) missing.push("--compat");
			if (!flags.provider) missing.push("--provider");
			if (!flags.baseUrl) missing.push("--base-url");
			if (!flags.apiKeyEnv) missing.push("--api-key-env");
			if (!flags.model || flags.model.length === 0) missing.push("--model");
		}
		if (missing.length > 0) {
			throw new Error(
				`Missing required provider setup option(s): ${missing.join(", ")}. Or use --preset <preset>.\nAvailable presets:\n${formatProviderPresetList()}`,
			);
		}
		const result = await addApiCompatibleProvider({
			compatibility: flags.compat ? parseProviderCompatibility(flags.compat) : undefined,
			preset: flags.preset,
			providerId: flags.provider,
			baseUrl: flags.baseUrl,
			apiKeyEnv: flags.apiKeyEnv,
			models: flags.model,
			modelsPath: flags.modelsPath,
			force: flags.force,
		});
		if (flags.json) {
			process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
			return;
		}
		process.stdout.write(`${chalk.green(`${theme.status.success} Provider configured`)}\n`);
		process.stdout.write(`${chalk.dim(formatProviderSetupResult(result))}\n`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (flags.json) {
			process.stdout.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
		} else {
			process.stderr.write(`${chalk.red(`${theme.status.error} Provider setup failed`)}\n`);
			process.stderr.write(`${chalk.dim(message)}\n`);
		}
		process.exit(1);
	}
}

async function handleHooksSetup(flags: { json?: boolean; check?: boolean }): Promise<void> {
	const hooksPath = getDefaultCodexHooksPath();
	const existingContent = await Bun.file(hooksPath)
		.text()
		.catch(() => null);
	const status = readGjcManagedCodexHooksStatus(existingContent, hooksPath);

	if (flags.check) {
		if (flags.json) {
			process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
			if (!status.installed) process.exit(1);
			return;
		}
		if (!status.installed) {
			process.stderr.write(`${chalk.red(`${theme.status.error} GJC native Codex hooks are not fully installed`)}\n`);
			process.stderr.write(`${chalk.dim(`Target: ${hooksPath}`)}\n`);
			process.stderr.write(`${chalk.dim(`Missing events: ${status.missingEvents.join(", ")}`)}\n`);
			process.exit(1);
		}
		process.stdout.write(`${chalk.green(`${theme.status.success} GJC native Codex hooks are installed`)}\n`);
		process.stdout.write(`${chalk.dim(`Target: ${hooksPath}`)}\n`);
		return;
	}

	const merged = mergeGjcManagedCodexHooksConfig(existingContent);
	await Bun.write(hooksPath, merged.content);
	const installed = readGjcManagedCodexHooksStatus(merged.content, hooksPath);

	if (flags.json) {
		process.stdout.write(`${JSON.stringify({ ...installed, changed: merged.changed }, null, 2)}\n`);
		return;
	}

	process.stdout.write(`${chalk.green(`${theme.status.success} GJC native Codex hooks installed`)}\n`);
	process.stdout.write(`${chalk.dim(`Target: ${hooksPath}`)}\n`);
	process.stdout.write(
		`${chalk.dim(`Managed events: UserPromptSubmit, Stop; changed: ${merged.changed ? "yes" : "no"}`)}\n`,
	);
}
async function handleDefaultsSetup(flags: { json?: boolean; check?: boolean; force?: boolean }): Promise<void> {
	const result = await installDefaultGjcDefinitions({ check: flags.check, force: flags.force });
	const hasCheckFailure = result.missing > 0 || result.different > 0;
	const inspectGuidance = `Inspect bundled skills with: ${APP_NAME} skills list; read one with: ${APP_NAME} skills read ralplan`;

	if (flags.json) {
		console.log(JSON.stringify(result, null, 2));
		if (flags.check && hasCheckFailure) process.exit(1);
		return;
	}

	if (flags.check) {
		if (hasCheckFailure) {
			console.error(chalk.red(`${theme.status.error} Default GJC workflow skills are not fully installed`));
			console.error(chalk.dim(`Target: ${result.targetRoot}`));
			console.error(
				chalk.dim(`Missing: ${result.missing}; different: ${result.different}; matching: ${result.matching}`),
			);
			console.error(chalk.dim(inspectGuidance));
			console.error(
				chalk.dim(
					`Compare embedded defaults before overwriting local files with: ${APP_NAME} setup defaults --force`,
				),
			);
			process.exit(1);
		}
		console.log(chalk.green(`${theme.status.success} Default GJC workflow skills are installed`));
		console.log(chalk.dim(`Target: ${result.targetRoot}`));
		console.log(chalk.dim(inspectGuidance));
		return;
	}

	console.log(chalk.green(`${theme.status.success} Default GJC workflow skills installed`));
	console.log(chalk.dim(`Target: ${result.targetRoot}`));
	console.log(chalk.dim(`Written: ${result.written}; skipped: ${result.skipped}`));
	console.log(chalk.dim(inspectGuidance));
	if (result.skipped > 0 && !flags.force) {
		console.log(
			chalk.dim(
				`Existing local default workflow skill files were preserved. Use ${APP_NAME} setup defaults --force to overwrite them intentionally.`,
			),
		);
	}
}

async function handlePythonSetup(flags: { json?: boolean; check?: boolean }): Promise<void> {
	const check = await checkPythonSetup();

	if (flags.json) {
		console.log(JSON.stringify(check, null, 2));
		if (!check.available) process.exit(1);
		return;
	}

	if (!check.pythonPath) {
		console.error(chalk.red(`${theme.status.error} Python not found`));
		console.error(chalk.dim("Install Python 3.8+ and ensure it's in your PATH"));
		process.exit(1);
	}

	console.log(chalk.dim(`Python: ${check.pythonPath}`));
	if (check.usingManagedEnv) {
		console.log(chalk.dim(`Using managed environment: ${check.managedEnvPath}`));
	}

	if (check.available) {
		console.log(chalk.green(`\n${theme.status.success} Python execution is ready`));
		return;
	}

	console.error(chalk.red(`\n${theme.status.error} Python interpreter reported failure`));
	process.exit(1);
}

async function handleSttSetup(flags: { json?: boolean; check?: boolean }): Promise<void> {
	const { checkDependencies, formatDependencyStatus } = await import("../stt/setup");
	const status = await checkDependencies();

	if (flags.json) {
		console.log(JSON.stringify(status, null, 2));
		if (!status.recorder.available || !status.python.available || !status.whisper.available) process.exit(1);
		return;
	}

	console.log(formatDependencyStatus(status));

	if (status.recorder.available && status.python.available && status.whisper.available) {
		console.log(chalk.green(`\n${theme.status.success} Speech-to-text is ready`));
		return;
	}

	if (flags.check) {
		process.exit(1);
	}

	if (!status.python.available) {
		console.error(chalk.red(`\n${theme.status.error} Python not found`));
		console.error(chalk.dim("Install Python 3.8+ and ensure it's in your PATH"));
		process.exit(1);
	}

	if (!status.recorder.available) {
		console.error(chalk.yellow(`\n${theme.status.warning} No recording tool found`));
		console.error(chalk.dim(status.recorder.installHint));
	}

	if (!status.whisper.available) {
		console.log(chalk.dim(`\nInstalling openai-whisper...`));
		const { resolvePython } = await import("../stt/transcriber");
		const pythonCmd = resolvePython()!;
		const result = await $`${pythonCmd} -m pip install -q openai-whisper`.nothrow();
		if (result.exitCode !== 0) {
			console.error(chalk.red(`\n${theme.status.error} Failed to install openai-whisper`));
			console.error(chalk.dim("Try manually: pip install openai-whisper"));
			process.exit(1);
		}
	}

	const recheck = await checkDependencies();
	if (recheck.recorder.available && recheck.python.available && recheck.whisper.available) {
		console.log(chalk.green(`\n${theme.status.success} Speech-to-text is ready`));
	} else {
		console.error(chalk.red(`\n${theme.status.error} Setup incomplete`));
		console.log(formatDependencyStatus(recheck));
		process.exit(1);
	}
}
async function confirmImport(count: number): Promise<boolean> {
	if (!process.stdin.isTTY) return false;
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = (await rl.question(`Import ${count} credential(s) into ${getAgentDbPath()}? [y/N] `))
			.trim()
			.toLowerCase();
		return answer === "y" || answer === "yes";
	} finally {
		rl.close();
	}
}

/**
 * Discover existing Claude Code / Codex CLI credentials and import them into the
 * gjc credential store after a redacted preview + confirmation. Falls back to
 * manual-setup guidance when nothing importable is found.
 */
export interface CredentialsSetupDependencies {
	openStore?: typeof SqliteAuthCredentialStore.open;
	createAuthStorage?: (store: SqliteAuthCredentialStore) => AuthStorage;
	discover?: Parameters<typeof runExternalCredentialAutoImport>[0]["discover"];
}

export async function handleCredentialsSetup(
	flags: {
		json?: boolean;
		yes?: boolean;
		dryRun?: boolean;
		keychain?: boolean;
	},
	deps: CredentialsSetupDependencies = {},
): Promise<void> {
	const discoveryOptions = flags.keychain ? undefined : { readClaudeKeychain: async () => null };
	const store = await (deps.openStore ?? SqliteAuthCredentialStore.open)(getAgentDbPath());
	const authStorage = deps.createAuthStorage?.(store) ?? new AuthStorage(store);
	await authStorage.reload();
	try {
		const preview = await runExternalCredentialAutoImport({
			authStorage: {
				importCredentialIfAbsent: async () => ({
					inserted: false,
					reason: "skipped-existing",
					provider: "",
					entries: [],
				}),
			},
			discover: deps.discover,
			discoveryOptions,
			trigger: "setup-cli",
		});
		const result = preview.discovery ?? { importable: [], skipped: [], environment: [] };
		const candidates = filterAutoImportOAuthCredentials(result.importable);
		const filteredResult = { ...result, importable: candidates };
		const redactedPlan = {
			importable: candidates.map(c => ({
				provider: c.provider,
				kind: c.kind,
				source: c.source,
				identity: c.identity,
				expiresAt: c.expiresAt,
				redactedToken: c.redactedToken,
			})),
			skipped: result.skipped,
			environment: result.environment,
			keychainChecked: flags.keychain === true,
		};

		if (!flags.keychain && !flags.json) {
			process.stdout.write(chalk.dim("Claude Keychain not checked (pass --keychain to include it)\n"));
		}

		if (candidates.length === 0) {
			if (flags.json) {
				process.stdout.write(`${JSON.stringify({ ...redactedPlan, imported: [] })}\n`);
				return;
			}
			for (const line of formatDiscoverySummary(filteredResult)) process.stdout.write(`  ${line}\n`);
			process.stdout.write(
				chalk.yellow(
					`\nNo importable Claude/Codex credentials found. Continue with manual setup:\n` +
						`  ${APP_NAME} setup provider   (add an API-compatible provider)\n` +
						`  ${APP_NAME} (then /login)     (interactive OAuth/subscription login)\n`,
				),
			);
			return;
		}

		if (!flags.json) {
			process.stdout.write(chalk.bold("Discovered credentials (redacted):\n"));
			for (const line of formatDiscoverySummary(filteredResult)) process.stdout.write(`  ${line}\n`);
		}

		if (flags.dryRun) {
			if (flags.json) process.stdout.write(`${JSON.stringify({ ...redactedPlan, dryRun: true, imported: [] })}\n`);
			else process.stdout.write(chalk.dim(`\nDry run — no credentials imported.\n`));
			return;
		}

		const confirmed = flags.yes || (await confirmImport(candidates.length));
		if (!confirmed) {
			if (flags.json) {
				process.stdout.write(`${JSON.stringify({ ...redactedPlan, imported: [] })}\n`);
				return;
			}
			process.stdout.write(chalk.dim(`\nImport cancelled. Re-run with --yes to import non-interactively.\n`));
			return;
		}

		const summary = await runExternalCredentialAutoImport({
			authStorage,
			discover: deps.discover,
			discoveryOptions,
			trigger: "setup-cli",
		});

		if (flags.json) {
			process.stdout.write(
				`${JSON.stringify({
					...redactedPlan,
					imported: summary.imported.map(c => ({ provider: c.provider, kind: c.kind, source: c.source })),
					skippedImport: summary.skipped.map(s => ({
						provider: s.credential.provider,
						source: s.credential.source,
						reason: s.reason,
					})),
					failed: summary.failures.map(f => ({
						provider: f.credential?.provider,
						source: f.credential?.source ?? f.source,
						error: f.failureClass,
					})),
				})}\n`,
			);
			if (summary.failures.length > 0) process.exitCode = 1;
			return;
		}

		for (const credential of summary.imported) {
			process.stdout.write(
				`${chalk.green(`${theme.status.success} imported`)} ${formatCredentialSummaryLine(credential)}\n`,
			);
		}
		for (const line of formatCredentialAutoImportResult({ ...summary, imported: [], skipped: [] })) {
			process.stdout.write(`${chalk.dim(line)}\n`);
		}
		if (summary.failures.length > 0) {
			process.exitCode = 1;
			return;
		}
		process.stdout.write(chalk.dim(`\nCredentials saved to ${getAgentDbPath()}\n`));
	} finally {
		store.close();
	}
}

function formatCredentialSummaryLine(credential: { provider: string; kind: string; source: string }): string {
	return `${credential.provider} · ${credential.kind} (from ${credential.source})`;
}

/**
 * Print setup command help.
 */
export function printSetupHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} setup`)} - Install GJC defaults or optional feature dependencies

${chalk.bold("Usage:")}
  ${APP_NAME} setup [component] [options]

${chalk.bold("Components:")}
  defaults  Install bundled GJC default workflow skills (default)
  hermes   Optional: render/install a Hermes MCP bridge setup package
  hooks     Optional: install GJC native Codex UserPromptSubmit/Stop skill-state hooks
  provider  Optional: add a preset, OpenAI-compatible, or Anthropic-compatible API provider
  python    Optional: verify a Python 3 interpreter is reachable for code execution
  stt       Optional: install speech-to-text dependencies (openai-whisper, recording tools)
  credentials Optional: import existing Claude Code / Codex CLI credentials


${chalk.bold("Provider example:")}
  ${APP_NAME} setup provider --preset minimax
  ${APP_NAME} setup provider --preset glm
  MY_PROVIDER_KEY=sk-... ${APP_NAME} setup provider --compat openai --provider my-oai --base-url https://api.example.com/v1 --api-key-env MY_PROVIDER_KEY --model gpt-example

${chalk.bold("Hermes example:")}
  ${APP_NAME} setup hermes --root /path/to/repo
  ${APP_NAME} setup hermes --root /path/to/repo --profile my-bot --repo gajae-code --profile-dir /path/to/hermes/profile --install
  ${APP_NAME} setup hermes --root /path/to/repo --worktree-name hermes-gajae-code
  ${APP_NAME} setup hermes --root /path/to/repo --session-command "gjc --worktree hermes-custom --model <provider/model>"

${chalk.bold("Options:")}
  -c, --check       Check if dependencies are installed without installing
  -f, --force       Overwrite existing default workflow skill files
  --json            Output status as JSON
  --preset          Provider preset: minimax, minimax-cn, or glm (aliases include minimax-code and zai)
  --compat          Provider compatibility: openai or anthropic
  --provider        Provider id to add to models.yml
  --base-url        Provider API base URL
  --api-key-env     Read provider API key from this environment variable
  --model, --models Model id to add (repeat or comma-separate)
  --models-path     Override models config path
  --smoke           Run Hermes MCP setup smoke checks
  --install         Install generated Hermes setup files
  --root            Allowed Hermes MCP workdir/artifact root (repeatable)
  --profile         Hermes MCP profile namespace
  --repo            Hermes MCP repo namespace
  --session-command Explicit GJC session command; disables generated worktree flags
  --no-worktree     Disable default GJC --worktree isolation for Hermes sessions
  --worktree-name   Named GJC --worktree branch for Hermes sessions
  --mutation        Hermes MCP mutation classes: sessions,questions,reports,all
  --target          Hermes config file target for config-only install
  --profile-dir     Hermes profile directory for full setup install
  --dry-run         Preview discovered credentials without importing (credentials)
  -y, --yes         Import discovered credentials without an interactive prompt (credentials)
  --keychain        Include Claude macOS Keychain when discovering credentials

${chalk.bold("Examples:")}
  ${APP_NAME} setup                  Install bundled GJC default workflow skills
  ${APP_NAME} setup defaults         Install bundled GJC default workflow skills explicitly
  ${APP_NAME} setup defaults --check Check bundled GJC default workflow skills are installed
  ${APP_NAME} setup hooks            Install native Codex skill-state hooks
  ${APP_NAME} setup hooks --check    Check native Codex skill-state hooks
  ${APP_NAME} setup hermes --root /path/to/repo Render a model-agnostic Hermes MCP setup preview
  ${APP_NAME} setup python           Install Python execution dependencies
  ${APP_NAME} setup stt              Install speech-to-text dependencies
  ${APP_NAME} setup stt --check      Check if STT dependencies are available
  ${APP_NAME} setup python --check   Check if Python execution is available
  ${APP_NAME} setup credentials      Discover & import existing Claude/Codex credentials
  ${APP_NAME} setup credentials --dry-run  Preview importable credentials (redacted)
  ${APP_NAME} setup credentials --yes      Import without an interactive prompt
`);
}
