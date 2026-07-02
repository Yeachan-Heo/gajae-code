/**
 * Update CLI command handler.
 *
 * Handles `gjc update` to check for and install updates.
 * Uses bun if available, otherwise downloads binary from GitHub releases.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { $which, APP_NAME, isEnoent, VERSION } from "@gajae-code/utils";
import { $ } from "bun";
import chalk from "chalk";
import { installDefaultGjcDefinitions } from "../defaults/gjc-defaults";
import { theme } from "../modes/theme/theme";

const RELEASE_REPO = "Yeachan-Heo/gajae-code";
const PACKAGE = "@gajae-code/coding-agent";
const NPM_WRAPPER_PACKAGE = "gajae-code";
const NPM_MANAGED_PACKAGES = [NPM_WRAPPER_PACKAGE, PACKAGE] as const;

interface ReleaseInfo {
	tag: string;
	version: string;
}

/** Result from running the installed binary and parsing its reported version. */
export interface InstalledVersionVerification {
	ok: boolean;
	actual?: string;
	path?: string;
	smokeTestFailed?: boolean;
	smokeTestOutput?: string;
	cleanupWarning?: string;
}

export interface PackageManagerUpdateResult {
	exitCode: number | null;
	text: () => string;
}

export type PackageManagerUpdateRunner = (expectedVersion: string) => Promise<PackageManagerUpdateResult>;

export interface PackageManagerUpdateOptions {
	managerName: string;
	expectedVersion: string;
	runInstall: PackageManagerUpdateRunner;
	verifyInstalledRuntime: (expectedVersion: string) => Promise<InstalledVersionVerification>;
	printVerificationResult?: (expectedVersion: string) => Promise<void>;
	printRecoveredVerification?: (expectedVersion: string) => void;
}

/** Paths and verifier used while replacing a downloaded binary update. */
export interface BinaryReplacementOptions {
	targetPath: string;
	tempPath: string;
	backupPath: string;
	expectedVersion: string;
	verifyInstalledVersion: (expectedVersion: string) => Promise<InstalledVersionVerification>;
}

/**
 * Parse update subcommand arguments.
 * Returns undefined if not an update command.
 */
export function parseUpdateArgs(args: string[]): { force: boolean; check: boolean } | undefined {
	if (args.length === 0 || args[0] !== "update") {
		return undefined;
	}

	return {
		force: args.includes("--force") || args.includes("-f"),
		check: args.includes("--check") || args.includes("-c"),
	};
}

async function getBunGlobalBinDir(): Promise<string | undefined> {
	if (!$which("bun")) return undefined;
	try {
		const result = await $`bun pm bin -g`.quiet().nothrow();
		if (result.exitCode !== 0) return undefined;
		const output = result.text().trim();
		return output.length > 0 ? output : undefined;
	} catch {
		return undefined;
	}
}

function normalizePathForComparison(filePath: string): string {
	const normalized = path.normalize(filePath);
	if (process.platform === "win32") return normalized.toLowerCase();
	return normalized;
}

function tryRealpath(p: string): string | undefined {
	try {
		return fs.realpathSync.native(p);
	} catch {
		return undefined;
	}
}

