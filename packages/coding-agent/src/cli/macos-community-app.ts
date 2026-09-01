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

function assetMatchesArchitecture(name: string, arch: "arm64" | "x64"): boolean {
	const normalized = name.toLowerCase();
	return (
		normalized.includes("macos") && (normalized.includes(arch) || (arch === "x64" && normalized.includes("x86_64")))
	);
}

function trustedReleaseAssetUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			url.origin === GITHUB_RELEASE_ORIGIN &&
			url.pathname.startsWith(`/${COMMUNITY_APP_REPOSITORY}/releases/download/`)
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

async function runCommand(argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
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
	return (await readBundleValue(bundlePath, "CFBundleIdentifier", command)) === COMMUNITY_APP_BUNDLE_ID;
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
	const log = deps.log ?? (message => console.error(message));
	if (platform !== "darwin") return { status: "skipped", reason: "unsupported platform" };
	if (env[COMMUNITY_APP_SUPPRESS_ENV] === "1" || env[COMMUNITY_APP_SUPPRESS_ENV]?.toLowerCase() === "true") {
		return { status: "skipped", reason: "suppressed by environment" };
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
			},
		);
		if (!releaseResponse.ok)
			return failure(`no canonical published release is available (HTTP ${releaseResponse.status})`, log);
		const release = (await releaseResponse.json()) as ReleasePayload;
		if (release.draft || release.prerelease || !release.assets?.length)
			return failure("no canonical published release is available", log);
		const dmg = release.assets.find(
			asset => asset.name.toLowerCase().endsWith(".dmg") && assetMatchesArchitecture(asset.name, arch),
		);
		if (!dmg || !trustedReleaseAssetUrl(dmg.browser_download_url))
			return failure(`no verified macOS ${arch} DMG is published`, log);
		const checksumAsset = release.assets.find(
			asset =>
				asset.name === `${dmg.name}.sha256` || (asset.name.endsWith(".sha256") && asset.name.includes(dmg.name)),
		);
		if (!checksumAsset || !trustedReleaseAssetUrl(checksumAsset.browser_download_url))
			return failure("the release has no trusted DMG checksum", log);
		const [dmgResponse, checksumResponse] = await Promise.all([
			fetchImpl(dmg.browser_download_url),
			fetchImpl(checksumAsset.browser_download_url),
		]);
		if (!dmgResponse.ok || !checksumResponse.ok)
			return failure("the canonical release assets could not be downloaded", log);
		const dmgBytes = new Uint8Array(await dmgResponse.arrayBuffer());
		const expected = parseChecksum(await checksumResponse.text(), dmg.name);
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
		if (attach.exitCode !== 0) return failure("the DMG could not be mounted safely", log);
		attached = true;
		const entries = await fs.readdir(mountPoint, { withFileTypes: true });
		const appEntry = entries.find(entry => entry.isDirectory() && entry.name.endsWith(".app"));
		if (!appEntry) return failure("the mounted DMG contained no app bundle", log);
		const sourceApp = path.join(mountPoint, appEntry.name);
		if (!(await isExpectedBundle(sourceApp, command)))
			return failure(`the app bundle identifier was not ${COMMUNITY_APP_BUNDLE_ID}`, log);
		const executable = await readBundleValue(sourceApp, "CFBundleExecutable", command);
		if (!executable) return failure("the app bundle has no executable identity", log);
		const signature = await command(["/usr/bin/codesign", "--verify", "--deep", "--strict", sourceApp]);
		if (signature.exitCode !== 0) return failure("the app bundle signature could not be verified", log);
		const archCheck = await command([
			"/usr/bin/lipo",
			"-archs",
			path.join(sourceApp, "Contents", "MacOS", executable),
		]);
		if (archCheck.exitCode !== 0 || !archCheck.stdout.split(/\s+/).includes(arch))
			return failure(`the app bundle does not contain ${arch} code`, log);

		const destinationRoot = path.join(homeDir, "Applications");
		await fs.mkdir(destinationRoot, { recursive: true });
		const destination = path.join(destinationRoot, appEntry.name);
		try {
			await fs.access(destination, fs.constants.F_OK);
			return failure("the destination already contains an app bundle", log);
		} catch {
			// Expected: install only into a new destination.
		}
		const staging = path.join(destinationRoot, `.${appEntry.name}.gjc-${process.pid}`);
		await fs.rm(staging, { recursive: true, force: true });
		try {
			const copy = await command(["/usr/bin/ditto", sourceApp, staging]);
			if (copy.exitCode !== 0) return failure("copying the verified app bundle failed", log);
			await fs.rename(staging, destination);
			installedDestination = destination;
		} finally {
			await fs.rm(staging, { recursive: true, force: true });
		}
		const launch = await command(["/usr/bin/open", destination]);
		if (launch.exitCode !== 0) {
			await fs.rm(destination, { recursive: true, force: true });
			installedDestination = undefined;
			return failure("the verified app could not be launched; the partial app state was removed", log);
		}
		return { status: "installed", reason: destination };
	} catch (error) {
		if (installedDestination) await fs.rm(installedDestination, { recursive: true, force: true });
		return failure(error instanceof Error ? error.message : String(error), log);
	} finally {
		if (attached && mountPoint) await command(["/usr/bin/hdiutil", "detach", mountPoint, "-force"]);
		if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
	}
}

export function parseCommunityAppChecksumForTest(text: string, assetName: string): string | undefined {
	return parseChecksum(text, assetName);
}

export function communityAppAssetMatchesArchitectureForTest(name: string, arch: "arm64" | "x64"): boolean {
	return assetMatchesArchitecture(name, arch);
}
