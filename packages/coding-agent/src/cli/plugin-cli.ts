/**
 * Plugin CLI command handlers.
 *
 * Handles `gjc plugin <command>` subcommands for plugin lifecycle management.
 */

import { APP_NAME, getProjectDir } from "@gajae-code/utils";
import chalk from "chalk";
import { resolveOrDefaultProjectRegistryPath } from "../discovery/helpers";
import {
	applyGjcBundleUpdate,
	bundleIdentity,
	type GjcBundleIdentity,
	type GjcBundleSummary,
	GjcPluginLoadError,
	getGjcBundle,
	getGjcPluginMigrationStatuses,
	installGjcBundle,
	isGjcPluginBundleSource,
	isGjcPluginSourceShape,
	listGjcBundles,
	migrationDoctorCheckMessage,
	previewGjcBundleUninstall,
	previewGjcBundleUpdate,
	runGjcPluginMigrationPreflight,
	uninstallGjcBundle,
} from "../extensibility/gjc-plugins";
import { PluginManager, parseSettingValue, validateSetting } from "../extensibility/plugins";
import {
	getInstalledPluginsRegistryPath,
	getMarketplacesCacheDir,
	getMarketplacesRegistryPath,
	getPluginsCacheDir,
	MarketplaceManager,
} from "../extensibility/plugins/marketplace/index.js";
import { theme } from "../modes/theme/theme";

// =============================================================================
// Types
// =============================================================================

export type PluginAction =
	| "install"
	| "uninstall"
	| "list"
	| "link"
	| "doctor"
	| "features"
	| "config"
	| "enable"
	| "disable"
	| "marketplace"
	| "discover"
	| "upgrade";

export interface PluginCommandArgs {
	action: PluginAction;
	args: string[];
	flags: {
		json?: boolean;
		fix?: boolean;
		migratePlugins?: boolean;
		force?: boolean;
		dryRun?: boolean;
		local?: boolean;
		enable?: string;
		disable?: string;
		set?: string;
		scope?: "user" | "project";
		user?: boolean;
		project?: boolean;
	};
}

// =============================================================================
// Argument Parser
// =============================================================================

const VALID_ACTIONS: PluginAction[] = [
	"install",
	"uninstall",
	"list",
	"link",
	"doctor",
	"features",
	"config",
	"enable",
	"disable",
	"marketplace",
	"discover",
	"upgrade",
];

/**
 * Parse plugin subcommand arguments.
 * Returns undefined if not a plugin command.
 */
export function parsePluginArgs(args: string[]): PluginCommandArgs | undefined {
	if (args.length === 0 || args[0] !== "plugin") {
		return undefined;
	}

	if (args.length < 2) {
		return { action: "list", args: [], flags: {} };
	}

	const action = args[1];
	if (!VALID_ACTIONS.includes(action as PluginAction)) {
		console.error(chalk.red(`Unknown plugin command: ${action}`));
		console.error(`Valid commands: ${VALID_ACTIONS.join(", ")}`);
		process.exit(1);
	}

	const result: PluginCommandArgs = {
		action: action as PluginAction,
		args: [],
		flags: {},
	};

	// Parse remaining arguments
	for (let i = 2; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--json") {
			result.flags.json = true;
		} else if (arg === "--fix") {
			result.flags.fix = true;
		} else if (arg === "--migrate-plugins") {
			result.flags.migratePlugins = true;
		} else if (arg === "--force") {
			result.flags.force = true;
		} else if (arg === "--dry-run") {
			result.flags.dryRun = true;
		} else if (arg === "-l" || arg === "--local") {
			result.flags.local = true;
		} else if (arg === "--user") {
			result.flags.user = true;
		} else if (arg === "--project") {
			result.flags.project = true;
		} else if (arg === "--enable" && i + 1 < args.length) {
			result.flags.enable = args[++i];
		} else if (arg === "--disable" && i + 1 < args.length) {
			result.flags.disable = args[++i];
		} else if (arg === "--set" && i + 1 < args.length) {
			result.flags.set = args[++i];
		} else if (arg === "--scope" && i + 1 < args.length && !args[i + 1].startsWith("-")) {
			const s = args[++i];
			if (s === "user" || s === "project") {
				result.flags.scope = s;
			} else {
				console.error(chalk.red(`Invalid --scope value: "${s}". Must be "user" or "project".`));
				process.exit(1);
			}
		} else if (arg === "--scope") {
			// --scope with no value following
			console.error(chalk.red(`--scope requires a value: "user" or "project".`));
			process.exit(1);
		} else if (!arg.startsWith("-")) {
			result.args.push(arg);
		}
	}

	return result;
}

import { classifyInstallTarget } from "./classify-install-target";
import { findMarketplacesOffering, isBareInstallName } from "./marketplace-hint";

export { classifyInstallTarget } from "./classify-install-target";

// =============================================================================
// Command Handlers
// =============================================================================

/**
 * Run a plugin command.
 */
export async function runPluginCommand(cmd: PluginCommandArgs): Promise<void> {
	const manager = new PluginManager();

	switch (cmd.action) {
		case "install":
			await handleInstall(manager, cmd.args, cmd.flags);
			break;
		case "uninstall":
			await handleUninstall(manager, cmd.args, cmd.flags);
			break;
		case "list":
			await handleList(manager, cmd.flags);
			break;
		case "link":
			await handleLink(manager, cmd.args, cmd.flags);
			break;
		case "doctor":
			await handleDoctor(manager, cmd.flags);
			break;
		case "features":
			await handleFeatures(manager, cmd.args, cmd.flags);
			break;
		case "config":
			await handleConfig(manager, cmd.args, cmd.flags);
			break;
		case "enable":
			await handleEnable(manager, cmd.args, cmd.flags);
			break;
		case "disable":
			await handleDisable(manager, cmd.args, cmd.flags);
			break;
		case "marketplace":
			await handleMarketplace(cmd.args, cmd.flags);
			break;
		case "discover":
			await handleDiscover(cmd.args, cmd.flags);
			break;
		case "upgrade":
			await handleUpgrade(cmd.args, cmd.flags);
			break;
	}
}