function isPathInDirectoryLexical(filePath: string, directoryPath: string): boolean {
	const normalizedPath = normalizePathForComparison(path.resolve(filePath));
	const normalizedDirectory = normalizePathForComparison(path.resolve(directoryPath));
	const relativePath = path.relative(normalizedDirectory, normalizedPath);
	return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function isPathInDirectory(filePath: string, directoryPath: string): boolean {
	if (isPathInDirectoryLexical(filePath, directoryPath)) return true;
	// Layer realpath resolution on top of the lexical guard. On Windows, ~/.bun
	// is a junction when Bun is installed via Scoop, so `bun pm bin -g` and the
	// PATH-resolved gjc path can refer to the same directory through different
	// strings. path.resolve does not traverse junctions/symlinks; realpath does.
	// Resolve the file's parent directory to tolerate the file itself not yet
	// existing (e.g. a fresh install path) while still catching link-traversed
	// equality once the directory exists.
	const fileDir = tryRealpath(path.dirname(path.resolve(filePath)));
	const dirReal = tryRealpath(path.resolve(directoryPath));
	if (!fileDir || !dirReal) return false;
	const resolvedFile = path.join(fileDir, path.basename(filePath));
	return isPathInDirectoryLexical(resolvedFile, dirReal);
}

type PackageManagerTarget = { manager: "npm"; packageName: string };
type UpdateTarget = { method: "bun" } | { method: "npm"; packageName: string } | { method: "binary"; path: string };

type PathPlatform = NodeJS.Platform;
type PackageExists = (packageName: string, packageRoot: string) => boolean;

function pathApiForPlatform(platform: PathPlatform): typeof path.posix | typeof path.win32 {
	return platform === "win32" ? path.win32 : path.posix;
}

function defaultPackageExists(_packageName: string, packageRoot: string): boolean {
	return fs.existsSync(path.join(packageRoot, "package.json"));
}

function npmPackageRootForBinPath(binPath: string, packageName: string, platform: PathPlatform): string {
	const pathApi = pathApiForPlatform(platform);
	const segments = packageName.split("/");
	return pathApi.join(pathApi.dirname(binPath), "node_modules", ...segments);
}

function resolveNpmManagedTarget(
	ompPath: string,
	platform: PathPlatform = process.platform,
	packageExists: PackageExists = defaultPackageExists,
): PackageManagerTarget | undefined {
	if (platform !== "win32") return undefined;
	const pathApi = pathApiForPlatform(platform);
	const extension = pathApi.extname(ompPath).toLowerCase();
	if (extension !== ".cmd" && extension !== ".ps1") return undefined;
	const basename = pathApi.basename(ompPath, extension).toLowerCase();
	if (basename !== APP_NAME.toLowerCase()) return undefined;

	for (const packageName of NPM_MANAGED_PACKAGES) {
		const packageRoot = npmPackageRootForBinPath(ompPath, packageName, platform);
		if (packageExists(packageName, packageRoot)) return { manager: "npm", packageName };
	}
	return undefined;
}

function resolveUpdateMethod(ompPath: string, bunBinDir: string | undefined): "bun" | "npm" | "binary" {
	if (resolveNpmManagedTarget(ompPath)) return "npm";
	if (!bunBinDir) return "binary";
	return isPathInDirectory(ompPath, bunBinDir) ? "bun" : "binary";
}

export function resolveUpdateMethodForTest(ompPath: string, bunBinDir: string | undefined): "bun" | "npm" | "binary" {
	return resolveUpdateMethod(ompPath, bunBinDir);
}

export function resolveNpmManagedTargetForTest(
	ompPath: string,
	platform: PathPlatform,
	packageExists: PackageExists,
): PackageManagerTarget | undefined {
	return resolveNpmManagedTarget(ompPath, platform, packageExists);
}
async function resolveUpdateTarget(): Promise<UpdateTarget> {
	const bunBinDir = await getBunGlobalBinDir();
	const ompPath = resolveGjcPath();

	if (ompPath) {
		const npmTarget = resolveNpmManagedTarget(ompPath);
		if (npmTarget) return { method: "npm", packageName: npmTarget.packageName };
		const method = resolveUpdateMethod(ompPath, bunBinDir);
		if (method === "bun") return { method };
		if (method === "npm") {
			throw new Error(
				formatUnsupportedTargetMessage(`Could not resolve npm package root for ${APP_NAME} shim ${ompPath}`),
			);
		}
		return { method, path: ompPath };
	}

	if (bunBinDir) return { method: "bun" };

	throw new Error(formatUnsupportedTargetMessage(`Could not resolve ${APP_NAME} binary path in PATH`));
}

/**
 * Get the latest release info from the npm registry.
 * Uses npm instead of GitHub API to avoid unauthenticated rate limiting.
 */
async function getLatestRelease(): Promise<ReleaseInfo> {
	const response = await fetch(`https://registry.npmjs.org/${PACKAGE}/latest`);
	if (!response.ok) {
		throw new Error(`Failed to fetch release info: ${response.statusText}`);
	}

	const data = (await response.json()) as { version: string };
	const version = data.version;
	const tag = `v${version}`;

	return {
		tag,
		version,
	};
}

/**
 * Compare semver versions. Returns:
 * - negative if a < b
 * - 0 if a == b
 * - positive if a > b
 */
function compareVersions(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);

	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const na = pa[i] || 0;
		const nb = pb[i] || 0;
		if (na !== nb) return na - nb;
	}
	return 0;
}

