import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";

export const COMMUNITY_APP_REPOSITORY = "devswha/gajae-code-app";
export const COMMUNITY_APP_BUNDLE_ID = "app.gajae.desktop";
export const COMMUNITY_APP_SUPPRESS_ENV = "GJC_NO_COMMUNITY_APP";
const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_RELEASE_ORIGIN = "https://github.com";
const MAX_DMG_BYTES = 512 * 1024 * 1024;
const MAX_RELEASE_BYTES = 1024 * 1024;
const MAX_CHECKSUM_BYTES = 128 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 120_000;
type CommandRunner = (argv: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

interface ReleaseAsset {
	name: string;
	browser_download_url: string;
}

interface ReleasePayload {
	draft?: boolean;
	prerelease?: boolean;
	assets?: ReleaseAsset[];
	html_url?: string;
	tag_name?: string;
}

export interface CommunityAppOfferDependencies {
	platform?: NodeJS.Platform;
	arch?: string;
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
	stdinIsTTY?: boolean;
	stdoutIsTTY?: boolean;
	fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
	prompt?: () => Promise<boolean>;
	command?: CommandRunner;
	log?: (message: string) => void;
}

export interface CommunityAppOfferResult {
	status: "skipped" | "installed" | "failed";
	reason: string;
}

function isMacArchitecture(arch: string): arch is "arm64" | "x64" {
	return arch === "arm64" || arch === "x64";
}

function assetMatchesArchitecture(name: string, arch: "arm64" | "x64", version?: string): boolean {
	const versionPattern = version
		? version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
		: "[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?";
	return new RegExp(`^gajae-app-desktop-${versionPattern}-macos-${arch}\\.dmg$`, "i").test(name);
}

function releaseVersion(tag: string | undefined): string | undefined {
	if (!tag || !/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(tag)) return undefined;
	return tag.slice(1);
}

function trustedReleaseAssetUrl(value: string, expectedName: string): boolean {
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			url.origin === GITHUB_RELEASE_ORIGIN &&
			url.pathname.startsWith(`/${COMMUNITY_APP_REPOSITORY}/releases/download/`) &&
			decodeURIComponent(path.posix.basename(url.pathname)) === expectedName
		);
	} catch {
		return false;
	}
}

function parseChecksum(text: string, assetName: string): string | undefined {
	for (const line of text.split(/\r?\n/)) {
		const match = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
		if (!match) continue;
		if (match[2] === assetName || path.basename(match[2]) === assetName) return match[1].toLowerCase();
	}
	return undefined;
}

