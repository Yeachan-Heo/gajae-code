/**
 * Update CLI command handler.
 *
 * Handles `gjc update` to check for and install standalone GitHub release
 * binaries. Package-manager installs are migrated to a user binary path
 * rather than overwritten. Source checkouts and dev-links are never replaced.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { $which, APP_NAME, isCompiledBinary, isEnoent, logger, redactCrashSecrets, VERSION } from "@gajae-code/utils";
import { $ } from "bun";
import chalk from "chalk";
import { Settings } from "../config/settings";
import { isUpdateChannel, UPDATE_CHANNELS, type UpdateChannel } from "../config/update-channel";
import { installDefaultGjcDefinitions } from "../defaults/gjc-defaults";
import { theme } from "../modes/theme/theme";
import { getNotificationConfig, type NotificationProvider, resolveNotificationProvider } from "../sdk/bus/config";
import type { TelemetryDetails, TelemetryEventName } from "../telemetry";
import { recordTelemetryEvent } from "../telemetry";
import { runDaemonCommand } from "./daemon-cli";
import {
	fetchGithubChannelRelease,
	GITHUB_RELEASE_DOWNLOAD_ORIGIN,
	type GithubReleaseLookupOptions,
	isSafeReleaseTag,
	RELEASE_REPO,
	verifyDownloadedBinaryChecksum,
	versionFromTag,
} from "./github-release";
import { offerMacosCommunityApp } from "./macos-community-app";
import { runNotifyCommand } from "./notify-cli";

const PACKAGE = "@gajae-code/coding-agent";
const NPM_WRAPPER_PACKAGE = "gajae-code";
const NPM_MANAGED_PACKAGES = [NPM_WRAPPER_PACKAGE, PACKAGE] as const;

export interface UpdateCommandOptions {
	force: boolean;
	check: boolean;
	channel?: UpdateChannel;
}

interface ReleaseInfo {
	tag: string;
	version: string;
	/** Registry the version came from. Release binaries still come from GitHub. */
	registry: string;
	/** Config problems that did not stop the lookup but changed its outcome. */
	warnings: string[];
}

/** Result from running the installed binary and parsing its reported version. */
export interface InstalledVersionVerification {
	ok: boolean;
	actual?: string;
	path?: string;
	versionOutput?: string;
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
export function parseUpdateArgs(args: string[]): UpdateCommandOptions | undefined {
	if (args.length === 0 || args[0] !== "update") {
		return undefined;
	}

	let channel: UpdateChannel | undefined;
	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--channel" && i + 1 >= args.length) {
			throw new Error(`Missing value for --channel. Expected one of: ${UPDATE_CHANNELS.join(", ")}.`);
		}
		const value =
			arg === "--channel" ? args[++i] : arg.startsWith("--channel=") ? arg.slice("--channel=".length) : undefined;
		if (value === undefined) continue;
		if (!isUpdateChannel(value)) {
			throw new Error(`Invalid --channel "${value}". Expected one of: ${UPDATE_CHANNELS.join(", ")}.`);
		}
		channel = value;
	}

	return {
		force: args.includes("--force") || args.includes("-f"),
		check: args.includes("--check") || args.includes("-c"),
		...(channel ? { channel } : {}),
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

export type PackageManagerTarget = { manager: "npm"; packageName: string };
type MigrationUpdateTarget = { method: "migrate"; path: string; previousPath?: string };
export type UpdateTarget =
	| { method: "bun" }
	| { method: "npm"; packageName: string }
	| { method: "binary"; path: string }
	| MigrationUpdateTarget;

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
function readPackageName(packageJsonPath: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
		if (typeof parsed !== "object" || parsed === null || !("name" in parsed)) return undefined;
		const name = (parsed as { name?: unknown }).name;
		return typeof name === "string" ? name : undefined;
	} catch {
		return undefined;
	}
}