/**
 * Get the appropriate binary name for this platform.
 */
function getBinaryName(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
	let os: string;
	switch (platform) {
		case "linux":
			os = "linux";
			break;
		case "darwin":
			os = "darwin";
			break;
		case "win32":
			os = "windows";
			break;
		default:
			throw new Error(formatUnsupportedTargetMessage(`Unsupported platform: ${platform}`));
	}

	let archName: string;
	switch (arch) {
		case "x64":
			archName = "x64";
			break;
		case "arm64":
			archName = "arm64";
			break;
		default:
			throw new Error(formatUnsupportedTargetMessage(`Unsupported architecture: ${arch}`));
	}

	if (os === "windows") {
		return `${APP_NAME}-${os}-${archName}.exe`;
	}
	return `${APP_NAME}-${os}-${archName}`;
}

/**
 * Resolve the path that `gjc` maps to in the user's PATH.
 */
function resolveGjcPath(): string | undefined {
	return $which(APP_NAME) ?? undefined;
}

/**
 * Run the resolved gjc binary and check if it reports the expected version.
 */
async function verifyInstalledVersion(expectedVersion: string): Promise<InstalledVersionVerification> {
	const ompPath = resolveGjcPath();
	if (!ompPath) return { ok: false };
	try {
		const result = await $`${ompPath} --version`.quiet().nothrow();
		if (result.exitCode !== 0) return { ok: false, path: ompPath };
		const output = result.text().trim();
		// Output format: "gjc/X.Y.Z"
		const match = output.match(/\/(\d+\.\d+\.\d+)/);
		const actual = match?.[1];
		return { ok: actual === expectedVersion, actual, path: ompPath };
	} catch {
		return { ok: false, path: ompPath };
	}
}

async function verifyInstalledRuntime(expectedVersion: string): Promise<InstalledVersionVerification> {
	const versionResult = await verifyInstalledVersion(expectedVersion);
	if (!versionResult.ok || !versionResult.path) {
		return versionResult;
	}
	try {
		const smokeResult = await $`${versionResult.path} --smoke-test`.quiet().nothrow();
		if (smokeResult.exitCode === 0) {
			return versionResult;
		}
		return {
			...versionResult,
			ok: false,
			smokeTestFailed: true,
			smokeTestOutput: smokeResult.text().trim(),
		};
	} catch (error) {
		return {
			...versionResult,
			ok: false,
			smokeTestFailed: true,
			smokeTestOutput: error instanceof Error ? error.message : String(error),
		};
	}
}

function printRestartGuidance(): void {
	console.log(chalk.dim(`Restart ${APP_NAME} to use the new version`));
}

function printVerifiedVersion(expectedVersion: string): void {
	console.log(chalk.green(`\n${theme.status.success} Updated to ${expectedVersion}`));
}

function printSuccessfulVerification(expectedVersion: string): void {
	printVerifiedVersion(expectedVersion);
	printRestartGuidance();
}