async function readResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		throw new Error(`DMG exceeds the ${maxBytes} byte safety limit`);
	}
	if (!response.body) {
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.byteLength > maxBytes) throw new Error(`DMG exceeds the ${maxBytes} byte safety limit`);
		return bytes;
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value) {
				total += value.byteLength;
				if (total > maxBytes) throw new Error(`DMG exceeds the ${maxBytes} byte safety limit`);
				chunks.push(value);
			}
		}
	} catch (error) {
		await reader.cancel().catch(() => undefined);
		throw error;
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

async function readResponseText(response: Response, maxBytes: number): Promise<string> {
	return new TextDecoder().decode(await readResponseBytes(response, maxBytes));
}

async function runCommand(argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
	const outputPromise = Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	const timeout = Promise.withResolvers<undefined>();
	const timer: NodeJS.Timeout = setTimeout(() => {
		try {
			child.kill("SIGKILL");
		} catch {
			// The command may have exited between the timeout and the kill.
		}
		timeout.resolve(undefined);
	}, COMMAND_TIMEOUT_MS);
	const output = await Promise.race([outputPromise, timeout.promise]);
	clearTimeout(timer);
	if (!output) {
		await outputPromise.catch(() => undefined);
		return { exitCode: 124, stdout: "", stderr: `command timed out: ${argv[0]}` };
	}
	const [stdout, stderr, exitCode] = output;
	return { exitCode, stdout, stderr };
}

async function readBundleValue(bundlePath: string, key: string, command: CommandRunner): Promise<string | undefined> {
	const result = await command([
		"/usr/bin/plutil",
		"-extract",
		key,
		"raw",
		"-o",
		"-",
		path.join(bundlePath, "Contents", "Info.plist"),
	]);
	return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined;
}

async function isExpectedBundle(bundlePath: string, command: CommandRunner): Promise<boolean> {
	if (!(await validateBundleLayout(bundlePath))) return false;
	return (await readBundleValue(bundlePath, "CFBundleIdentifier", command)) === COMMUNITY_APP_BUNDLE_ID;
}

async function validateBundleLayout(bundlePath: string): Promise<boolean> {
	const bundleReal = await fs.realpath(bundlePath).catch(() => undefined);
	if (!bundleReal) return false;
	const contents = path.join(bundlePath, "Contents");
	const contentsReal = await fs.realpath(contents).catch(() => undefined);
	if (!contentsReal || contentsReal !== path.join(bundleReal, "Contents")) return false;
	const infoPlist = path.join(contents, "Info.plist");
	const infoReal = await fs.realpath(infoPlist).catch(() => undefined);
	if (!infoReal || infoReal !== path.join(contentsReal, "Info.plist")) return false;
	const macOSRoot = path.join(contents, "MacOS");
	const macOSRootReal = await fs.realpath(macOSRoot).catch(() => undefined);
	if (!macOSRootReal || macOSRootReal !== path.join(contentsReal, "MacOS")) return false;
	const [bundleStat, contentsStat, infoStat, macOSRootStat] = await Promise.all([
		fs.lstat(bundlePath).catch(() => undefined),
		fs.lstat(contents).catch(() => undefined),
		fs.lstat(infoPlist).catch(() => undefined),
		fs.lstat(macOSRoot).catch(() => undefined),
	]);
	return Boolean(
		bundleStat?.isDirectory() &&
			contentsStat?.isDirectory() &&
			infoStat?.isFile() &&
			macOSRootStat?.isDirectory() &&
			!bundleStat.isSymbolicLink() &&
			!contentsStat.isSymbolicLink() &&
			!infoStat.isSymbolicLink() &&
			!macOSRootStat.isSymbolicLink(),
	);
}

async function resolveVerifiedExecutable(bundlePath: string, executable: string): Promise<string | undefined> {
	if (executable.length === 0 || path.basename(executable) !== executable || executable.includes("\\"))
		return undefined;
	if (!(await validateBundleLayout(bundlePath))) return undefined;
	const macOSRoot = path.join(bundlePath, "Contents", "MacOS");
	const executablePath = path.resolve(macOSRoot, executable);
	if (path.dirname(executablePath) !== path.resolve(macOSRoot)) return undefined;
	const [rootStat, executableStat] = await Promise.all([
		fs.lstat(macOSRoot).catch(() => undefined),
		fs.lstat(executablePath).catch(() => undefined),
	]);
	if (
		!rootStat?.isDirectory() ||
		rootStat.isSymbolicLink() ||
		!executableStat?.isFile() ||
		executableStat.isSymbolicLink()
	) {
		return undefined;
	}
	return executablePath;
}

async function findInstalledApp(homeDir: string, command: CommandRunner): Promise<string | undefined> {
	const candidates = [
		path.join(homeDir, "Applications", "Gajae Code App.app"),
		path.join(homeDir, "Applications", "Gajae-Code-App.app"),
		"/Applications/Gajae Code App.app",
		"/Applications/Gajae-Code-App.app",
	];
	for (const candidate of candidates) {
		if (await isExpectedBundle(candidate, command)) return candidate;
	}
	const result = await command(["/usr/bin/mdfind", `kMDItemCFBundleIdentifier == '${COMMUNITY_APP_BUNDLE_ID}'`]);
	if (result.exitCode !== 0) return undefined;
	for (const candidate of result.stdout
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(Boolean)) {
		if (await isExpectedBundle(candidate, command)) return candidate;
	}
	return undefined;
}

async function defaultPrompt(): Promise<boolean> {
	const readline = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = await readline.question("Install Gajae Code App (experimental, community-built)? [y/N] ");
		return /^y(?:es)?$/i.test(answer.trim());
	} finally {
		readline.close();
	}
}

function failure(reason: string, log: (message: string) => void): CommunityAppOfferResult {
	log(`Optional community app offer unavailable: ${reason}. See https://github.com/${COMMUNITY_APP_REPOSITORY}`);
	return { status: "failed", reason };
}

