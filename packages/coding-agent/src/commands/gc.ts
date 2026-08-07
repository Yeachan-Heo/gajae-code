import { Command, Flags } from "@gajae-code/utils/cli";
import { isSettingsInitialized, settings } from "../config/settings";
import { type GcDiskPolicy, runGjcGcCommand } from "../gjc-runtime/gc-runtime";

/**
 * Resolve the `gc.*` retention knobs from settings. When settings are not
 * initialized (headless/early invocation) the runtime falls back to its
 * schema-backed defaults, so this returns nothing rather than guessing.
 */
function resolveDiskPolicyFromSettings(): Partial<GcDiskPolicy> | undefined {
	if (!isSettingsInitialized()) return undefined;
	return {
		sessions_max_age_days: settings.get("gc.sessions.maxAgeDays"),
		sessions_max_total_bytes: settings.get("gc.sessions.maxTotalBytes"),
		natives_keep_versions: settings.get("gc.natives.keepVersions"),
		backups_max_age_days: settings.get("gc.backups.maxAgeDays"),
	};
}

export default class Gc extends Command {
	static description = "Garbage-collect stale GJC session/PID records (dry-run by default)";
	static strict = false;
	static flags = {
		json: Flags.boolean({ char: "j", description: "Emit machine-readable JSON", default: false }),
		prune: Flags.boolean({ description: "Remove stale records (default: report only)", default: false }),
		force: Flags.boolean({ description: "Alias for --prune (eligible records only)", default: false }),
		"dry-run": Flags.boolean({ description: "Force report-only mode", default: false }),
		disk: Flags.boolean({
			description: "Also report on-disk retention (sessions, blobs, natives, backups)",
			default: false,
		}),
		"repair-session-index": Flags.boolean({
			description: "Quarantine a corrupt session-index suffix and retain its valid prefix",
			default: false,
		}),
	};

	static examples = [
		"gjc gc",
		"gjc gc --json",
		"gjc gc --prune",
		"gjc gc --prune --json",
		"gjc gc --disk",
		"gjc gc --disk --json",
		"gjc gc --disk --prune",
		"gjc gc --repair-session-index --json",
	];

	async run(): Promise<void> {
		const result = await runGjcGcCommand(
			this.argv,
			process.cwd(),
			process.env,
			undefined,
			resolveDiskPolicyFromSettings(),
		);
		if (result.stdout) process.stdout.write(result.stdout);
		if (result.stderr) process.stderr.write(result.stderr);
		process.exitCode = result.status;
	}
}