function formatBinaryInstallInstruction(platform: NodeJS.Platform = process.platform): string {
	if (platform === "win32") {
		return `For a supported binary install, reinstall with PowerShell: irm https://raw.githubusercontent.com/${RELEASE_REPO}/main/scripts/install.ps1 | iex`;
	}
	return `For a supported binary install, reinstall with: curl -fsSL https://raw.githubusercontent.com/${RELEASE_REPO}/main/scripts/install.sh | sh -s -- --binary`;
}

function formatManualUpdateInstructions(platform: NodeJS.Platform = process.platform): string {
	return [
		`If ${APP_NAME} was installed with Bun, run: bun install -g ${PACKAGE}@latest`,
		`If ${APP_NAME} was installed with npm, pnpm, or another package manager, update it with that same manager.`,
		formatBinaryInstallInstruction(platform),
	].join("\n");
}

function formatUnsupportedTargetMessage(reason: string, platform: NodeJS.Platform = process.platform): string {
	return `${reason}.\n${formatManualUpdateInstructions(platform)}`;
}

function buildReleaseBinaryUrl(
	version: string,
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
): string {
	const binaryName = getBinaryName(platform, arch);
	const tag = `v${version}`;
	return `https://github.com/${RELEASE_REPO}/releases/download/${tag}/${binaryName}`;
}

function formatBinaryDownloadFailureMessage(
	binaryName: string,
	url: string,
	status: string | number,
	platform: NodeJS.Platform = process.platform,
): string {
	return `Download failed for ${binaryName} from ${url}: ${status}.\n${formatManualUpdateInstructions(platform)}`;
}

export function formatBinaryDownloadFailureMessageForTest(
	binaryName: string,
	url: string,
	status: string | number,
	platform: NodeJS.Platform = process.platform,
): string {
	return formatBinaryDownloadFailureMessage(binaryName, url, status, platform);
}

export function buildReleaseBinaryUrlForTest(
	version: string,
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
): string {
	return buildReleaseBinaryUrl(version, platform, arch);
}

export function formatManualUpdateInstructionsForTest(platform: NodeJS.Platform = process.platform): string {
	return formatManualUpdateInstructions(platform);
}

function normalizeVerificationOutput(output: string | undefined): string {
	return output?.replace(/\s+/g, " ").trim() ?? "";
}

function formatVerificationFailure(result: InstalledVersionVerification, expectedVersion: string): string {
	if (result.smokeTestFailed) {
		const output = normalizeVerificationOutput(result.smokeTestOutput);
		const outputSuffix = output ? `: ${output}` : "";
		const pathSuffix = result.path ? ` at ${result.path}` : "";
		return `${APP_NAME}${pathSuffix} reports ${result.actual ?? expectedVersion}, but --smoke-test failed${outputSuffix}. Close running ${APP_NAME} sessions and reinstall to repair a stale or partial update.`;
	}
	if (result.actual) {
		return `${APP_NAME} at ${result.path} still reports ${result.actual} (expected ${expectedVersion})`;
	}
	return `could not verify updated version${result.path ? ` at ${result.path}` : ""}`;
}

export function formatVerificationFailureForTest(
	result: InstalledVersionVerification,
	expectedVersion: string,
): string {
	return formatVerificationFailure(result, expectedVersion);
}

/**
 * Print post-update verification result.
 */
async function printVerification(expectedVersion: string): Promise<void> {
	const result = await verifyInstalledRuntime(expectedVersion);
	if (result.ok) {
		printSuccessfulVerification(expectedVersion);
		return;
	}
	console.log(chalk.yellow(`\nWarning: ${formatVerificationFailure(result, expectedVersion)}`));
	console.log(chalk.yellow(formatManualUpdateInstructions()));
}

async function unlinkIfExists(filePath: string): Promise<void> {
	try {
		await fs.promises.unlink(filePath);
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}
}

function formatBackupCleanupWarning(backupPath: string, err: unknown): string {
	return `Installed update, but could not remove backup file ${backupPath}: ${err}. You can delete it manually after closing shells or antivirus processes that may still hold it.`;
}