function findGajaeCodeRepoRoot(startDir: string): string | undefined {
	let current = path.resolve(startDir);
	while (true) {
		if (
			fs.existsSync(path.join(current, ".git")) &&
			readPackageName(path.join(current, "package.json")) === "gajae-code"
		) {
			return current;
		}
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function isProtectedSourcePath(filePath: string): boolean {
	const real = tryRealpath(filePath) ?? path.resolve(filePath);
	return findGajaeCodeRepoRoot(path.dirname(real)) !== undefined;
}

function fileStartsWithShebang(filePath: string): boolean {
	try {
		const fd = fs.openSync(filePath, "r");
		try {
			const buf = Buffer.alloc(2);
			const read = fs.readSync(fd, buf, 0, 2, 0);
			return read >= 2 && buf[0] === 0x23 && buf[1] === 0x21;
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return false;
	}
}

function isShimPath(filePath: string, bunBinDir: string | undefined): boolean {
	const extension = path.extname(filePath).toLowerCase();
	if (extension === ".cmd" || extension === ".ps1" || extension === ".bat" || extension === ".sh") return true;
	if (resolveNpmManagedTarget(filePath)) return true;
	if (bunBinDir && isPathInDirectory(filePath, bunBinDir)) return true;
	return fileStartsWithShebang(filePath);
}

export function defaultUserBinaryPath(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const pathApi = pathApiForPlatform(platform);
	if (env.GJC_INSTALL_DIR && env.GJC_INSTALL_DIR.length > 0) {
		return pathApi.join(env.GJC_INSTALL_DIR, platform === "win32" ? "gjc.exe" : "gjc");
	}
	if (platform === "win32") {
		const base = env.LOCALAPPDATA || pathApi.join(env.USERPROFILE || os.homedir(), "AppData", "Local");
		return pathApi.join(base, "gjc", "gjc.exe");
	}
	return pathApi.join(env.HOME || os.homedir(), ".local", "bin", "gjc");
}

export function isProtectedSourcePathForTest(filePath: string): boolean {
	return isProtectedSourcePath(filePath);
}

export function defaultUserBinaryPathForTest(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): string {
	return defaultUserBinaryPath(platform, env);
}

async function resolveUpdateTarget(): Promise<UpdateTarget> {
	const bunBinDir = await getBunGlobalBinDir();
	const ompPath = resolveGjcPath();
	const userPath = defaultUserBinaryPath();

	if (ompPath && isProtectedSourcePath(ompPath)) {
		throw new Error(
			formatUnsupportedTargetMessage(
				`Refusing to overwrite source checkout or dev-link at ${ompPath}. Update that checkout's original workflow instead`,
			),
		);
	}

	if (ompPath && isShimPath(ompPath, bunBinDir)) {
		if (isProtectedSourcePath(userPath)) {
			throw new Error(formatUnsupportedTargetMessage(`Refusing to install over a source checkout at ${userPath}`));
		}
		if (path.resolve(userPath) === path.resolve(ompPath)) {
			throw new Error(
				formatUnsupportedTargetMessage(
					`Current install at ${ompPath} is a package-manager shim in the default binary directory. Set GJC_INSTALL_DIR to a different directory, or remove the shim and reinstall with the binary installer`,
				),
			);
		}
		return { method: "migrate", path: userPath, previousPath: ompPath };
	}

	if (ompPath) {
		return { method: "binary", path: ompPath };
	}

	if (isProtectedSourcePath(userPath)) {
		throw new Error(formatUnsupportedTargetMessage(`Refusing to install over a source checkout at ${userPath}`));
	}
	return { method: "migrate", path: userPath };
}

/** Lookup options for the GitHub release check. */
export interface LatestReleaseLookupOptions extends GithubReleaseLookupOptions {
	channel?: UpdateChannel;
}

/**
 * Get the latest release info for a channel from GitHub releases.
 * Stable uses `/releases/latest`. Nightly uses the newest published prerelease.
 */
async function getLatestRelease(options?: LatestReleaseLookupOptions): Promise<ReleaseInfo> {
	const channel = options?.channel ?? "stable";
	const release = await fetchGithubChannelRelease({ ...options, channel, useAmbientToken: true });
	if (!isSafeReleaseTag(release.tag)) {
		throw new Error(`Refusing unsafe GitHub release tag: ${release.tag}`);
	}
	return {
		tag: release.tag,
		version: release.version || versionFromTag(release.tag),
		registry: `https://github.com/${RELEASE_REPO}`,
		warnings: release.warnings,
	};
}

export function getLatestReleaseForTest(options: LatestReleaseLookupOptions): Promise<ReleaseInfo> {
	return getLatestRelease(options);
}

/**
 * Compare semver versions (including nightly prereleases). Returns:
 * - negative if a < b
 * - 0 if a == b
 * - positive if a > b
 */
function compareVersions(a: string, b: string): number {
	return Bun.semver.order(a, b);
}

export function compareVersionsForTest(a: string, b: string): number {
	return compareVersions(a, b);
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
		if (archName !== "x64") {
			throw new Error(formatUnsupportedTargetMessage(`Unsupported architecture: ${arch}`));
		}
		return `${APP_NAME}-${os}-${archName}.exe`;
	}
	return `${APP_NAME}-${os}-${archName}`;
}

/**
 * Resolve the running GJC image. Compiled binaries update themselves via
 * execPath (realpath when available), not whichever `gjc` is first on PATH.
 */
function resolveRunningImagePath(execPath: string): string {
	try {
		return fs.realpathSync(execPath);
	} catch {
		return path.resolve(execPath);
	}
}

function resolveGjcPath(): string | undefined {
	if (isCompiledBinary()) return resolveRunningImagePath(process.execPath);
	return $which(APP_NAME) ?? undefined;
}

export function resolveGjcPathForTest(options: {
	compiled: boolean;
	execPath: string;
	whichPath: string | undefined;
}): string | undefined {
	if (options.compiled) return resolveRunningImagePath(options.execPath);
	return options.whichPath;
}

/**
 * Parse the version reported by `gjc --version` ("gjc/X.Y.Z" or a nightly prerelease variant).
 */
function parseReportedVersion(output: string): string | undefined {
	// Output format: "gjc/X.Y.Z" (stable) or "gjc/X.Y.Z-nightly.<ts>.<run>.g<sha>" (nightly prerelease)
	const match = output.trim().match(/\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)/);
	return match?.[1];
}

export function parseReportedVersionForTest(output: string): string | undefined {
	return parseReportedVersion(output);
}

const VERIFICATION_OUTPUT_MAX_LENGTH = 512;
const ANSI_ESCAPE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/gu;
const UNSAFE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;

function sanitizeVerificationOutput(...streams: Array<string | undefined>): string | undefined {
	const output = streams
		.map(stream => stream?.replace(ANSI_ESCAPE, "").replace(UNSAFE_CONTROL, " ").replace(/\s+/g, " ").trim() ?? "")
		.filter(Boolean)
		.filter((stream, index, all) => all.indexOf(stream) === index)
		.join(" ");
	if (!output) return undefined;
	const redacted = redactCrashSecrets(output);
	if (redacted.length <= VERIFICATION_OUTPUT_MAX_LENGTH) return redacted;
	return `${redacted.slice(0, VERIFICATION_OUTPUT_MAX_LENGTH - 3)}...`;
}

export function sanitizeVerificationOutputForTest(
	stderr: string | undefined,
	stdout: string | undefined,
): string | undefined {
	return sanitizeVerificationOutput(stderr, stdout);
}

interface InstalledVersionCommandResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

type InstalledVersionCommandRunner = (runtimePath: string) => Promise<InstalledVersionCommandResult>;

async function verifyInstalledVersionWith(
	expectedVersion: string,
	runtimePath: string | undefined,
	runVersion: InstalledVersionCommandRunner,
): Promise<InstalledVersionVerification> {
	if (!runtimePath) return { ok: false };
	try {
		const result = await runVersion(runtimePath);
		if (result.exitCode !== 0) {
			return {
				ok: false,
				path: runtimePath,
				versionOutput: sanitizeVerificationOutput(result.stderr, result.stdout),
			};
		}
		const actual = parseReportedVersion(result.stdout);
		return { ok: actual === expectedVersion, actual, path: runtimePath };
	} catch (error) {
		return {
			ok: false,
			path: runtimePath,
			versionOutput: sanitizeVerificationOutput(error instanceof Error ? error.message : String(error)),
		};
	}
}

export async function verifyInstalledVersionForTest(options: {
	expectedVersion: string;
	runtimePath: string | undefined;
	runVersion: InstalledVersionCommandRunner;
}): Promise<InstalledVersionVerification> {
	return await verifyInstalledVersionWith(options.expectedVersion, options.runtimePath, options.runVersion);
}

/**
 * Run the resolved gjc binary and check if it reports the expected version.
 */
async function verifyInstalledVersion(
	expectedVersion: string,
	runtimePath: string | undefined = resolveGjcPath(),
): Promise<InstalledVersionVerification> {
	return await verifyInstalledVersionWith(expectedVersion, runtimePath, async resolvedPath => {
		const result = await $`${resolvedPath} --version`.quiet().nothrow();
		return {
			exitCode: result.exitCode,
			stdout: result.stdout.toString(),
			stderr: result.stderr.toString(),
		};
	});
}

async function verifyInstalledRuntime(
	expectedVersion: string,
	runtimePath?: string,
): Promise<InstalledVersionVerification> {
	const versionResult = await verifyInstalledVersion(expectedVersion, runtimePath ?? resolveGjcPath());
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

interface MigrationTargetVerificationOptions {
	runtimePath: string;
	verifyChecksum: () => Promise<void>;
	verifyRuntime: () => Promise<InstalledVersionVerification>;
}

interface MigrationChecksumOptions {
	tag: string;
	assetName: string;
	filePath: string;
}

type MigrationChecksumVerifier = (options: MigrationChecksumOptions) => Promise<unknown>;

async function verifyMigrationTargetWith(
	options: MigrationTargetVerificationOptions,
): Promise<InstalledVersionVerification> {
	try {
		await options.verifyChecksum();
	} catch {
		return { ok: false, path: options.runtimePath };
	}
	return await options.verifyRuntime();
}

async function verifyMigrationTarget(
	release: Pick<ReleaseInfo, "tag" | "version">,
	runtimePath: string,
	verifyChecksum: MigrationChecksumVerifier = verifyDownloadedBinaryChecksum,
	verifyRuntime: (
		expectedVersion: string,
		runtimePath: string,
	) => Promise<InstalledVersionVerification> = verifyInstalledRuntime,
): Promise<InstalledVersionVerification> {
	return await verifyMigrationTargetWith({
		runtimePath,
		verifyChecksum: async () => {
			await verifyChecksum({
				tag: release.tag,
				assetName: getBinaryName(),
				filePath: runtimePath,
			});
		},
		verifyRuntime: async () => await verifyRuntime(release.version, runtimePath),
	});
}

export async function verifyMigrationTargetForTest(
	options: MigrationTargetVerificationOptions,
): Promise<InstalledVersionVerification> {
	return await verifyMigrationTargetWith(options);
}

export async function verifyMigrationTargetAdapterForTest(options: {
	release: Pick<ReleaseInfo, "tag" | "version">;
	runtimePath: string;
	verifyChecksum: MigrationChecksumVerifier;
	verifyRuntime: (expectedVersion: string, runtimePath: string) => Promise<InstalledVersionVerification>;
}): Promise<InstalledVersionVerification> {
	return await verifyMigrationTarget(
		options.release,
		options.runtimePath,
		options.verifyChecksum,
		options.verifyRuntime,
	);
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
	return `For a supported binary install, reinstall with: curl -fsSL https://raw.githubusercontent.com/${RELEASE_REPO}/main/scripts/install.sh | sh`;
}

function formatManualUpdateInstructions(platform: NodeJS.Platform = process.platform): string {
	return [
		formatBinaryInstallInstruction(platform),
		`Source checkouts and dev-links must be updated through that checkout; they are never overwritten by ${APP_NAME} update.`,
		`Bun is only required for source development/build. Ordinary installs and updates do not use Bun or npm.`,
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
	registryNote?: string,
): string {
	const note = registryNote ? `\n${registryNote}` : "";
	return `Download failed for ${binaryName} from ${url}: ${status}.${note}\n${formatManualUpdateInstructions(platform)}`;
}

export function formatBinaryDownloadFailureMessageForTest(
	binaryName: string,
	url: string,
	status: string | number,
	platform: NodeJS.Platform = process.platform,
	registryNote?: string,
): string {
	return formatBinaryDownloadFailureMessage(binaryName, url, status, platform, registryNote);
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
	const outputSuffix = result.versionOutput ? `: ${result.versionOutput}` : "";
	return `could not verify updated version${result.path ? ` at ${result.path}` : ""}${outputSuffix}`;
}

export function formatVerificationFailureForTest(
	result: InstalledVersionVerification,
	expectedVersion: string,
): string {
	return formatVerificationFailure(result, expectedVersion);
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

export async function recoverWindowsUpdateJournal(journalPath: string): Promise<void> {
	let raw: string;
	try {
		raw = await fs.promises.readFile(journalPath, "utf8");
	} catch (err) {
		if (isEnoent(err)) return;
		throw err;
	}
	let target = "";
	let backup = "";
	let next = "";
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed && typeof parsed === "object") {
			const record = parsed as { target?: unknown; backup?: unknown; next?: unknown };
			if (typeof record.target === "string") target = record.target;
			if (typeof record.backup === "string") backup = record.backup;
			if (typeof record.next === "string") next = record.next;
		}
	} catch {
		await unlinkIfExists(journalPath);
		return;
	}
	const exists = async (p: string): Promise<boolean> => {
		try {
			await fs.promises.lstat(p);
			return true;
		} catch (err) {
			if (isEnoent(err)) return false;
			throw err;
		}
	};
	if (target && next && (await exists(next))) {
		if (!(await exists(target))) {
			await fs.promises.rename(next, target);
			await unlinkIfExists(journalPath);
			return;
		}
		try {
			const recoverBackup = `${target}.bak.recover.${process.pid}.${Date.now().toString(16)}`;
			await fs.promises.rename(target, recoverBackup);
			try {
				await fs.promises.rename(next, target);
			} catch (promoteErr) {
				try {
					await fs.promises.rename(recoverBackup, target);
				} catch {
					throw promoteErr;
				}
				throw promoteErr;
			}
			await unlinkIfExists(recoverBackup);
			await unlinkIfExists(journalPath);
			return;
		} catch {
			return;
		}
	}
	if (target && backup && !(await exists(target))) {
		try {
			await fs.promises.rename(backup, target);
		} catch (restoreErr) {
			if (!isEnoent(restoreErr)) throw restoreErr;
		}
	}
	await unlinkIfExists(journalPath);
}

/**
 * Atomically replace the installed binary and roll back if version verification fails.
 */
export async function replaceBinaryForUpdate(options: BinaryReplacementOptions): Promise<InstalledVersionVerification> {
	let backupReady = false;
	let published = false;
	let stagedNext = false;
	const journalPath = `${options.targetPath}.update-journal`;
	try {
		if (process.platform === "win32") {
			await recoverWindowsUpdateJournal(journalPath);
		}
		try {
			const dest = await fs.promises.lstat(options.targetPath);
			if (dest.isSymbolicLink()) {
				throw new Error(
					`Refusing to replace symlink ${options.targetPath} with a regular binary. Set GJC_INSTALL_DIR to a real directory.`,
				);
			}
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
		await unlinkIfExists(options.backupPath);
		if (process.platform === "win32") {
			const nextPath = `${options.targetPath}.next`;
			await fs.promises.writeFile(
				journalPath,
				JSON.stringify({
					target: options.targetPath,
					backup: options.backupPath,
					temp: options.tempPath,
					next: nextPath,
				}),
				"utf8",
			);
			try {
				await fs.promises.rename(options.targetPath, options.backupPath);
				backupReady = true;
			} catch (err) {
				if (isEnoent(err)) {
					backupReady = false;
				} else {
					await fs.promises.copyFile(options.tempPath, nextPath);
					stagedNext = true;
					throw new Error(
						`Running Windows image ${options.targetPath} could not be replaced in-process (${err}). Staged ${nextPath}. Close running gjc.exe and re-run gjc update.`,
					);
				}
			}
		} else {
			try {
				await fs.promises.copyFile(options.targetPath, options.backupPath);
				backupReady = true;
			} catch (err) {
				if (!isEnoent(err)) throw err;
			}
		}
		await fs.promises.rename(options.tempPath, options.targetPath);
		published = true;

		const verification = await options.verifyInstalledVersion(options.expectedVersion);
		if (!verification.ok) {
			throw new Error(
				`${formatVerificationFailure(verification, options.expectedVersion)}; restored previous ${APP_NAME} binary`,
			);
		}

		backupReady = false;
		if (process.platform === "win32") await unlinkIfExists(journalPath);
		const cleanupWarning = await cleanupVerifiedBackup(options.backupPath);
		return cleanupWarning ? { ...verification, cleanupWarning } : verification;
	} catch (err) {
		if (backupReady) {
			await unlinkIfExists(options.targetPath);
			await fs.promises.rename(options.backupPath, options.targetPath);
		} else if (published) {
			await unlinkIfExists(options.targetPath);
		}
		await unlinkIfExists(options.tempPath);
		if (process.platform === "win32" && !stagedNext) await unlinkIfExists(journalPath);
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

function formatPackageManagerVerificationFailure(
	managerName: string,
	verification: InstalledVersionVerification,
	expectedVersion: string,
): string {
	return `${managerName} install exited successfully, but the selected ${APP_NAME} runtime failed verification: ${formatVerificationFailure(verification, expectedVersion)}`;
}

export async function runPackageManagerUpdateForTest(
	options: PackageManagerUpdateOptions,
): Promise<InstalledVersionVerification> {
	return updateViaPackageManager(options);
}

async function updateViaPackageManager(options: PackageManagerUpdateOptions): Promise<InstalledVersionVerification> {
	const result = await options.runInstall(options.expectedVersion);
	if (result.exitCode === 0) {
		const verification = await options.verifyInstalledRuntime(options.expectedVersion);
		if (!verification.ok) {
			throw new Error(
				formatPackageManagerVerificationFailure(options.managerName, verification, options.expectedVersion),
			);
		}
		printSuccessfulVerification(options.expectedVersion);
		return verification;
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
 * Flush a freshly written file's data to stable storage.
 *
 * Critical on network filesystems (e.g. NFS home directories): `pipeline`
 * resolving does not guarantee the downloaded bytes are durable on the
 * server, so the post-install `gjc --version` check can exec a binary whose
 * pages are not yet consistent. The child then faults, the version check
 * fails, and the update is rolled back with "could not verify updated
 * version" even though the download itself succeeded. Explicitly fsyncing
 * before the rename/exec avoids the race.
 */
async function fsyncFile(filePath: string): Promise<void> {
	const handle = await fs.promises.open(filePath, "r+");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

export async function fsyncFileForTest(filePath: string): Promise<void> {
	return fsyncFile(filePath);
}

/**
 * Download a release binary to a temp path, throwing a friendly error when the
 * release asset cannot be fetched.
 */
async function downloadBinaryTo(
	url: string,
	tempPath: string,
	binaryName: string,
	registryNote?: string,
	expectedVersion?: string,
): Promise<void> {
	const response = await fetch(url, { redirect: "follow" });
	if (!response.ok || !response.body) {
		throw new Error(
			formatBinaryDownloadFailureMessage(
				binaryName,
				url,
				response.statusText || response.status,
				process.platform,
				registryNote,
			),
		);
	}
	try {
		const fileStream = fs.createWriteStream(tempPath, { mode: 0o755 });
		await pipeline(response.body, fileStream);
		const stat = await fs.promises.stat(tempPath);
		if (stat.size <= 0) {
			throw new Error(`Downloaded file was empty: ${url}`);
		}
	} catch (err) {
		await unlinkIfExists(tempPath);
		throw err;
	}
	if (expectedVersion) {
		const tag = expectedVersion.startsWith("v") ? expectedVersion : `v${expectedVersion}`;
		try {
			await verifyDownloadedBinaryChecksum({
				tag,
				assetName: binaryName,
				filePath: tempPath,
			});
		} catch (err) {
			await unlinkIfExists(tempPath);
			throw err;
		}
	}
}

/** Injectable steps of the binary update flow (seams for testing ordering). */
export interface BinaryUpdateFlow {
	download(url: string, tempPath: string): Promise<void>;
	fsync(filePath: string): Promise<void>;
	replace(options: BinaryReplacementOptions): Promise<InstalledVersionVerification>;
	verifyInstalledVersion(expectedVersion: string): Promise<InstalledVersionVerification>;
	/** Best-effort cleanup of the temp file when the flow aborts before replace. */
	removeTemp?(filePath: string): Promise<void>;
	/** Called once fsync has succeeded, right before replacement begins. */
	beforeReplace?(): void;
}

/**
 * Orchestrate download → fsync → replace → verify with a strict ordering
 * contract: the downloaded temp binary MUST be flushed to stable storage
 * before it is published (renamed into place) or exec'd for verification.
 *
 * If fsync fails the temp bytes are not durable, so we abort before
 * replacement/verification and clean up the temp file rather than installing a
 * possibly-truncated binary.
 */
export async function runBinaryUpdateFlow(
	targetPath: string,
	url: string,
	expectedVersion: string,
	flow: BinaryUpdateFlow,
): Promise<InstalledVersionVerification> {
	const stamp = `${process.pid}.${Date.now().toString(16)}`;
	const tempPath = `${targetPath}.new.${stamp}`;
	const backupPath = `${targetPath}.bak.${stamp}`;
	const releaseLock = await acquireBinaryUpdateLock(targetPath);
	try {
		await flow.download(url, tempPath);
		try {
			await flow.fsync(tempPath);
		} catch (err) {
			if (flow.removeTemp) await flow.removeTemp(tempPath);
			throw err;
		}

		flow.beforeReplace?.();
		return await flow.replace({
			targetPath,
			tempPath,
			backupPath,
			expectedVersion,
			verifyInstalledVersion: flow.verifyInstalledVersion,
		});
	} finally {
		await releaseLock();
	}
}

async function acquireBinaryUpdateLock(targetPath: string): Promise<() => Promise<void>> {
	const lockFile = path.join(path.dirname(targetPath), ".gjc-install.lock");
	const nonce = `${process.pid}.${Date.now().toString(16)}.${Math.random().toString(16).slice(2)}`;
	const claim = `${process.pid} ${nonce}\n`;
	const publish = async (): Promise<void> => {
		const handle = await fs.promises.open(lockFile, "wx");
		try {
			await handle.write(claim);
		} finally {
			await handle.close();
		}
	};
	const ownsClaim = async (): Promise<boolean> => {
		try {
			return (await fs.promises.readFile(lockFile, "utf8")) === claim;
		} catch {
			return false;
		}
	};
	const release = async (): Promise<void> => {
		try {
			if (!(await ownsClaim())) return;
			await unlinkIfExists(lockFile);
		} catch {
			// Best-effort lock release after a verified or failed update.
		}
	};
	try {
		await publish();
		return release;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return async () => {};
		if (code === "EEXIST") {
			throw new Error(
				`Another ${APP_NAME} update is already running for ${targetPath}. Remove ${lockFile} only after confirming no installer or update is running.`,
			);
		}
		throw err;
	}
}

/**
 * Describe the registry a version came from, when it is not the public one.
 *
 * The binary update path downloads from GitHub release tags, so a version that
 * only exists on a private mirror produces a bare 404 with nothing linking it
 * back to the registry that named it.
 */
function formatRegistryProvenance(version: string, registry: string | undefined): string | undefined {
	if (!registry || registry === `https://github.com/${RELEASE_REPO}` || registry === GITHUB_RELEASE_DOWNLOAD_ORIGIN) {
		return undefined;
	}
	return `Version ${version} was resolved from ${registry}; GitHub release assets may not exist for a version that was never published there.`;
}

interface ProcessReportWithLibc {
	header?: {
		glibcVersionRuntime?: unknown;
	};
}

const GLIBC_VERSION_PATTERN = /^\d+\.\d+$/u;

function reportedGlibcVersion(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const version = value.trim();
	return GLIBC_VERSION_PATTERN.test(version) ? version : undefined;
}

function runtimeGlibcVersion(): string | undefined {
	try {
		const report = process.report?.getReport?.() as ProcessReportWithLibc | undefined;
		return reportedGlibcVersion(report?.header?.glibcVersionRuntime);
	} catch {
		return undefined;
	}
}

function hasMuslLoader(): boolean {
	return (
		fs.existsSync("/lib/ld-musl-x86_64.so.1") ||
		fs.existsSync("/lib/ld-musl-aarch64.so.1") ||
		fs.existsSync("/lib/ld-musl-armhf.so.1")
	);
}

type LinuxLibc = "glibc" | "musl" | "unknown";

function detectLinuxLibcFromSignals(glibcVersionRuntime: string | undefined, muslLoaderPresent: boolean): LinuxLibc {
	if (reportedGlibcVersion(glibcVersionRuntime) !== undefined) return "glibc";
	return muslLoaderPresent ? "musl" : "unknown";
}

function detectLinuxLibc(): LinuxLibc {
	return detectLinuxLibcFromSignals(runtimeGlibcVersion(), hasMuslLoader());
}

function unsupportedLinuxLibcReason(libc: LinuxLibc): string | undefined {
	if (libc === "glibc") return undefined;
	return libc === "musl"
		? "Unsupported libc: musl. Prebuilt Linux binaries are glibc-only. See docs/install.md"
		: "Unable to verify an active glibc runtime. Prebuilt Linux binaries are glibc-only. See docs/install.md";
}

function assertSupportedLinuxLibc(libc: LinuxLibc): void {
	const reason = unsupportedLinuxLibcReason(libc);
	if (reason) throw new Error(formatUnsupportedTargetMessage(reason));
}

export function assertSupportedLinuxLibcForTest(
	glibcVersionRuntime: string | undefined,
	muslLoaderPresent: boolean,
): void {
	assertSupportedLinuxLibc(detectLinuxLibcFromSignals(glibcVersionRuntime, muslLoaderPresent));
}

/**
 * Download a release binary to a target path, replacing an existing file.
 */
async function updateViaBinaryAt(
	targetPath: string,
	expectedVersion: string,
	registry?: string,
): Promise<InstalledVersionVerification> {
	const linuxLibc = process.platform === "linux" ? detectLinuxLibc() : undefined;
	if (linuxLibc !== undefined) assertSupportedLinuxLibc(linuxLibc);
	const binaryName = getBinaryName();
	const url = buildReleaseBinaryUrl(expectedVersion);
	const registryNote = formatRegistryProvenance(expectedVersion, registry);
	console.log(chalk.dim(`Downloading ${binaryName}…`));
	await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });

	const verification = await runBinaryUpdateFlow(targetPath, url, expectedVersion, {
		download: (downloadUrl, tempPath) =>
			downloadBinaryTo(downloadUrl, tempPath, binaryName, registryNote, expectedVersion),
		fsync: fsyncFile,
		replace: replaceBinaryForUpdate,
		verifyInstalledVersion: version => verifyInstalledRuntime(version, targetPath),
		removeTemp: unlinkIfExists,
		beforeReplace: () => console.log(chalk.dim("Installing update...")),
	});

	printVerifiedVersion(expectedVersion);
	if (verification.cleanupWarning) console.warn(chalk.yellow(verification.cleanupWarning));
	printRestartGuidance();
	return verification;
}

/**
 * Run the update command.
 */
export interface UpdateCommandDependencies {
	platform?: NodeJS.Platform;
	getLatestRelease?: (options?: LatestReleaseLookupOptions) => Promise<ReleaseInfo>;
	resolveUpdateTarget?: () => Promise<UpdateTarget>;
	verifyMigrationTarget?: (release: ReleaseInfo, runtimePath: string) => Promise<InstalledVersionVerification>;
	performUpdate?: (
		target: UpdateTarget,
		expectedVersion: string,
		registry?: string,
	) => Promise<InstalledVersionVerification | undefined>;
	refreshInstalledDefaultSkills?: () => Promise<void>;
	settings?: () => Promise<Settings>;
	stopDaemon?: (settings: Settings) => Promise<void>;
	restartDaemon?: (settings: Settings) => Promise<void>;
	recoverNotifications?: (settings: Settings) => Promise<void>;
	runPostUpdateRecovery?: (runtimePath: string) => Promise<void>;
	offerCommunityApp?: (runtimePath: string) => Promise<void>;
	recordTelemetryEvent?: (event: TelemetryEventName, details: TelemetryDetails) => unknown;
	exit?: (code: number) => never;
}

export type PostUpdateRecoverySpawn = (argv: string[]) => Promise<number>;
export type PostUpdateRecoverySupportCheck = (runtimePath: string) => Promise<boolean>;
export type LegacyRecoveryDaemonKinds = () => Promise<NotificationProvider[]>;

/**
 * A complete, non-quarantined provider with provider-level desired intent is a
 * durable managed-notify setup. The global switch is deliberately excluded:
 * disabling delivery must not leave credential-backed daemon locks unrecovered.
 */
export function hasManagedNotifySetup(settings: Settings): boolean {
	return managedNotifyDaemonKinds(settings).length > 0;
}

function managedNotifyDaemonKinds(settings: Settings): NotificationProvider[] {
	const config = getNotificationConfig(settings);
	return (["telegram", "discord", "slack"] as const).filter(provider => {
		const resolution = resolveNotificationProvider(config, provider);
		return resolution.configured && !resolution.quarantined && resolution.desiredEnabled;
	});
}

async function stopManagedDaemon(settings: Settings): Promise<void> {
	const kinds = managedNotifyDaemonKinds(settings);
	let failed = false;
	await runDaemonCommand(
		{ action: "stop", kinds, all: false, json: false, force: true },
		{
			settings,
			setExitCode: code => {
				if (code !== 0) failed = true;
			},
		},
	);
	if (failed) throw new Error("daemon stop reported failure");
}

async function restartManagedDaemon(settings: Settings): Promise<void> {
	const kinds = managedNotifyDaemonKinds(settings);
	let failed = false;
	await runDaemonCommand(
		{ action: "restart", kinds, all: false, json: false, force: false, allowDisabledNoop: true },
		{
			settings,
			setExitCode: code => {
				if (code !== 0) failed = true;
			},
		},
	);
	if (failed) throw new Error("daemon restart reported failure");
}

async function recoverManagedNotifications(settings: Settings): Promise<void> {
	await runNotifyCommand({ action: "recovery", rawArgs: [], forceDaemonLock: false }, { settings });
}

async function spawnPostUpdateRecovery(argv: string[]): Promise<number> {
	const child = Bun.spawn(argv, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
	return await child.exited;
}

async function runCommunityAppOfferFromRuntime(
	runtimePath: string,
	deps: Pick<UpdateCommandDependencies, "offerCommunityApp">,
): Promise<void> {
	if (deps.offerCommunityApp) {
		await deps.offerCommunityApp(runtimePath);
		return;
	}
	const result = await offerMacosCommunityApp();
	if (result.status === "failed") throw new Error(result.reason);
}

async function supportsUpdateRecovery(runtimePath: string): Promise<boolean> {
	const child = Bun.spawn([runtimePath, "update", "--help"], { stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
	return exitCode === 0 && stdout.includes("update-recovery");
}

async function runLegacyPostUpdateRecovery(
	runtimePath: string,
	spawn: PostUpdateRecoverySpawn,
	managedKinds: LegacyRecoveryDaemonKinds,
): Promise<void> {
	const kinds = await managedKinds();
	if (kinds.length === 0) return;
	for (const [name, argv] of [
		["daemon stop --force", [runtimePath, "daemon", "stop", ...kinds, "--force"]],
		["daemon reload", [runtimePath, "daemon", "reload", ...kinds]],
		["notify recovery", [runtimePath, "notify", "recovery"]],
	] as const) {
		const exitCode = await spawn([...argv]);
		if (exitCode !== 0) throw new Error(`legacy post-update ${name} exited ${exitCode}`);
	}
}

export async function runPostUpdateRecoveryForTest(
	runtimePath: string,
	spawn: PostUpdateRecoverySpawn = spawnPostUpdateRecovery,
	supportsRecovery: PostUpdateRecoverySupportCheck = supportsUpdateRecovery,
	managedKinds: LegacyRecoveryDaemonKinds = async () => managedNotifyDaemonKinds(await Settings.init()),
): Promise<void> {
	if (!(await supportsRecovery(runtimePath))) {
		await runLegacyPostUpdateRecovery(runtimePath, spawn, managedKinds);
		return;
	}
	const exitCode = await spawn([runtimePath, "update", "update-recovery"]);
	if (exitCode !== 0) throw new Error(`the verified installed runtime exited ${exitCode}`);
}

async function runPostUpdateRecovery(runtimePath: string): Promise<void> {
	await runPostUpdateRecoveryForTest(runtimePath);
}

export async function runManagedNotifyRecovery(
	deps: Pick<UpdateCommandDependencies, "settings" | "stopDaemon" | "restartDaemon" | "recoverNotifications">,
): Promise<void> {
	const settings = await (deps.settings ?? (() => Settings.init()))();
	if (!hasManagedNotifySetup(settings)) return;
	const stages: readonly [string, (settings: Settings) => Promise<void>][] = [
		["daemon stop --force", deps.stopDaemon ?? stopManagedDaemon],
		["daemon restart", deps.restartDaemon ?? restartManagedDaemon],
		["notify recovery", deps.recoverNotifications ?? recoverManagedNotifications],
	];
	for (const [name, run] of stages) {
		try {
			await run(settings);
		} catch (error) {
			throw new Error(`Post-update ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

async function performUpdate(
	target: UpdateTarget,
	expectedVersion: string,
	registry?: string,
): Promise<InstalledVersionVerification> {
	if (target.method === "migrate") {
		if (target.previousPath) {
			console.log(
				chalk.yellow(
					`Current ${APP_NAME} at ${target.previousPath} is a package-manager shim or wrapper; installing a standalone binary at ${target.path} without overwriting the shim.`,
				),
			);
		}
		const verification = await updateViaBinaryAt(target.path, expectedVersion, registry);
		console.log(
			chalk.cyan(
				`Put ${path.dirname(target.path)} first on PATH so the standalone binary wins over any leftover Bun/npm shim.`,
			),
		);
		return verification;
	}
	if (target.method === "binary") {
		return await updateViaBinaryAt(target.path, expectedVersion, registry);
	}
	const fallbackPath = defaultUserBinaryPath();
	console.log(
		chalk.yellow(
			`Package-manager updates are no longer the default. Installing a standalone binary at ${fallbackPath}.`,
		),
	);
	return await updateViaBinaryAt(fallbackPath, expectedVersion, registry);
}

/** How the update command should proceed after comparing versions. */
export interface UpdateDecision {
	install: boolean;
	kind: "up-to-date" | "new-version" | "switch-back" | "force" | "migrate";
}

/**
 * Decide whether to install after comparing the channel's release with the
 * installed version.
 *
 * A nightly install is semver-newer than every stable release (nightlies
 * version as stable-max-patch+1), so a plain comparison would pin the user on
 * nightly forever: switching back to stable must install even though the
 * target is semver-lower. Only a stable lookup from a nightly build is an
 * intentional switch-back — the reverse (a same-core nightly behind the
 * installed stable) still requires --force.
 */
export function resolveUpdateDecision(options: {
	comparison: number;
	force: boolean;
	channel: UpdateChannel;
	currentVersion: string;
	migrate?: boolean;
}): UpdateDecision {
	const isChannelSwitchBack =
		options.channel === "stable" && options.currentVersion.includes("-nightly.") && options.comparison < 0;
	if (options.migrate && !options.force && !isChannelSwitchBack && options.comparison === 0) {
		return { install: true, kind: "migrate" };
	}
	if (options.comparison <= 0 && !isChannelSwitchBack && !options.force) {
		return { install: false, kind: "up-to-date" };
	}
	if (isChannelSwitchBack) return { install: true, kind: "switch-back" };
	return { install: true, kind: options.comparison > 0 ? "new-version" : "force" };
}

function printVerifiedMigrationTarget(target: MigrationUpdateTarget, version: string): void {
	console.log(
		chalk.green(
			`${theme.status.success} Standalone ${APP_NAME} ${version} is already installed and verified at ${target.path}`,
		),
	);
	if (target.previousPath) {
		console.log(chalk.yellow(`${target.previousPath} shadows it on PATH.`));
		console.log(
			chalk.cyan(
				`The standalone directory ${path.dirname(target.path)} must precede the shim directory ${path.dirname(target.previousPath)} on PATH.`,
			),
		);
		return;
	}
	console.log(chalk.cyan(`Ensure the standalone directory ${path.dirname(target.path)} is on PATH.`));
}

export async function runUpdateCommand(
	opts: UpdateCommandOptions,
	deps: UpdateCommandDependencies = {},
): Promise<void> {
	const channel = opts.channel ?? "stable";
	const lookupRelease = deps.getLatestRelease ?? getLatestRelease;
	const resolveTarget = deps.resolveUpdateTarget ?? resolveUpdateTarget;
	const verifyTarget = deps.verifyMigrationTarget ?? verifyMigrationTarget;
	const update = deps.performUpdate ?? performUpdate;
	const refreshDefaults = deps.refreshInstalledDefaultSkills ?? refreshInstalledDefaultSkills;
	const exit = deps.exit ?? process.exit;
	const recordEvent = deps.recordTelemetryEvent ?? ((event, details) => recordTelemetryEvent(event, details));
	const pendingTelemetry = new Set<Promise<void>>();
	const record = (event: TelemetryEventName, details: TelemetryDetails): void => {
		const result = recordEvent(event, details);
		if (result !== null && (typeof result === "object" || typeof result === "function") && "then" in result) {
			const pending = Promise.resolve(result as PromiseLike<unknown>).then(
				() => undefined,
				() => undefined,
			);
			pendingTelemetry.add(pending);
			void pending.finally(() => pendingTelemetry.delete(pending));
		}
	};
	const flushTelemetryBeforeExit = async (): Promise<never> => {
		await Promise.race([Promise.allSettled([...pendingTelemetry]), Bun.sleep(2000)]);
		return exit(1);
	};
	record("update_check_started", { channel });

	console.log(chalk.dim(`Current version: ${VERSION}`));
	if (channel !== "stable") {
		console.log(chalk.dim(`Update channel: ${channel} (GitHub ${channel === "nightly" ? "prerelease" : "release"})`));
	}

	let target: UpdateTarget | undefined;
	try {
		target = await resolveTarget();
	} catch (err) {
		record("update_check_completed", { channel, result: "failed" });
		console.error(chalk.red(err instanceof Error ? err.message : String(err)));
		return flushTelemetryBeforeExit();
	}

	let release: ReleaseInfo;
	try {
		release = await lookupRelease({ channel });
	} catch (err) {
		record("update_check_completed", { channel, result: "failed" });
		console.error(chalk.red(`Failed to check for updates: ${err}`));
		return flushTelemetryBeforeExit();
	}

	// A config file that exists but could not be read changes which registry
	// answered; saying so beats a version that quietly came from somewhere else.
	// `?? []` because UpdateCommandDependencies is a public seam an untyped
	// consumer can satisfy without the field.
	for (const warning of release.warnings ?? []) console.warn(chalk.yellow(`Warning: ${warning}`));

	let comparison: number;
	try {
		comparison = compareVersions(release.version, VERSION);
	} catch (err) {
		record("update_check_completed", { channel, result: "failed" });
		console.error(
			chalk.red(
				`Failed to check for updates: the ${channel} channel reported an unparseable version "${release.version}": ${err instanceof Error ? err.message : String(err)}`,
			),
		);
		return flushTelemetryBeforeExit();
	}

	const decision = resolveUpdateDecision({
		comparison,
		force: opts.force,
		channel,
		currentVersion: VERSION,
		migrate: target?.method === "migrate",
	});

	if (target.method === "migrate" && decision.install && !opts.force && opts.check) {
		const verification = await verifyTarget(release, target.path);
		if (verification.ok) {
			record("update_check_completed", { channel, result: "available" });
			printVerifiedMigrationTarget(target, release.version);
			record("update_install_completed", { channel, result: "skipped" });
			return;
		}
	}

	if (target.method === "migrate" && decision.install && !opts.force && !opts.check) {
		let migrationVerified = false;
		const releaseLock = await acquireBinaryUpdateLock(target.path);
		try {
			const verification = await verifyTarget(release, target.path);
			if (verification.ok) {
				record("update_check_completed", { channel, result: "available" });
				record("update_install_started", { channel, installMethod: target.method });
				printVerifiedMigrationTarget(target, release.version);
				migrationVerified = true;
			}
		} finally {
			await releaseLock();
		}
		if (migrationVerified) {
			if ((deps.platform ?? process.platform) === "darwin") {
				try {
					await runCommunityAppOfferFromRuntime(target.path, deps);
				} catch (error) {
					logger.warn(`Warning: optional macOS community app offer failed: ${error}`);
				}
			}
			record("update_install_completed", { channel, result: "installed", installMethod: target.method });
			return;
		}
	}

	if (!decision.install) {
		record("update_check_completed", { channel, result: "up_to_date" });
		console.log(chalk.green(`${theme.status.success} Already up to date`));
		return;
	}

	if (decision.kind === "switch-back") {
		console.log(chalk.cyan(`Switching to the stable channel: ${release.version}`));
	} else if (decision.kind === "new-version") {
		console.log(chalk.cyan(`New version available: ${release.version}`));
	} else if (decision.kind === "migrate") {
		console.log(chalk.cyan(`Migrating to a standalone GitHub binary: ${release.version}`));
	} else {
		console.log(chalk.yellow(`Forcing reinstall of ${release.version}`));
	}

	record("update_check_completed", { channel, result: "available" });
	if (opts.check) {
		record("update_install_completed", { channel, result: "skipped" });
		return;
	}

	let installedVersion: string | undefined;
	let installedRuntimePath: string | undefined;
	record("update_install_started", { channel, installMethod: target.method });
	try {
		const resolved = target ?? (await resolveTarget());
		const verification = await update(resolved, release.version, release.registry);
		if (verification?.path) {
			installedVersion = release.version;
			installedRuntimePath = verification.path;
			await (deps.runPostUpdateRecovery ?? runPostUpdateRecovery)(verification.path);
		} else if (!deps.performUpdate) throw new Error("verified installed runtime path is unavailable");
	} catch (err) {
		record("update_install_failed", { channel, result: "failed", installMethod: target.method });
		const prefix = installedVersion
			? `Updated to ${installedVersion}, but post-update recovery failed`
			: "Update failed";
		console.error(chalk.red(`${prefix}: ${err}`));
		return flushTelemetryBeforeExit();
	}

	// The installed runtime completes recovery before this old updater process
	// refreshes opt-in local definitions, avoiding stale-module daemon control.
	await refreshDefaults();
	if (installedVersion && installedRuntimePath && (deps.platform ?? process.platform) === "darwin") {
		try {
			await runCommunityAppOfferFromRuntime(installedRuntimePath, deps);
		} catch (error) {
			logger.warn(`Warning: optional macOS community app offer failed: ${error}`);
		}
	}
	record("update_install_completed", { channel, result: "installed", installMethod: target.method });
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
  -c, --check               Check for updates without installing
  -f, --force               Force reinstall even if up to date
  --channel <stable|nightly>  Release channel to update from (default: stable or startup.updateChannel setting)

${chalk.bold("After a verified update:")}
  When a complete managed notification provider is configured, GJC serially stops the daemon with --force, restarts it, then runs notify recovery. Globally disabled delivery still receives this lock recovery.

${chalk.bold("Examples:")}
  ${APP_NAME} update                    Update to latest version
  ${APP_NAME} update --check            Check if updates are available
  ${APP_NAME} update --force            Force reinstall
  ${APP_NAME} update --channel nightly  Update to the latest nightly prerelease
`);
}