// =============================================================================
// Marketplace Handlers
// =============================================================================

async function makeMarketplaceManager(): Promise<MarketplaceManager> {
	return new MarketplaceManager({
		marketplacesRegistryPath: getMarketplacesRegistryPath(),
		installedRegistryPath: getInstalledPluginsRegistryPath(),
		projectInstalledRegistryPath: await resolveOrDefaultProjectRegistryPath(getProjectDir()),
		marketplacesCacheDir: getMarketplacesCacheDir(),
		pluginsCacheDir: getPluginsCacheDir(),
	});
}

async function handleMarketplace(args: string[], _flags: PluginCommandArgs["flags"]): Promise<void> {
	const subcommand = args[0] ?? "list";
	const manager = await makeMarketplaceManager();

	switch (subcommand) {
		case "add": {
			const source = args[1];
			if (!source) {
				console.error(chalk.red(`Usage: ${APP_NAME} plugin marketplace add <source>`));
				process.exit(1);
			}
			try {
				await manager.addMarketplace(source);
				console.log(chalk.green(`${theme.status.success} Added marketplace: ${source}`));
			} catch (err) {
				console.error(chalk.red(`${theme.status.error} Failed to add marketplace: ${err}`));
				process.exit(1);
			}
			break;
		}
		case "remove":
		case "rm": {
			const name = args[1];
			if (!name) {
				console.error(chalk.red(`Usage: ${APP_NAME} plugin marketplace remove <name>`));
				process.exit(1);
			}
			try {
				await manager.removeMarketplace(name);
				console.log(chalk.green(`${theme.status.success} Removed marketplace: ${name}`));
			} catch (err) {
				console.error(chalk.red(`${theme.status.error} Failed to remove marketplace: ${err}`));
				process.exit(1);
			}
			break;
		}
		case "update": {
			try {
				const name = args[1];
				if (name) {
					await manager.updateMarketplace(name);
					console.log(chalk.green(`${theme.status.success} Updated marketplace: ${name}`));
				} else {
					const results = await manager.updateAllMarketplaces();
					console.log(chalk.green(`${theme.status.success} Updated ${results.length} marketplace(s)`));
				}
			} catch (err) {
				console.error(chalk.red(`${theme.status.error} Failed to update marketplace: ${err}`));
				process.exit(1);
			}
			break;
		}
		default: {
			if (subcommand !== "list") {
				console.error(chalk.red(`Unknown marketplace subcommand: ${subcommand}`));
				console.error(chalk.dim("Valid subcommands: add, remove, update, list"));
				process.exit(1);
			}
			try {
				const marketplaces = await manager.listMarketplaces();
				if (marketplaces.length === 0) {
					console.log(chalk.dim("No marketplaces configured"));
					console.log(chalk.dim(`\nAdd one with: ${APP_NAME} plugin marketplace add <source>`));
					return;
				}
				console.log(chalk.bold("Configured Marketplaces:\n"));
				for (const mp of marketplaces) {
					console.log(`  ${chalk.cyan(mp.name)}  ${chalk.dim(mp.sourceUri)}`);
				}
			} catch (err) {
				console.error(chalk.red(`${theme.status.error} Failed to list marketplaces: ${err}`));
				process.exit(1);
			}
			break;
		}
	}
}

async function handleDiscover(args: string[], _flags: PluginCommandArgs["flags"]): Promise<void> {
	const marketplace = args[0];
	const manager = await makeMarketplaceManager();
	try {
		const plugins = await manager.listAvailablePlugins(marketplace);

		if (plugins.length === 0) {
			console.log(chalk.dim(marketplace ? `No plugins found in ${marketplace}` : "No plugins available"));
			return;
		}

		console.log(chalk.bold(`Available Plugins${marketplace ? ` (${marketplace})` : ""}:\n`));
		for (const plugin of plugins) {
			console.log(`  ${chalk.cyan(plugin.name)}${plugin.version ? `@${plugin.version}` : ""}`);
			if (plugin.description) {
				console.log(chalk.dim(`    ${plugin.description}`));
			}
		}
	} catch (err) {
		console.error(chalk.red(`${theme.status.error} Failed to discover plugins: ${err}`));
		process.exit(1);
	}
}

/**
 * Scope-qualified GJC bundle upgrade: re-resolve the stored source, review the
 * candidate, then apply it as a compare-and-swap. `--dry-run` stops after the
 * preview. Requires exactly one of `--user` / `--project` because (scope, name)
 * is the canonical target.
 */
async function handleGjcUpgrade(name: string, flags: PluginCommandArgs["flags"]): Promise<void> {
	if (flags.user === flags.project) {
		console.error(chalk.red(`GJC bundle upgrade requires exactly one of --user or --project for "${name}".`));
		process.exit(1);
	}
	const scope: "user" | "project" = flags.user ? "user" : "project";
	const ctx = { cwd: getProjectDir() };
	const identity = bundleIdentity(scope, name);

	const emitError = (error: { code: string; message: string; recovery?: string }): never => {
		if (flags.json) console.log(JSON.stringify({ error }, null, 2));
		else {
			console.error(chalk.red(`${theme.status.error} ${error.message}`));
			if (error.recovery) console.error(chalk.dim(`  Try: ${error.recovery}`));
		}
		process.exit(3);
	};

	// Source re-resolution can throw with a cause carrying the raw locator, so
	// the whole flow reports a stable code instead of the underlying error.
	try {
		await runGjcUpgrade(ctx, identity, name, scope, flags, emitError);
	} catch (err) {
		const reason = err instanceof GjcPluginLoadError ? err.code : "upgrade_failed";
		console.error(chalk.red(`${theme.status.error} Failed to upgrade GJC bundle ${name} (${reason})`));
		process.exit(1);
	}
}