async function cleanupVerifiedBackup(backupPath: string): Promise<string | undefined> {
	try {
		await unlinkIfExists(backupPath);
		return undefined;
	} catch (err) {
		return formatBackupCleanupWarning(backupPath, err);
	}
}

/**
 * Atomically replace the installed binary and roll back if version verification fails.
 */
export async function replaceBinaryForUpdate(options: BinaryReplacementOptions): Promise<InstalledVersionVerification> {
	let backupReady = false;
	try {
		await unlinkIfExists(options.backupPath);
		await fs.promises.rename(options.targetPath, options.backupPath);
		backupReady = true;
		await fs.promises.rename(options.tempPath, options.targetPath);

		const verification = await options.verifyInstalledVersion(options.expectedVersion);
		if (!verification.ok) {
			throw new Error(
				`${formatVerificationFailure(verification, options.expectedVersion)}; restored previous ${APP_NAME} binary`,
			);
		}

		backupReady = false;
		const cleanupWarning = await cleanupVerifiedBackup(options.backupPath);
		return cleanupWarning ? { ...verification, cleanupWarning } : verification;
	} catch (err) {
		if (backupReady) {
			await unlinkIfExists(options.targetPath);
			await fs.promises.rename(options.backupPath, options.targetPath);
		}
		await unlinkIfExists(options.tempPath);
		throw err;
	}
}

function formatPackageManagerInstallFailure(
	managerName: string,
	result: PackageManagerUpdateResult,
	verification: InstalledVersionVerification,
	expectedVersion: string,
): string {
	const output = normalizeVerificationOutput(result.text());
	const outputSuffix = output ? `: ${output}` : "";
	return `${managerName} install failed with exit code ${result.exitCode ?? "unknown"}${outputSuffix}. ${formatVerificationFailure(verification, expectedVersion)}`;
}

export async function runPackageManagerUpdateForTest(
	options: PackageManagerUpdateOptions,
): Promise<InstalledVersionVerification> {
	return updateViaPackageManager(options);
}

async function updateViaPackageManager(options: PackageManagerUpdateOptions): Promise<InstalledVersionVerification> {
	const result = await options.runInstall(options.expectedVersion);
	if (result.exitCode === 0) {
		await (options.printVerificationResult ?? printVerification)(options.expectedVersion);
		return await options.verifyInstalledRuntime(options.expectedVersion);
	}

	const verification = await options.verifyInstalledRuntime(options.expectedVersion);
	if (verification.ok) {
		console.warn(
			chalk.yellow(
				`${options.managerName} exited with ${result.exitCode ?? "unknown"}, but ${APP_NAME} now verifies as ${options.expectedVersion}. Treating the update as installed.`,
			),
		);
		(options.printRecoveredVerification ?? printSuccessfulVerification)(options.expectedVersion);
		return verification;
	}

	throw new Error(
		formatPackageManagerInstallFailure(options.managerName, result, verification, options.expectedVersion),
	);
}

/**
 * Update via bun package manager.
 */
async function updateViaBun(expectedVersion: string): Promise<void> {
	console.log(chalk.dim("Updating via bun..."));
	await updateViaPackageManager({
		managerName: "bun",
		expectedVersion,
		runInstall: async version => await $`bun install -g ${PACKAGE}@${version}`.nothrow(),
		verifyInstalledRuntime,
	});
}

async function updateViaNpm(packageName: string, expectedVersion: string): Promise<void> {
	console.log(chalk.dim(`Updating npm-managed install via npm (${packageName})...`));
	await updateViaPackageManager({
		managerName: "npm",
		expectedVersion,
		runInstall: async version => await $`npm install -g ${packageName}@${version}`.nothrow(),
		verifyInstalledRuntime,
	});
}

/**
 * Download a release binary to a target path, replacing an existing file.
 */
