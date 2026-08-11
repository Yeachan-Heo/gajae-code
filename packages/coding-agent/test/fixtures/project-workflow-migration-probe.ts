/**
 * Child-process probe for the project workflow-settings migration.
 *
 * Runs `Settings.loadForScope({ cwd })` in a temp project whose `.gjc/`
 * directory may contain a legacy `settings.json` (and possibly a `config.yml`),
 * then reports the post-load state so tests can assert the migration contract:
 * the workflow keys land in the project `.gjc/config.yml` (absent-only) while
 * the legacy source is preserved for its non-workflow settings.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getLogPath } from "@gajae-code/utils";
import { YAML } from "bun";
import { ensureWorkflowSettingsMigrated, Settings, SettingsMigrationTestHooks } from "../../src/config/settings";

const cwd = process.cwd();
// Test seam: when enabled, the post-publication marker RE-READ is made to
// fail (the readable marker file is replaced by a directory) after the
// migrated values already committed, so the rollback path is exercised.
if (process.env.SETTINGS_MIGRATION_TEST_MARKER_MERGE_DIR === "1") {
	SettingsMigrationTestHooks.beforeProjectMarkerMerge = async () => {
		const marker = path.join(cwd, ".gjc", "state", "settings.json.migrated-keys");
		await fs.rm(marker, { force: true });
		await fs.mkdir(marker, { recursive: true });
	};
}
let loaded: Settings | null = null;
let loadFailed = false;
const expectLoadFailure = process.argv.includes("--expect-load-failure");
if (process.argv.includes("--via-trigger")) {
	await ensureWorkflowSettingsMigrated(cwd);
} else if (expectLoadFailure) {
	// The caller explicitly expects the load to fail (e.g. an unreadable
	// ownership marker aborts the migration): suppress the exception and
	// report the migration file state.
	try {
		loaded = await Settings.loadForScope({ cwd });
	} catch {
		loadFailed = true;
	}
} else {
	// Unexpected load failures stay FATAL so a regression that throws after
	// producing the inspected filesystem state cannot mask itself in tests
	// that never assert loadFailed.
	loaded = await Settings.loadForScope({ cwd });
}

const projectDir = path.resolve(cwd, ".gjc");
const source = path.resolve(projectDir, "settings.json");
const target = path.resolve(projectDir, "config.yml");

const exists = async (targetPath: string): Promise<boolean> => {
	try {
		// Existence only (not readability): a mode-000 source is still "present".
		await fs.lstat(targetPath);
		return true;
	} catch {
		return false;
	}
};

let maxIterations: unknown = null;
let maxReviewPassesPerLane: unknown = null;
let gjcValueType: string | null = null;
let configYmlRootType: string | null = null;
const strictInvalidEvidencePath = path.resolve(projectDir, "state", "settings.json.strict-invalid");
let strictInvalidEvidenceKeys: string[] = [];
let strictInvalidEvidenceMalformed = false;
if (await exists(strictInvalidEvidencePath)) {
	try {
		const parsed = (await JSON.parse(await Bun.file(strictInvalidEvidencePath).text())) as {
			malformed?: unknown;
			keys?: unknown;
			key?: unknown;
		};
		if (parsed.malformed === true) strictInvalidEvidenceMalformed = true;
		if (Array.isArray(parsed.keys)) {
			strictInvalidEvidenceKeys = parsed.keys
				.map(entry => (entry && typeof entry === "object" ? (entry as { key?: unknown }).key : undefined))
				.filter((value): value is string => typeof value === "string");
		} else if (typeof parsed.key === "string") {
			strictInvalidEvidenceKeys = [parsed.key];
		}
	} catch {
		// Leave the report empty; the load itself must have survived.
	}
}
if (await exists(target)) {
	const parsed = YAML.parse(await Bun.file(target).text()) as unknown;
	const parsedRecord = parsed as Record<string, unknown> | null;
	if (parsed === null) configYmlRootType = "null";
	else if (Array.isArray(parsed)) configYmlRootType = "array";
	else configYmlRootType = typeof parsed;
	if (parsedRecord && typeof parsedRecord === "object" && Object.hasOwn(parsedRecord, "gjc")) {
		gjcValueType = Array.isArray(parsedRecord.gjc)
			? "array"
			: parsedRecord.gjc === null
				? "null"
				: typeof parsedRecord.gjc;
	}
	const ralplan = (parsedRecord?.gjc as Record<string, unknown> | undefined)?.ralplan as
		| Record<string, unknown>
		| undefined;
	maxIterations = ralplan?.maxIterations ?? null;
	maxReviewPassesPerLane = ralplan?.maxReviewPassesPerLane ?? null;
}

process.stdout.write(
	`${JSON.stringify({
		loadFailed,
		sourceExists: await exists(source),
		maxIterations,
		maxReviewPassesPerLane,
		gjcValueType,
		configYmlRootType,
		strictInvalidEvidenceExists: await exists(strictInvalidEvidencePath),
		strictInvalidEvidenceKeys,
		strictInvalidEvidenceMalformed,
		// The generic settings API must not resurrect retired workflow keys from
		// the retained settings.json after a config.yml removal.
		settingsGetMaxIterations: loaded?.get("gjc.ralplan.maxIterations") ?? null,
		migrationLog: await readMigrationLog(),
	})}
`,
);

/**
 * The logger writes to a file (never stderr, which would corrupt the TUI), so
 * tests that assert migration warnings opt in via GJC_PROBE_LOG and read the
 * isolated log (HOME is pointed at a temp dir by the runner). Polls briefly:
 * winston's async transport may not have flushed the write the instant the
 * migration returns.
 */
async function readMigrationLog(): Promise<string> {
	if (process.env.GJC_PROBE_LOG !== "1") return "";
	// winston's DailyRotateFile names files by LOCAL date while getLogPath()
	// uses the UTC date, so scan every gjc.*.log in the logs dir instead of
	// guessing the file name.
	const logsDir = path.dirname(getLogPath());
	for (let attempt = 0; attempt < 20; attempt++) {
		try {
			const files = (await fs.readdir(logsDir)).filter(name => name.startsWith("gjc.") && name.endsWith(".log"));
			let text = "";
			for (const file of files) {
				text += await Bun.file(path.join(logsDir, file)).text();
			}
			if (text.length > 0) return text;
		} catch {
			// Log dir not created yet; keep polling.
		}
		await Bun.sleep(50);
	}
	return "";
}