async function runGjcUpgrade(
	ctx: { cwd: string },
	identity: GjcBundleIdentity,
	name: string,
	scope: "user" | "project",
	flags: PluginCommandArgs["flags"],
	emitError: (error: { code: string; message: string; recovery?: string }) => never,
): Promise<void> {
	const preview = await previewGjcBundleUpdate(ctx, identity);
	if (!preview.ok) emitError(preview.error);
	else if (flags.dryRun || !preview.value.changed) {
		const { changed, candidateVersion, addedSurfaceIds, removedSurfaceIds } = preview.value;
		if (flags.json) {
			console.log(
				JSON.stringify(
					{
						status: changed ? "update-available" : "up-to-date",
						identity,
						currentVersion: preview.value.current.version,
						candidateVersion,
						addedSurfaceIds,
						removedSurfaceIds,
					},
					null,
					2,
				),
			);
		} else if (!changed) {
			console.log(chalk.dim(`GJC bundle ${name} (${scope}) is up to date at ${preview.value.current.version}`));
		} else {
			console.log(
				chalk.cyan(`[dry-run] ${name} (${scope}): ${preview.value.current.version} -> ${candidateVersion}`),
			);
			if (addedSurfaceIds.length > 0) console.log(chalk.dim(`  + ${addedSurfaceIds.join(", ")}`));
			if (removedSurfaceIds.length > 0) console.log(chalk.dim(`  - ${removedSurfaceIds.join(", ")}`));
		}
	} else {
		const applied = await applyGjcBundleUpdate(ctx, preview.value.token);
		if (!applied.ok) emitError(applied.error);
		else if (flags.json) {
			console.log(
				JSON.stringify(
					{
						status: applied.value.status,
						bundle: applied.value.summary,
						remnantCount: applied.value.remnantCount,
					},
					null,
					2,
				),
			);
		} else {
			console.log(
				chalk.green(
					`${theme.status.success} ${applied.value.status} GJC bundle ${name}@${applied.value.summary.version} (${scope})`,
				),
			);
			if (applied.value.remnantCount > 0) {
				console.error(chalk.yellow(`  ${applied.value.remnantCount} leftover directory could not be removed`));
			}
		}
	}
}

async function handleUpgrade(args: string[], flags: PluginCommandArgs["flags"]): Promise<void> {
	const pluginId = args[0];
	// Scope-qualified GJC bundles upgrade through the lifecycle service, never
	// through the marketplace manager.
	if (pluginId && (flags.user || flags.project)) {
		const scope: "user" | "project" = flags.user ? "user" : "project";
		const existing = await getGjcBundle({ cwd: getProjectDir() }, bundleIdentity(scope, pluginId));
		if (existing.ok) {
			await handleGjcUpgrade(pluginId, flags);
			return;
		}
	}
	const manager = await makeMarketplaceManager();
	try {
		if (pluginId) {
			if (flags.scope) {
				const result = await manager.upgradePlugin(pluginId, flags.scope);
				console.log(chalk.green(`Upgraded ${pluginId} (${flags.scope}) to ${result.version}`));
			} else {
				const entries = await manager.upgradePluginAcrossScopes(pluginId);
				for (const entry of entries) {
					console.log(chalk.green(`Upgraded ${pluginId} (${entry.scope}) to ${entry.version}`));
				}
			}
		} else {
			if (flags.scope) {
				console.error(
					chalk.yellow(
						`Warning: --scope is ignored when upgrading all plugins. Use 'gjc plugin upgrade <id> --scope ${flags.scope}' to target a specific plugin and scope.`,
					),
				);
			}
			const results = await manager.upgradeAllPlugins();
			if (results.length === 0) {
				console.log("All marketplace plugins are up to date.");
			} else {
				for (const r of results) {
					console.log(chalk.green(`  ${r.pluginId} (${r.scope}): ${r.from} -> ${r.to}`));
				}
			}
		}
	} catch (err) {
		console.error(chalk.red(`Failed to upgrade: ${err}`));
		process.exit(1);
	}
}

/**
 * Stable, non-identifying reason for an install failure. The raw spec and the
 * underlying cause can both carry credentials, a query string, or an absolute
 * home path, so neither is ever printed.
 */
function describeInstallFailure(error: unknown): string {
	return error instanceof GjcPluginLoadError ? error.code : "install_failed";
}