export async function offerMacosCommunityApp(
	deps: CommunityAppOfferDependencies = {},
): Promise<CommunityAppOfferResult> {
	const platform = deps.platform ?? process.platform;
	const env = deps.env ?? process.env;
	const log = deps.log ?? (message => process.stderr.write(`${message}\n`));
	if (platform !== "darwin") return { status: "skipped", reason: "unsupported platform" };
	if (env[COMMUNITY_APP_SUPPRESS_ENV] === "1" || env[COMMUNITY_APP_SUPPRESS_ENV]?.toLowerCase() === "true") {
		return { status: "skipped", reason: "suppressed by environment" };
	}
	if (
		env.CI ||
		env.GITHUB_ACTIONS ||
		env.GJC_NONINTERACTIVE === "1" ||
		env.GJC_NONINTERACTIVE?.toLowerCase() === "true"
	) {
		return { status: "skipped", reason: "automation environment" };
	}
	if (
		deps.stdinIsTTY === false ||
		deps.stdoutIsTTY === false ||
		(!deps.stdinIsTTY && !process.stdin.isTTY) ||
		(!deps.stdoutIsTTY && !process.stdout.isTTY)
	) {
		return { status: "skipped", reason: "non-interactive terminal" };
	}

	const command: CommandRunner = deps.command ?? runCommand;
	const homeDir = deps.homeDir ?? os.homedir();
	try {
		if (await findInstalledApp(homeDir, command)) return { status: "skipped", reason: "already installed" };
		if (!(await (deps.prompt ?? defaultPrompt)())) return { status: "skipped", reason: "cancelled" };
	} catch (error) {
		return failure(error instanceof Error ? error.message : String(error), log);
	}

	const arch = deps.arch ?? process.arch;
	if (!isMacArchitecture(arch)) return failure(`unsupported macOS architecture ${arch}`, log);
	const fetchImpl = deps.fetchImpl ?? fetch;
	const fetchOptions = (): RequestInit => ({ signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
	let tempRoot: string | undefined;
	let mountPoint: string | undefined;
	let attached = false;
	let installedDestination: string | undefined;
	try {
		const releaseResponse = await fetchImpl(
			`${GITHUB_API_ORIGIN}/repos/${COMMUNITY_APP_REPOSITORY}/releases/latest`,
			{
				headers: {
					Accept: "application/vnd.github+json",
					"User-Agent": "gjc-community-app-offer",
					"X-GitHub-Api-Version": "2022-11-28",
				},
				signal: fetchOptions().signal,
			},
		);
		if (!releaseResponse.ok)
			return failure(`no canonical published release is available (HTTP ${releaseResponse.status})`, log);
		const release = JSON.parse(await readResponseText(releaseResponse, MAX_RELEASE_BYTES)) as ReleasePayload;
		const tagVersion = releaseVersion(release.tag_name);
		if (!tagVersion || release.draft || release.prerelease || !release.assets?.length)
			return failure("no canonical published release is available", log);
		const dmg = release.assets.find(
			asset => asset.name.toLowerCase().endsWith(".dmg") && assetMatchesArchitecture(asset.name, arch, tagVersion),
		);
		if (!dmg || !trustedReleaseAssetUrl(dmg.browser_download_url, dmg.name))
			return failure(`no verified macOS ${arch} DMG is published`, log);
		const checksumAsset = release.assets.find(
			asset =>
				asset.name === `${dmg.name}.sha256` || (asset.name.endsWith(".sha256") && asset.name.includes(dmg.name)),
		);
		if (!checksumAsset || !trustedReleaseAssetUrl(checksumAsset.browser_download_url, checksumAsset.name))
			return failure("the release has no trusted DMG checksum", log);
		const [dmgResponse, checksumResponse] = await Promise.all([
			fetchImpl(dmg.browser_download_url, fetchOptions()),
			fetchImpl(checksumAsset.browser_download_url, fetchOptions()),
		]);
		if (!dmgResponse.ok || !checksumResponse.ok)
			return failure("the canonical release assets could not be downloaded", log);
		const dmgBytes = await readResponseBytes(dmgResponse, MAX_DMG_BYTES);
		const expected = parseChecksum(await readResponseText(checksumResponse, MAX_CHECKSUM_BYTES), dmg.name);
		if (!expected) return failure("the published checksum does not name the DMG", log);
		const actual = createHash("sha256").update(dmgBytes).digest("hex");
		if (actual !== expected) return failure("the DMG checksum did not match", log);

		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-community-app-"));
		const dmgPath = path.join(tempRoot, dmg.name);
		mountPoint = path.join(tempRoot, "mount");
		await fs.mkdir(mountPoint);
		await Bun.write(dmgPath, dmgBytes);
		const attach = await command([
			"/usr/bin/hdiutil",
			"attach",
			"-nobrowse",
			"-readonly",
			"-mountpoint",
			mountPoint,
			dmgPath,
		]);
		if (attach.exitCode !== 0) {
			try {
				await command(["/usr/bin/hdiutil", "detach", mountPoint, "-force"]);
			} catch {
				// The image may not have mounted; cleanup remains best effort.
			}
			return failure("the DMG could not be mounted safely", log);
		}
		attached = true;
		const entries = await fs.readdir(mountPoint, { withFileTypes: true });
		const appEntry = entries.find(entry => entry.isDirectory() && entry.name.endsWith(".app"));
		if (!appEntry) return failure("the mounted DMG contained no app bundle", log);
		const sourceApp = path.join(mountPoint, appEntry.name);
		if (!(await isExpectedBundle(sourceApp, command)))
			return failure(`the app bundle identifier was not ${COMMUNITY_APP_BUNDLE_ID}`, log);
		const executable = await readBundleValue(sourceApp, "CFBundleExecutable", command);
		if (!executable) return failure("the app bundle has no executable identity", log);
		const executablePath = await resolveVerifiedExecutable(sourceApp, executable);
		if (!executablePath) return failure("the app bundle executable path was unsafe", log);
		const signature = await command(["/usr/bin/codesign", "--verify", "--deep", "--strict", sourceApp]);
		if (signature.exitCode !== 0) return failure("the app bundle signature could not be verified", log);
		const archCheck = await command(["/usr/bin/lipo", "-archs", executablePath]);
		const executableArch = arch === "x64" ? "x86_64" : arch;
		if (archCheck.exitCode !== 0 || !archCheck.stdout.split(/\s+/).includes(executableArch))
			return failure(`the app bundle does not contain ${arch} code`, log);

		const destinationRoot = path.join(homeDir, "Applications");
		await fs.mkdir(destinationRoot, { recursive: true });
		const destination = path.join(destinationRoot, appEntry.name);
		try {
			await fs.mkdir(destination);
		} catch {
			return failure("the destination already contains an app bundle", log);
		}
		installedDestination = destination;
		const copy = await command(["/usr/bin/ditto", sourceApp, destination]);
		if (copy.exitCode !== 0) throw new Error("copying the verified app bundle failed");
		const launch = await command(["/usr/bin/open", destination]);
		if (launch.exitCode !== 0) {
			await fs.rm(destination, { recursive: true, force: true });
			installedDestination = undefined;
			return failure("the verified app could not be launched; the partial app state was removed", log);
		}
		return { status: "installed", reason: destination };
	} catch (error) {
		if (installedDestination) {
			try {
				await fs.rm(installedDestination, { recursive: true, force: true });
			} catch (cleanupError) {
				log(`Optional community app cleanup warning: failed to remove partial app state: ${String(cleanupError)}`);
			}
		}
		return failure(error instanceof Error ? error.message : String(error), log);
	} finally {
		if (attached && mountPoint) {
			try {
				const detach = await command(["/usr/bin/hdiutil", "detach", mountPoint, "-force"]);
				if (detach.exitCode !== 0)
					log("Optional community app cleanup warning: hdiutil could not detach the temporary DMG");
			} catch (error) {
				log(`Optional community app cleanup warning: failed to detach the temporary DMG: ${String(error)}`);
			}
		}
		if (tempRoot) {
			try {
				await fs.rm(tempRoot, { recursive: true, force: true });
			} catch (error) {
				log(`Optional community app cleanup warning: failed to remove temporary files: ${String(error)}`);
			}
		}
	}
}

export function parseCommunityAppChecksumForTest(text: string, assetName: string): string | undefined {
	return parseChecksum(text, assetName);
}

export function communityAppAssetMatchesArchitectureForTest(name: string, arch: "arm64" | "x64"): boolean {
	return assetMatchesArchitecture(name, arch);
}

export async function resolveCommunityAppExecutableForTest(
	bundlePath: string,
	executable: string,
): Promise<string | undefined> {
	return resolveVerifiedExecutable(bundlePath, executable);
}