async function updateViaBinaryAt(targetPath: string, expectedVersion: string): Promise<void> {
	const binaryName = getBinaryName();
	const url = buildReleaseBinaryUrl(expectedVersion);

	const tempPath = `${targetPath}.new`;
	const backupPath = `${targetPath}.bak`;
	console.log(chalk.dim(`Downloading ${binaryName}…`));

	const response = await fetch(url, { redirect: "follow" });
	if (!response.ok || !response.body) {
		throw new Error(formatBinaryDownloadFailureMessage(binaryName, url, response.statusText || response.status));
	}
	const fileStream = fs.createWriteStream(tempPath, { mode: 0o755 });
	await pipeline(response.body, fileStream);

	console.log(chalk.dim("Installing update..."));
	const verification = await replaceBinaryForUpdate({
		targetPath,
		tempPath,
		backupPath,
		expectedVersion,
		verifyInstalledVersion: verifyInstalledRuntime,
	});
	printVerifiedVersion(expectedVersion);
	if (verification.cleanupWarning) console.warn(chalk.yellow(verification.cleanupWarning));
	printRestartGuidance();
}

/**
 * Run the update command.
 */
export async function runUpdateCommand(opts: { force: boolean; check: boolean }): Promise<void> {
	console.log(chalk.dim(`Current version: ${VERSION}`));

	// Check for updates
	let release: ReleaseInfo;
	try {
		release = await getLatestRelease();
	} catch (err) {
		console.error(chalk.red(`Failed to check for updates: ${err}`));
		process.exit(1);
	}

	const comparison = compareVersions(release.version, VERSION);

	if (comparison <= 0 && !opts.force) {
		console.log(chalk.green(`${theme.status.success} Already up to date`));
		return;
	}

	if (comparison > 0) {
		console.log(chalk.cyan(`New version available: ${release.version}`));
	} else {
		console.log(chalk.yellow(`Forcing reinstall of ${release.version}`));
	}

	if (opts.check) {
		// Just check, don't install
		return;
	}

	// Choose update method based on the prioritized gjc binary in PATH
	try {
		const target = await resolveUpdateTarget();
		if (target.method === "bun") {
			await updateViaBun(release.version);
		} else if (target.method === "npm") {
			await updateViaNpm(target.packageName, release.version);
		} else {
			await updateViaBinaryAt(target.path, release.version);
		}
	} catch (err) {
		console.error(chalk.red(`Update failed: ${err}`));
		process.exit(1);
	}

	await refreshInstalledDefaultSkills();
}

/**
 * Refresh opted-in on-disk default workflow skill copies after a successful
 * update. The four default skills ship embedded in the binary, so most users
 * need nothing here. But users who ran `gjc setup defaults` have on-disk copies
 * under the agent dir that shadow the embedded defaults; those would otherwise
 * go stale after an update. Only rewrite files that already exist and differ —
 * never materialize new copies for users who never opted in.
 */
async function refreshInstalledDefaultSkills(): Promise<void> {
	try {
		const result = await installDefaultGjcDefinitions({ refreshOnly: true });
		if (result.written > 0) {
			console.log(
				chalk.dim(`Refreshed ${result.written} local default workflow skill file(s) at ${result.targetRoot}`),
			);
		}
	} catch (err) {
		console.error(chalk.yellow(`Warning: failed to refresh local default workflow skills: ${err}`));
	}
}

/**
 * Print update command help.
 */
export function printUpdateHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} update`)} - Check for and install updates

${chalk.bold("Usage:")}
  ${APP_NAME} update [options]

${chalk.bold("Options:")}
  -c, --check   Check for updates without installing
  -f, --force   Force reinstall even if up to date

${chalk.bold("Examples:")}
  ${APP_NAME} update           Update to latest version
  ${APP_NAME} update --check   Check if updates are available
  ${APP_NAME} update --force   Force reinstall
`);
}