function isGjcRegistryShapeFailure(error: unknown): boolean {
	return (
		(error instanceof GjcPluginLoadError && error.code === "invalid_manifest") ||
		(error instanceof TypeError &&
			/(?:not iterable|localeCompare|reading ['"](?:scope|name|pluginRoot|plugins|map))/.test(error.message))
	);
}

/**
 * Which scopes own `name` as a GJC bundle.
 *
 * Classification runs for every uninstall target, including npm and marketplace
 * names that never reach the GJC path, so the preview mode must be read-only:
 * the migrating read used by the real path persists legacy-root discovery and
 * takes the scope lock, which would let `--dry-run` write a registry for a
 * target it does not even own.
 *
 * Both modes treat an unreadable scope registry as fatal rather than skipping
 * the scope: the corrupt registry may be the one that owns the name, so
 * ownership must never be guessed. Falling through to the marketplace or npm
 * branch on an unreadable registry could preview — and the real command could
 * then remove — a same-named plugin the user did not target.
 */
async function findGjcBundlesForUninstall(
	cwd: string,
	name: string,
	scope: "user" | "project" | undefined,
	mode: { preview: boolean },
): Promise<GjcBundleIdentity[]> {
	const scopes = scope ? [scope] : (["user", "project"] as const);
	const matches: GjcBundleIdentity[] = [];
	for (const candidateScope of scopes) {
		const identity = bundleIdentity(candidateScope, name);
		try {
			if (mode.preview) {
				const result = await previewGjcBundleUninstall({ cwd }, identity);
				if (!result.ok && result.error.code === "registry_unreadable") {
					// Ownership of this scope is unknown; guessing another owner (or
					// reporting a false both-scopes ambiguity against the other scope's
					// real match) could preview the wrong target. Fail closed on the
					// typed refusal, surfaced with its own repair hint.
					throw new GjcPluginLoadError("invalid_manifest", result.error.message);
				}
				// Any other refusal still identifies a GJC bundle this scope owns
				// (e.g. invalid_target for non-uninstallable metadata); surface it so
				// the preview refuses exactly what the real uninstall refuses.
				if (result.ok || result.error.code !== "not_installed") matches.push(identity);
			} else {
				const result = await getGjcBundle({ cwd }, identity);
				if (result.ok) matches.push(result.value.identity);
			}
		} catch (error) {
			if (!isGjcRegistryShapeFailure(error)) throw error;
			// Unreadable scope registry: ownership is unknown, so resolve nothing
			// and let the caller fail closed instead of guessing another owner.
			throw new GjcPluginLoadError(
				"invalid_manifest",
				`Could not read the GJC ${candidateScope} plugin registry while resolving "${name}"`,
				{ cause: error },
			);
		}
	}
	return matches;
}
async function handleInstall(
	manager: PluginManager,
	packages: string[],
	flags: {
		json?: boolean;
		force?: boolean;
		dryRun?: boolean;
		scope?: "user" | "project";
		user?: boolean;
		project?: boolean;
	},
): Promise<void> {
	if (packages.length === 0) {
		console.error(chalk.red(`Usage: ${APP_NAME} plugin install <package[@version]>[features] ...`));
		console.error(chalk.dim("Examples:"));
		console.error(chalk.dim(`  ${APP_NAME} plugin install @gajae-code/exa`));
		console.error(chalk.dim(`  ${APP_NAME} plugin install name@marketplace`));
		process.exit(1);
	}

	// Build known marketplace set for classification
	const mktMgr = await makeMarketplaceManager();
	const knownMarketplaces = new Set((await mktMgr.listMarketplaces()).map(m => m.name));

	for (const spec of packages) {
		// A GJC bundle is identified by the SHAPE of its source: a filesystem path,
		// a git locator, or a tarball. npm and marketplace specs are never any of
		// those, so shape alone separates the two worlds without resolving.
		//
		// Shape is checked BEFORE `isGjcPluginBundleSource`, which resolves the
		// source: a deleted or unreachable GJC source fails that probe and would
		// otherwise fall through to npm, losing the create-only refusal the
		// lifecycle owes for an already-installed target.
		if (isGjcPluginSourceShape(spec) || (await isGjcPluginBundleSource(spec))) {
			if (flags.user === flags.project) {
				console.error(
					// The spec can carry credentials or an absolute home path, so name
					// the missing flag instead of echoing it back.
					chalk.red("GJC plugin bundle install requires exactly one of --user or --project."),
				);
				process.exit(1);
			}
			const scope: "user" | "project" = flags.user ? "user" : "project";
			try {
				const res = await installGjcBundle({ cwd: getProjectDir() }, scope, spec);
				if (!res.ok) {
					const doc = {
						error: { code: res.error.code, message: res.error.message, recovery: res.error.recovery },
					};
					if (flags.json) console.log(JSON.stringify(doc, null, 2));
					else {
						console.error(chalk.red(`${theme.status.error} ${res.error.message}`));
						if (res.error.recovery) console.error(chalk.dim(`  Try: ${res.error.recovery}`));
					}
					process.exit(3);
				}
				const { summary } = res.value;
				if (flags.json) {
					console.log(JSON.stringify({ status: res.value.status, bundle: summary }, null, 2));
				} else {
					console.log(
						chalk.green(
							`${theme.status.success} installed GJC plugin ${summary.identity.name}@${summary.version} (${scope})`,
						),
					);
				}
			} catch (err) {
				// Never echo the raw spec or the underlying cause: either can carry
				// credentials, a query string, or an absolute home path.
				const reason = err instanceof GjcPluginLoadError ? err.code : "install_failed";
				console.error(chalk.red(`${theme.status.error} Failed to install GJC bundle (${reason})`));
				process.exit(1);
			}
			continue;
		}

		const target = classifyInstallTarget(spec, knownMarketplaces);

		if (target.type === "marketplace") {
			try {
				const entry = await mktMgr.installPlugin(target.name, target.marketplace, {
					force: flags.force,
					scope: flags.scope,
				});
				console.log(
					chalk.green(
						`${theme.status.success} Installed ${target.name} from ${target.marketplace} (${entry.version})`,
					),
				);
			} catch (err) {
				// The spec can carry credentials, a query string, or an absolute home
				// path, so report the failure without echoing it or the raw cause.
				console.error(chalk.red(`${theme.status.error} Failed to install plugin (${describeInstallFailure(err)})`));
				process.exit(1);
			}
			continue;
		}

		// --scope only applies to marketplace installs; warn when it would be silently no-op'd for npm.
		if (flags.scope) {
			console.error(
				chalk.yellow(
					`Warning: --scope is only supported for marketplace installs (name@marketplace). Ignoring for ${spec}.`,
				),
			);
		}

		// npm path
		try {
			const result = await manager.install(spec, { force: flags.force, dryRun: flags.dryRun });

			if (flags.json) {
				console.log(JSON.stringify(result, null, 2));
			} else {
				if (flags.dryRun) {
					console.log(chalk.dim(`[dry-run] Would install ${spec}`));
				} else {
					console.log(chalk.green(`${theme.status.success} Installed ${result.name}@${result.version}`));
					if (result.enabledFeatures && result.enabledFeatures.length > 0) {
						console.log(chalk.dim(`  Features: ${result.enabledFeatures.join(", ")}`));
					}
					if (result.manifest.description) {
						console.log(chalk.dim(`  ${result.manifest.description}`));
					}
				}
			}
		} catch (err) {
			// The spec can carry credentials, a query string, or an absolute home
			// path, so report the failure without echoing it or the raw cause.
			console.error(chalk.red(`${theme.status.error} Failed to install plugin (${describeInstallFailure(err)})`));
			// A bare name (no `@scope`, no version, no path separator) is safe to
			// echo, and it is exactly the shape a user copies out of
			// `plugin discover`. Point at the qualified spec that would work.
			if (isBareInstallName(spec)) {
				const offering = await findMarketplacesOffering(mktMgr, spec).catch(() => []);
				for (const marketplace of offering) {
					console.error(chalk.dim(`  Try: ${APP_NAME} plugin install ${spec}@${marketplace}`));
				}
			}
			process.exit(1);
		}
	}
}

async function handleUninstall(
	manager: PluginManager,
	packages: string[],
	flags: { json?: boolean; dryRun?: boolean; scope?: "user" | "project"; user?: boolean; project?: boolean },
): Promise<void> {
	if (packages.length === 0) {
		console.error(chalk.red(`Usage: ${APP_NAME} plugin uninstall <package> ...`));
		process.exit(1);
	}

	const scope = flags.scope ?? (flags.user ? "user" : flags.project ? "project" : undefined);
	const cwd = getProjectDir();
	const mktMgr = await makeMarketplaceManager();
	const installedPlugins = new Set((await mktMgr.listInstalledPlugins()).map(p => p.id));

	for (const name of packages) {
		// Every branch below is split by mode rather than short-circuited inside the
		// mutating call: under --dry-run this handler only ever reaches read-only
		// APIs, so no path can write.
		let gjcMatches: GjcBundleIdentity[];
		try {
			gjcMatches = await findGjcBundlesForUninstall(cwd, name, scope, { preview: Boolean(flags.dryRun) });
		} catch (error) {
			// An unreadable scope registry means ownership of `name` is unknown; the
			// classification above fails closed and this handler must too, rather than
			// guessing a marketplace or npm owner for a destructive operation.
			const refusal =
				error instanceof Error && ("code" in error || error instanceof GjcPluginLoadError)
					? error.message
					: `Could not classify "${name}" for uninstall`;
			console.error(chalk.red(`${theme.status.error} ${refusal}`));
			console.error(chalk.dim("  Repair the GJC plugin registry (gjc plugin doctor --fix), then retry"));
			process.exit(3);
		}
		if (gjcMatches.length > 0) {
			if (gjcMatches.length > 1) {
				console.error(chalk.red(`GJC bundle "${name}" is installed in both scopes; specify --user or --project.`));
				process.exit(1);
			}
			const identity = gjcMatches[0];
			const result = flags.dryRun
				? await previewGjcBundleUninstall({ cwd }, identity)
				: await uninstallGjcBundle({ cwd }, identity);
			if (!result.ok) {
				console.error(chalk.red(`${theme.status.error} ${result.error.message}`));
				if (result.error.recovery) console.error(chalk.dim(`  Try: ${result.error.recovery}`));
				process.exit(3);
			}
			if (flags.dryRun) {
				if (flags.json) console.log(JSON.stringify({ dryRun: true, wouldUninstall: identity }));
				else console.log(chalk.dim(`[dry-run] Would uninstall ${identity.name} (${identity.scope})`));
			} else if (flags.json) {
				console.log(JSON.stringify({ uninstalled: identity }));
			} else {
				console.log(chalk.green(`${theme.status.success} Uninstalled ${identity.name} (${identity.scope})`));
			}
			continue;
		}

		if (installedPlugins.has(name)) {
			try {
				if (flags.dryRun) {
					const target = await mktMgr.resolveUninstallTarget(name, flags.scope);
					if (flags.json) console.log(JSON.stringify({ dryRun: true, wouldUninstall: name, scope: target.scope }));
					else console.log(chalk.dim(`[dry-run] Would uninstall ${name} (${target.scope})`));
				} else {
					await mktMgr.uninstallPlugin(name, flags.scope);
					if (flags.json) console.log(JSON.stringify({ uninstalled: name }));
					else console.log(chalk.green(`${theme.status.success} Uninstalled ${name}`));
				}
			} catch (err) {
				console.error(chalk.red(`${theme.status.error} Failed to uninstall ${name}: ${err}`));
				process.exit(1);
			}
			continue;
		}

		try {
			if (flags.dryRun) {
				await manager.previewUninstall(name);
				if (flags.json) console.log(JSON.stringify({ dryRun: true, wouldUninstall: name }));
				else console.log(chalk.dim(`[dry-run] Would uninstall ${name}`));
			} else {
				await manager.uninstall(name);
				if (flags.json) console.log(JSON.stringify({ uninstalled: name }));
				else console.log(chalk.green(`${theme.status.success} Uninstalled ${name}`));
			}
		} catch (err) {
			console.error(chalk.red(`${theme.status.error} Failed to uninstall ${name}: ${err}`));
			process.exit(1);
		}
	}
}

async function handleList(manager: PluginManager, flags: { json?: boolean }): Promise<void> {
	const npmPlugins = await manager.list();
	const mktMgr = await makeMarketplaceManager();
	const mktPlugins = await mktMgr.listInstalledPlugins();
	const cwd = getProjectDir();
	const gjcBundles: GjcBundleSummary[] = await listGjcBundles({ cwd });

	if (flags.json) {
		console.log(JSON.stringify({ npm: npmPlugins, marketplace: mktPlugins, gjc: gjcBundles }, null, 2));
		return;
	}

	if (npmPlugins.length === 0 && mktPlugins.length === 0 && gjcBundles.length === 0) {
		console.log(chalk.dim("No plugins installed"));
		console.log(chalk.dim(`\nInstall plugins with: ${APP_NAME} plugin install <package>`));
		return;
	}

	if (npmPlugins.length > 0) {
		console.log(chalk.bold("npm Plugins:\n"));
		for (const plugin of npmPlugins) {
			const status = plugin.enabled ? chalk.green(theme.status.enabled) : chalk.dim(theme.status.disabled);
			const nameVersion = `${plugin.name}@${plugin.version}`;
			console.log(`${status} ${nameVersion}`);
			if (plugin.manifest.description) {
				console.log(chalk.dim(`  ${plugin.manifest.description}`));
			}
			if (plugin.enabledFeatures && plugin.enabledFeatures.length > 0) {
				console.log(chalk.dim(`  Features: ${plugin.enabledFeatures.join(", ")}`));
			}
			if (plugin.manifest.features) {
				const availableFeatures = Object.keys(plugin.manifest.features);
				if (availableFeatures.length > 0) {
					const enabledSet = new Set(plugin.enabledFeatures ?? []);
					const featureDisplay = availableFeatures
						.map(f => (enabledSet.has(f) ? chalk.green(f) : chalk.dim(f)))
						.join(", ");
					console.log(chalk.dim(`  Available: [${featureDisplay}]`));
				}
			}
		}
	}

	if (mktPlugins.length > 0) {
		if (npmPlugins.length > 0) console.log();
		console.log(chalk.bold("Marketplace Plugins:\n"));
		for (const plugin of mktPlugins) {
			const entry = plugin.entries[0];
			const version = entry?.version ?? "unknown";
			const shadowLabel = plugin.shadowedBy ? chalk.dim(" [shadowed]") : "";
			const scopeLabel = chalk.dim(` (${plugin.scope})`);
			console.log(`  ${plugin.id} (${version})${scopeLabel}${shadowLabel}`);
		}
	}

	if (gjcBundles.length > 0) {
		if (npmPlugins.length > 0 || mktPlugins.length > 0) console.log();
		console.log(chalk.bold("GJC Plugin Bundles:\n"));
		for (const plugin of gjcBundles) {
			const status = plugin.enabled ? chalk.green(theme.status.enabled) : chalk.dim(theme.status.disabled);
			const scopeLabel = chalk.dim(` (${plugin.identity.scope})`);
			const disabledCount = plugin.surfaces.filter(s => !s.enabled).length;
			const quarantineCount = plugin.surfaces.filter(s => s.quarantined).length;
			const detail = [
				disabledCount > 0 ? `${disabledCount} disabled` : null,
				quarantineCount > 0 ? `${quarantineCount} quarantined` : null,
			]
				.filter((v): v is string => Boolean(v))
				.join(", ");
			console.log(
				`${status} ${plugin.identity.name}@${plugin.version}${scopeLabel}${detail ? chalk.dim(` — ${detail}`) : ""}`,
			);
		}
	}
}

async function handleLink(manager: PluginManager, paths: string[], flags: { json?: boolean }): Promise<void> {
	if (paths.length === 0) {
		console.error(chalk.red(`Usage: ${APP_NAME} plugin link <path>`));
		process.exit(1);
	}

	try {
		const result = await manager.link(paths[0]);

		if (flags.json) {
			console.log(JSON.stringify(result, null, 2));
		} else {
			console.log(chalk.green(`${theme.status.success} Linked ${result.name} from ${paths[0]}`));
		}
	} catch (err) {
		console.error(chalk.red(`${theme.status.error} Failed to link: ${err}`));
		process.exit(1);
	}
}

async function collectMarketplaceDoctorChecks(): Promise<
	Array<{ name: string; status: "ok" | "warning" | "error"; message: string }>
> {
	const extra: Array<{ name: string; status: "ok" | "warning" | "error"; message: string }> = [];
	try {
		const mktMgr = await makeMarketplaceManager();
		const installed = await mktMgr.listInstalledPlugins();
		for (const summary of installed) {
			for (const entry of summary.entries) {
				let exists = false;
				try {
					const { statSync } = await import("node:fs");
					statSync(entry.installPath);
					exists = true;
				} catch {}
				if (!exists) {
					extra.push({
						name: `marketplace:${summary.id}:${entry.scope}`,
						status: "error",
						message: `Marketplace plugin "${summary.id}" (${entry.scope}) references missing cache dir "${entry.installPath}" (v${entry.version}); reinstall or upgrade the plugin`,
					});
				}
			}
		}
	} catch {}
	return extra;
}

async function handleDoctor(
	manager: PluginManager,
	flags: { json?: boolean; fix?: boolean; migratePlugins?: boolean },
): Promise<void> {
	const checks = await manager.doctor({ fix: flags.fix });
	checks.push(...(await collectMarketplaceDoctorChecks()));
	try {
		const statuses = flags.migratePlugins
			? await runGjcPluginMigrationPreflight(getProjectDir())
			: await getGjcPluginMigrationStatuses(getProjectDir(), { migrate: false });
		for (const status of statuses) {
			checks.push({
				name: `gjc-plugin:${status.scope}:${status.plugin}:migration`,
				status: status.status === "migrated" ? "ok" : "error",
				message: `${flags.migratePlugins ? "migration pre-flight: " : ""}${migrationDoctorCheckMessage(status)}`,
			});
		}
	} catch (error) {
		checks.push({
			name: "gjc-plugin:migration",
			status: "error",
			message: `Unable to inspect GJC plugin migration status: ${error instanceof Error ? error.message : String(error)}`,
		});
	}

	if (flags.json) {
		console.log(JSON.stringify(checks, null, 2));
		return;
	}

	console.log(chalk.bold("Plugin Health Check\n"));

	for (const check of checks) {
		const icon =
			check.status === "ok"
				? chalk.green(theme.status.success)
				: check.status === "warning"
					? chalk.yellow(theme.status.warning)
					: chalk.red(theme.status.error);
		console.log(`${icon} ${check.name}: ${check.message}`);
		if (check.fixed) {
			console.log(chalk.dim(`  ${theme.nav.cursor} Fixed`));
		}
	}

	const errors = checks.filter(c => c.status === "error" && !c.fixed).length;
	const warnings = checks.filter(c => c.status === "warning" && !c.fixed).length;
	const ok = checks.filter(c => c.status === "ok").length;
	const fixed = checks.filter(c => c.fixed).length;

	console.log("");
	console.log(`Summary: ${ok} ok, ${warnings} warnings, ${errors} errors${fixed > 0 ? `, ${fixed} fixed` : ""}`);

	if (errors > 0) {
		if (!flags.fix && !flags.migratePlugins) {
			console.log(chalk.dim("\nRun with --fix to attempt automatic repair"));
		}
		process.exit(1);
	}
}

async function handleFeatures(
	manager: PluginManager,
	args: string[],
	flags: { json?: boolean; enable?: string; disable?: string; set?: string },
): Promise<void> {
	if (args.length === 0) {
		console.error(
			chalk.red(`Usage: ${APP_NAME} plugin features <plugin> [--enable f1,f2] [--disable f1] [--set f1,f2]`),
		);
		process.exit(1);
	}

	const pluginName = args[0];
	const plugins = await manager.list();
	const plugin = plugins.find(p => p.name === pluginName);

	if (!plugin) {
		console.error(chalk.red(`Plugin "${pluginName}" not found`));
		process.exit(1);
	}

	// Handle modifications
	if (flags.enable || flags.disable || flags.set) {
		let currentFeatures = new Set((await manager.getEnabledFeatures(pluginName)) ?? []);

		if (flags.set) {
			// --set replaces all features
			currentFeatures = new Set(
				flags.set
					.split(",")
					.map(f => f.trim())
					.filter(Boolean),
			);
		} else {
			if (flags.enable) {
				for (const f of flags.enable
					.split(",")
					.map(f => f.trim())
					.filter(Boolean)) {
					currentFeatures.add(f);
				}
			}
			if (flags.disable) {
				for (const f of flags.disable
					.split(",")
					.map(f => f.trim())
					.filter(Boolean)) {
					currentFeatures.delete(f);
				}
			}
		}

		await manager.setEnabledFeatures(pluginName, [...currentFeatures]);
		console.log(chalk.green(`${theme.status.success} Updated features for ${pluginName}`));
	}

	// Display current state
	const updatedFeatures = await manager.getEnabledFeatures(pluginName);

	if (flags.json) {
		console.log(
			JSON.stringify(
				{
					plugin: pluginName,
					enabledFeatures: updatedFeatures,
					availableFeatures: plugin.manifest.features ? Object.keys(plugin.manifest.features) : [],
				},
				null,
				2,
			),
		);
		return;
	}

	console.log(chalk.bold(`Features for ${pluginName}:\n`));

	if (!plugin.manifest.features || Object.keys(plugin.manifest.features).length === 0) {
		console.log(chalk.dim("  No optional features available"));
		return;
	}

	const enabledSet = new Set(updatedFeatures ?? []);
	for (const [name, feat] of Object.entries(plugin.manifest.features)) {
		const enabled = enabledSet.has(name);
		const icon = enabled ? chalk.green(theme.status.enabled) : chalk.dim(theme.status.disabled);
		const defaultLabel = feat.default ? chalk.dim(" (default)") : "";
		console.log(`${icon} ${name}${defaultLabel}`);
		if (feat.description) {
			console.log(chalk.dim(`    ${feat.description}`));
		}
	}
}

async function handleConfig(
	manager: PluginManager,
	args: string[],
	flags: { json?: boolean; local?: boolean },
): Promise<void> {
	if (args.length === 0) {
		console.error(
			chalk.red(`Usage: ${APP_NAME} plugin config <list|get|set|delete|validate> <plugin> [key] [value]`),
		);
		process.exit(1);
	}

	const [subcommand, pluginName, key, ...valueArgs] = args;

	// Special case: validate doesn't need a plugin name
	if (subcommand === "validate") {
		await handleConfigValidate(manager, flags);
		return;
	}

	if (!pluginName) {
		console.error(chalk.red("Plugin name required"));
		process.exit(1);
	}

	const plugins = await manager.list();
	const plugin = plugins.find(p => p.name === pluginName);

	if (!plugin) {
		console.error(chalk.red(`Plugin "${pluginName}" not found`));
		process.exit(1);
	}

	switch (subcommand) {
		case "list": {
			const settings = await manager.getPluginSettings(pluginName);
			const schema = plugin.manifest.settings || {};

			if (flags.json) {
				console.log(JSON.stringify({ settings, schema }, null, 2));
				return;
			}

			console.log(chalk.bold(`Settings for ${pluginName}:\n`));

			if (Object.keys(schema).length === 0) {
				console.log(chalk.dim("  No settings defined"));
				return;
			}

			for (const [k, s] of Object.entries(schema)) {
				const value = settings[k] ?? s.default;
				const displayValue = s.secret && value ? "********" : String(value ?? chalk.dim("(not set)"));
				console.log(`  ${k}: ${displayValue}`);
				if (s.description) {
					console.log(chalk.dim(`    ${s.description}`));
				}
				if (s.env) {
					console.log(chalk.dim(`    env: ${s.env}`));
				}
			}
			break;
		}

		case "get": {
			if (!key) {
				console.error(chalk.red("Key required"));
				process.exit(1);
			}

			const settings = await manager.getPluginSettings(pluginName);
			const schema = plugin.manifest.settings?.[key];
			const value = settings[key] ?? schema?.default;

			if (flags.json) {
				console.log(JSON.stringify({ [key]: value }));
			} else {
				const displayValue = schema?.secret && value ? "********" : String(value ?? "(not set)");
				console.log(displayValue);
			}
			break;
		}

		case "set": {
			if (!key) {
				console.error(chalk.red("Key required"));
				process.exit(1);
			}

			const valueStr = valueArgs.join(" ");
			const schema = plugin.manifest.settings?.[key];

			// Parse value according to type
			let value: unknown = valueStr;
			if (schema) {
				value = parseSettingValue(valueStr, schema);

				// Validate
				const validation = validateSetting(value, schema);
				if (!validation.valid) {
					console.error(chalk.red(validation.error!));
					process.exit(1);
				}
			}

			await manager.setPluginSetting(pluginName, key, value);
			console.log(chalk.green(`${theme.status.success} Set ${key}`));
			break;
		}

		case "delete": {
			if (!key) {
				console.error(chalk.red("Key required"));
				process.exit(1);
			}

			await manager.deletePluginSetting(pluginName, key);
			console.log(chalk.green(`${theme.status.success} Deleted ${key}`));
			break;
		}

		default:
			console.error(chalk.red(`Unknown config subcommand: ${subcommand}`));
			console.error(chalk.dim("Valid subcommands: list, get, set, delete, validate"));
			process.exit(1);
	}
}

async function handleConfigValidate(manager: PluginManager, flags: { json?: boolean }): Promise<void> {
	const plugins = await manager.list();
	const results: Array<{ plugin: string; key: string; error: string }> = [];

	for (const plugin of plugins) {
		const settings = await manager.getPluginSettings(plugin.name);
		const schema = plugin.manifest.settings || {};

		for (const [key, s] of Object.entries(schema)) {
			const value = settings[key];
			if (value !== undefined) {
				const validation = validateSetting(value, s);
				if (!validation.valid) {
					results.push({ plugin: plugin.name, key, error: validation.error! });
				}
			}
		}
	}

	if (flags.json) {
		console.log(JSON.stringify({ valid: results.length === 0, errors: results }, null, 2));
		return;
	}

	if (results.length === 0) {
		console.log(chalk.green(`${theme.status.success} All settings valid`));
	} else {
		for (const { plugin, key, error } of results) {
			console.log(chalk.red(`${theme.status.error} ${plugin}.${key}: ${error}`));
		}
		process.exit(1);
	}
}

async function handleEnable(
	manager: PluginManager,
	plugins: string[],
	flags: { json?: boolean; scope?: "user" | "project" },
): Promise<void> {
	return handleSetEnabled(manager, plugins, flags, true);
}

async function handleDisable(
	manager: PluginManager,
	plugins: string[],
	flags: { json?: boolean; scope?: "user" | "project" },
): Promise<void> {
	return handleSetEnabled(manager, plugins, flags, false);
}

async function handleSetEnabled(
	manager: PluginManager,
	plugins: string[],
	flags: { json?: boolean; scope?: "user" | "project" },
	enabled: boolean,
): Promise<void> {
	const action = enabled ? "enable" : "disable";
	const pastTense = enabled ? "Enabled" : "Disabled";
	const jsonKey = enabled ? "enabled" : "disabled";

	if (plugins.length === 0) {
		console.error(chalk.red(`Usage: ${APP_NAME} plugin ${action} <plugin> ...`));
		process.exit(1);
	}

	const mktMgr = await makeMarketplaceManager();
	const installedPlugins = new Set((await mktMgr.listInstalledPlugins()).map(p => p.id));

	for (const name of plugins) {
		if (installedPlugins.has(name)) {
			try {
				await mktMgr.setPluginEnabled(name, enabled, flags.scope);
				if (flags.json) {
					console.log(JSON.stringify({ [jsonKey]: name }));
				} else {
					console.log(chalk.green(`${theme.status.success} ${pastTense} ${name}`));
				}
			} catch (err) {
				console.error(chalk.red(`${theme.status.error} Failed to ${action} ${name}: ${err}`));
				process.exit(1);
			}
			continue;
		}

		try {
			await manager.setEnabled(name, enabled);
			if (flags.json) {
				console.log(JSON.stringify({ [jsonKey]: name }));
			} else {
				console.log(chalk.green(`${theme.status.success} ${pastTense} ${name}`));
			}
		} catch (err) {
			console.error(chalk.red(`${theme.status.error} Failed to ${action} ${name}: ${err}`));
			process.exit(1);
		}
	}
}

// =============================================================================
// Help
// =============================================================================

export function printPluginHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} plugin`)} - Plugin lifecycle management

${chalk.bold("Commands:")}
  install <pkg[@ver]>[features]  Install plugins from npm
  uninstall <pkg>                Remove plugins
  list                           Show installed plugins
  link <path>                    Link local plugin for development
  doctor                         Check plugin health
  features <pkg>                 View/modify enabled features
  config <cmd> <pkg> [key] [val] Manage plugin settings
  enable <pkg>                   Enable a disabled plugin
  disable <pkg>                  Disable plugin without uninstalling
  marketplace <cmd>            Manage marketplace sources (add, remove, update, list)
  discover [marketplace]        Browse available marketplace plugins

${chalk.bold("Feature Syntax:")}
  pkg                Install with default features
  pkg[feat1,feat2]   Install with specific features
  pkg[*]             Install with all features
  pkg[]              Install with no optional features

${chalk.bold("Config Subcommands:")}
  config list <pkg>              List all settings
  config get <pkg> <key>         Get a setting value
  config set <pkg> <key> <val>   Set a setting value
  config delete <pkg> <key>      Delete a setting
  config validate                Validate all plugin settings

${chalk.bold("Options:")}
  --json           Output as JSON
  --fix            Attempt automatic fixes (doctor)
  --force          Overwrite without prompting (install)
  --scope <scope>  Install scope: user (default) or project (install name@marketplace)
  --dry-run        Preview changes without applying (install, uninstall)
  -l, --local      Use project-local overrides

${chalk.bold("Examples:")}
  ${APP_NAME} plugin install @gajae-code/exa[search]
  ${APP_NAME} plugin list --json
  ${APP_NAME} plugin features my-plugin --enable search,web
  ${APP_NAME} plugin config set my-plugin apiKey sk-xxx
  ${APP_NAME} plugin doctor --fix
  ${APP_NAME} plugin install --scope project name@marketplace
`);
}
