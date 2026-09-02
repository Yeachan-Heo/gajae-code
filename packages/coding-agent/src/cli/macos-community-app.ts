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
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 120_000;
interface CommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	timedOut?: boolean;
	reaped?: boolean;
}
type CommandRunner = (argv: string[]) => Promise<CommandResult>;
const activeCommandControllers = new Set<AbortController>();

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

function trustedReleaseAssetUrl(value: string, expectedName: string, expectedTag: string): boolean {
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			url.origin === GITHUB_RELEASE_ORIGIN &&
			url.pathname.startsWith(`/${COMMUNITY_APP_REPOSITORY}/releases/download/${expectedTag}/`) &&
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

type FileIdentity = { dev: bigint; ino: bigint };

async function fileIdentity(filePath: string): Promise<FileIdentity | undefined> {
	const stat = await fs.lstat(filePath, { bigint: true }).catch(() => undefined);
	return stat?.isDirectory() ? { dev: stat.dev, ino: stat.ino } : undefined;
}

async function pathIdentity(filePath: string): Promise<FileIdentity | undefined> {
	const stat = await fs.lstat(filePath, { bigint: true }).catch(() => undefined);
	return stat ? { dev: stat.dev, ino: stat.ino } : undefined;
}

async function sameDirectoryIdentity(filePath: string, expected: FileIdentity): Promise<boolean> {
	const actual = await fileIdentity(filePath);
	return actual?.dev === expected.dev && actual.ino === expected.ino;
}

async function samePathIdentity(filePath: string, expected: FileIdentity): Promise<boolean> {
	const actual = await pathIdentity(filePath);
	return actual?.dev === expected.dev && actual.ino === expected.ino;
}

async function removeClaimedDirectory(
	filePath: string,
	identity: FileIdentity,
	parentPath: string,
	parentIdentity: FileIdentity,
	log: (message: string) => void,
): Promise<boolean> {
	if (!(await sameDirectoryIdentity(parentPath, parentIdentity)) || !(await sameDirectoryIdentity(filePath, identity)))
		return false;
	const quarantineRoot = path.join(parentPath, `.gjc-community-app-cleanup-${process.pid}-${Date.now().toString(16)}`);
	try {
		await fs.mkdir(quarantineRoot, { mode: 0o700 });
		const quarantineIdentity = await fileIdentity(quarantineRoot);
		if (!quarantineIdentity || !(await sameDirectoryIdentity(parentPath, parentIdentity))) return false;
		const tombstone = path.join(quarantineRoot, path.basename(filePath));
		await fs.rename(filePath, tombstone);
		if (
			!(await sameDirectoryIdentity(parentPath, parentIdentity)) ||
			!(await sameDirectoryIdentity(quarantineRoot, quarantineIdentity)) ||
			!(await sameDirectoryIdentity(tombstone, identity))
		) {
			log("Optional community app cleanup warning: claimed destination identity changed during removal");
			return false;
		}
		await fs.rm(tombstone, { recursive: true, force: true });
		if (await sameDirectoryIdentity(quarantineRoot, quarantineIdentity)) await fs.rm(quarantineRoot, { force: true });
		return true;
	} catch (error) {
		log(`Optional community app cleanup warning: failed to remove partial app state: ${String(error)}`);
		return false;
	}
}

async function runCommand(argv: string[]): Promise<CommandResult> {
	const controller = new AbortController();
	activeCommandControllers.add(controller);
	const child = Bun.spawn(argv, {
		stdout: "pipe",
		stderr: "pipe",
		signal: controller.signal,
		killSignal: "SIGTERM",
		detached: true,
	});
	const signalProcessGroup = (signal: NodeJS.Signals): void => {
		try {
			process.kill(-child.pid, signal);
		} catch {
			try {
				child.kill(signal);
			} catch {
				// The helper may have exited between cancellation and group signalling.
			}
		}
	};
	controller.signal.addEventListener("abort", () => signalProcessGroup("SIGTERM"), { once: true });
	const terminateAndReap = async (): Promise<boolean> => {
		signalProcessGroup("SIGKILL");
		return await Promise.race([child.exited.then(() => true), Bun.sleep(5000).then(() => false)]);
	};
	try {
		const outputPromise = Promise.all([
			readResponseText(new Response(child.stdout), MAX_COMMAND_OUTPUT_BYTES),
			readResponseText(new Response(child.stderr), MAX_COMMAND_OUTPUT_BYTES),
			child.exited,
		]);
		const timeout = Promise.withResolvers<boolean>();
		const timer: NodeJS.Timeout = setTimeout(() => {
			void terminateAndReap().then(reaped => timeout.resolve(reaped));
		}, COMMAND_TIMEOUT_MS);
		const output = await Promise.race([
			outputPromise
				.then(value => ({ kind: "output" as const, value }))
				.catch(error => ({ kind: "error" as const, error })),
			timeout.promise.then(reaped => ({ kind: "timeout" as const, reaped })),
		]);
		clearTimeout(timer);
		if (output.kind === "timeout") {
			await Promise.race([outputPromise.catch(() => undefined), Bun.sleep(5000)]);
			return {
				exitCode: 124,
				stdout: "",
				stderr: `command timed out: ${argv[0]}`,
				timedOut: true,
				reaped: output.reaped,
			};
		}
		if (output.kind === "error") {
			const reaped = await terminateAndReap();
			return { exitCode: 125, stdout: "", stderr: String(output.error), reaped };
		}
		const [stdout, stderr, exitCode] = output.value;
		return { exitCode, stdout, stderr, reaped: true };
	} finally {
		activeCommandControllers.delete(controller);
	}
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
	if (
		!(
			bundleStat?.isDirectory() &&
			contentsStat?.isDirectory() &&
			infoStat?.isFile() &&
			macOSRootStat?.isDirectory() &&
			!bundleStat.isSymbolicLink() &&
			!contentsStat.isSymbolicLink() &&
			!infoStat.isSymbolicLink() &&
			!macOSRootStat.isSymbolicLink()
		)
	)
		return false;
	const walk = async (directory: string): Promise<boolean> => {
		const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => undefined);
		if (!entries) return false;
		for (const entry of entries) {
			const entryPath = path.join(directory, entry.name);
			const stat = await fs.lstat(entryPath).catch(() => undefined);
			if (!stat) return false;
			if (stat.isSymbolicLink()) {
				const resolved = await fs.realpath(entryPath).catch(() => undefined);
				if (!resolved || (resolved !== bundleReal && !resolved.startsWith(`${bundleReal}${path.sep}`)))
					return false;
				continue;
			}
			if (stat.isDirectory() && !(await walk(entryPath))) return false;
		}
		return true;
	};
	return walk(bundlePath);
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

	let receivedSignal: NodeJS.Signals | undefined;
	let cleanupUnsafe = false;
	const rawCommand: CommandRunner = deps.command ?? runCommand;
	const command: CommandRunner = async argv => {
		if (receivedSignal) throw new Error(`interrupted by ${receivedSignal}`);
		const result = await rawCommand(argv);
		if (result.reaped === false) cleanupUnsafe = true;
		return result;
	};
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
	let tempRootIdentity: FileIdentity | undefined;
	let mountPoint: string | undefined;
	let mountIdentity: FileIdentity | undefined;
	let mountAttempted = false;
	let mountState: "none" | "unknown" | "attached" = "none";
	let installedDestination: { path: string; identity: FileIdentity } | undefined;
	let destinationRoot: string | undefined;
	let destinationRootIdentity: FileIdentity | undefined;
	const signalNames = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
	const signalHandlers = new Map<NodeJS.Signals, () => void>();
	const onSignal = (signal: NodeJS.Signals) => {
		receivedSignal = signal;
		for (const controller of activeCommandControllers) controller.abort();
	};
	for (const signal of signalNames) {
		const handler = () => onSignal(signal);
		signalHandlers.set(signal, handler);
		process.on(signal, handler);
	}
	const removeSignalHandlers = () => {
		for (const signal of signalNames) {
			const handler = signalHandlers.get(signal);
			if (handler) process.removeListener(signal, handler);
		}
	};
	const throwIfInterrupted = () => {
		if (receivedSignal) throw new Error(`community app offer interrupted by ${receivedSignal}`);
	};
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
		throwIfInterrupted();
		const tagVersion = releaseVersion(release.tag_name);
		if (!tagVersion || release.draft || release.prerelease || !release.assets?.length)
			return failure("no canonical published release is available", log);
		const dmg = release.assets.find(
			asset => asset.name.toLowerCase().endsWith(".dmg") && assetMatchesArchitecture(asset.name, arch, tagVersion),
		);
		if (!dmg || !trustedReleaseAssetUrl(dmg.browser_download_url, dmg.name, release.tag_name!))
			return failure(`no verified macOS ${arch} DMG is published`, log);
		const checksumAsset = release.assets.find(
			asset =>
				asset.name === `${dmg.name}.sha256` || (asset.name.endsWith(".sha256") && asset.name.includes(dmg.name)),
		);
		if (
			!checksumAsset ||
			!trustedReleaseAssetUrl(checksumAsset.browser_download_url, checksumAsset.name, release.tag_name!)
		)
			return failure("the release has no trusted DMG checksum", log);
		const [dmgResponse, checksumResponse] = await Promise.all([
			fetchImpl(dmg.browser_download_url, fetchOptions()),
			fetchImpl(checksumAsset.browser_download_url, fetchOptions()),
		]);
		if (!dmgResponse.ok || !checksumResponse.ok)
			return failure("the canonical release assets could not be downloaded", log);
		const dmgBytes = await readResponseBytes(dmgResponse, MAX_DMG_BYTES);
		const expected = parseChecksum(await readResponseText(checksumResponse, MAX_CHECKSUM_BYTES), dmg.name);
		throwIfInterrupted();
		if (!expected) return failure("the published checksum does not name the DMG", log);
		const actual = createHash("sha256").update(dmgBytes).digest("hex");
		if (actual !== expected) return failure("the DMG checksum did not match", log);

		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-community-app-"));
		tempRootIdentity = await fileIdentity(tempRoot);
		if (!tempRootIdentity) return failure("the temporary root was not a real directory", log);
		const dmgPath = path.join(tempRoot, dmg.name);
		mountPoint = path.join(tempRoot, "mount");
		if (!(await sameDirectoryIdentity(tempRoot, tempRootIdentity)))
			return failure("the temporary root identity changed", log);
		await fs.mkdir(mountPoint);
		const dmgHandle = await fs.open(dmgPath, "wx");
		try {
			await dmgHandle.writeFile(dmgBytes);
		} finally {
			await dmgHandle.close();
		}
		const stagedDmgStat = await fs.lstat(dmgPath).catch(() => undefined);
		if (!stagedDmgStat?.isFile() || stagedDmgStat.isSymbolicLink())
			return failure("the staged DMG path was unsafe", log);
		const stagedDmgIdentity: FileIdentity = { dev: BigInt(stagedDmgStat.dev), ino: BigInt(stagedDmgStat.ino) };
		if (!(await samePathIdentity(dmgPath, stagedDmgIdentity))) return failure("the staged DMG identity changed", log);
		if (!(await sameDirectoryIdentity(tempRoot, tempRootIdentity)))
			return failure("the temporary root identity changed before attach", log);
		throwIfInterrupted();
		const mountPointBeforeAttachIdentity = await fileIdentity(mountPoint);
		mountAttempted = true;
		mountState = "unknown";
		let attach: CommandResult;
		try {
			attach = await command([
				"/usr/bin/hdiutil",
				"attach",
				"-nobrowse",
				"-readonly",
				"-mountpoint",
				mountPoint,
				dmgPath,
			]);
		} catch (error) {
			const observedMountIdentity = await fileIdentity(mountPoint);
			const mountChanged =
				observedMountIdentity &&
				mountPointBeforeAttachIdentity &&
				(observedMountIdentity.dev !== mountPointBeforeAttachIdentity.dev ||
					observedMountIdentity.ino !== mountPointBeforeAttachIdentity.ino);
			mountIdentity = mountChanged ? observedMountIdentity : undefined;
			mountState = mountChanged
				? "attached"
				: observedMountIdentity && mountPointBeforeAttachIdentity
					? "none"
					: "unknown";
			throw error;
		}
		throwIfInterrupted();
		if (attach.reaped === false) {
			mountIdentity = undefined;
			mountState = "unknown";
			return failure("the DMG attachment helper did not terminate safely", log);
		}
		const observedMountIdentity = await fileIdentity(mountPoint);
		const mountChanged =
			observedMountIdentity &&
			mountPointBeforeAttachIdentity &&
			(observedMountIdentity.dev !== mountPointBeforeAttachIdentity.dev ||
				observedMountIdentity.ino !== mountPointBeforeAttachIdentity.ino);
		mountIdentity = attach.exitCode === 0 || mountChanged ? observedMountIdentity : undefined;
		mountState =
			attach.exitCode === 0
				? mountIdentity
					? "attached"
					: "unknown"
				: mountChanged
					? "attached"
					: observedMountIdentity && mountPointBeforeAttachIdentity
						? "none"
						: "unknown";
		if (attach.exitCode !== 0) return failure("the DMG could not be mounted safely", log);
		if (!mountIdentity) return failure("the mounted volume was not a real directory", log);
		if (!(await samePathIdentity(dmgPath, stagedDmgIdentity)))
			return failure("the staged DMG identity changed before verification", log);
		if (!(await sameDirectoryIdentity(mountPoint, mountIdentity)))
			return failure("the temporary mountpoint identity changed", log);
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
		if (!mountIdentity || !(await sameDirectoryIdentity(mountPoint, mountIdentity)))
			return failure("the mounted volume identity changed before copy", log);
		if (!(await isExpectedBundle(sourceApp, command)))
			return failure("the mounted app bundle identity changed before copy", log);

		destinationRoot = path.join(homeDir, "Applications");
		const currentDestinationRoot = destinationRoot;
		const existingDestinationRoot = await fs.lstat(currentDestinationRoot).catch(() => undefined);
		if (
			existingDestinationRoot &&
			(!existingDestinationRoot.isDirectory() || existingDestinationRoot.isSymbolicLink())
		)
			return failure("the Applications destination is not a real directory", log);
		await fs.mkdir(currentDestinationRoot, { recursive: true });
		const destinationRootStat = await fs.lstat(currentDestinationRoot);
		if (!destinationRootStat.isDirectory() || destinationRootStat.isSymbolicLink())
			return failure("the Applications destination is not a real directory", log);
		destinationRootIdentity = await fileIdentity(currentDestinationRoot);
		if (!destinationRootIdentity) return failure("the Applications destination identity was unavailable", log);
		const destination = path.join(currentDestinationRoot, appEntry.name);
		if (!(await sameDirectoryIdentity(currentDestinationRoot, destinationRootIdentity)))
			return failure("the Applications destination identity changed", log);
		throwIfInterrupted();
		try {
			await fs.mkdir(destination);
		} catch {
			return failure("the destination already contains an app bundle", log);
		}
		const destinationIdentity = await fileIdentity(destination);
		if (!destinationIdentity) throw new Error("the destination claim was not a regular directory");
		installedDestination = { path: destination, identity: destinationIdentity };
		if (
			!(await sameDirectoryIdentity(currentDestinationRoot, destinationRootIdentity)) ||
			!(await sameDirectoryIdentity(destination, destinationIdentity))
		)
			throw new Error("the destination identity changed before copy");
		throwIfInterrupted();
		if (!mountIdentity || !(await sameDirectoryIdentity(mountPoint, mountIdentity)))
			throw new Error("the mounted volume identity changed before copy");
		if (!(await isExpectedBundle(sourceApp, command))) throw new Error("the mounted app bundle changed before copy");
		const copy = await command(["/usr/bin/ditto", sourceApp, destination]);
		throwIfInterrupted();
		if (copy.reaped === false) {
			cleanupUnsafe = true;
			throw new Error("copy helper did not terminate safely");
		}
		if (copy.exitCode !== 0) throw new Error("copying the verified app bundle failed");
		if (
			!(await sameDirectoryIdentity(currentDestinationRoot, destinationRootIdentity)) ||
			!(await sameDirectoryIdentity(destination, destinationIdentity))
		)
			throw new Error("the destination identity changed after copy");
		if (!(await isExpectedBundle(destination, command))) throw new Error("the copied app bundle identity changed");
		const copiedExecutable = await readBundleValue(destination, "CFBundleExecutable", command);
		const copiedExecutablePath = copiedExecutable
			? await resolveVerifiedExecutable(destination, copiedExecutable)
			: undefined;
		if (!copiedExecutable || copiedExecutable !== executable || !copiedExecutablePath)
			throw new Error("the copied app executable identity changed");
		const copiedSignature = await command(["/usr/bin/codesign", "--verify", "--deep", "--strict", destination]);
		if (copiedSignature.reaped === false) {
			cleanupUnsafe = true;
			throw new Error("copied app signature helper did not terminate safely");
		}
		if (copiedSignature.exitCode !== 0) throw new Error("the copied app signature could not be verified");
		const copiedArchCheck = await command(["/usr/bin/lipo", "-archs", copiedExecutablePath]);
		if (copiedArchCheck.reaped === false) {
			cleanupUnsafe = true;
			throw new Error("copied app architecture helper did not terminate safely");
		}
		if (copiedArchCheck.exitCode !== 0 || !copiedArchCheck.stdout.split(/\s+/).includes(executableArch))
			throw new Error("the copied app architecture changed");
		if (
			!(await sameDirectoryIdentity(currentDestinationRoot, destinationRootIdentity)) ||
			!(await sameDirectoryIdentity(destination, destinationIdentity))
		)
			throw new Error("the destination identity changed before launch");
		throwIfInterrupted();
		const launch = await command(["/usr/bin/open", destination]);
		throwIfInterrupted();
		if (launch.reaped === false) {
			cleanupUnsafe = true;
			return failure(
				"the app launch helper did not terminate safely; partial app state was retained for safety",
				log,
			);
		}
		if (launch.exitCode !== 0) {
			let removed = false;
			if (
				tempRoot &&
				destinationRootIdentity &&
				(await sameDirectoryIdentity(destinationRoot, destinationRootIdentity)) &&
				(await sameDirectoryIdentity(destination, destinationIdentity))
			)
				removed = await removeClaimedDirectory(
					destination,
					destinationIdentity,
					destinationRoot,
					destinationRootIdentity,
					log,
				);
			installedDestination = undefined;
			return failure(
				removed
					? "the verified app could not be launched; the partial app state was removed"
					: "the verified app could not be launched; partial app state was retained for safety",
				log,
			);
		}
		return { status: "installed", reason: destination };
	} catch (error) {
		let partialState = installedDestination ? "retained for safety" : "not created";
		if (installedDestination) {
			try {
				if (
					destinationRoot &&
					tempRoot &&
					destinationRootIdentity &&
					(await sameDirectoryIdentity(destinationRoot, destinationRootIdentity)) &&
					(await sameDirectoryIdentity(installedDestination.path, installedDestination.identity)) &&
					!cleanupUnsafe
				) {
					const removed = await removeClaimedDirectory(
						installedDestination.path,
						installedDestination.identity,
						destinationRoot,
						destinationRootIdentity,
						log,
					);
					if (removed) partialState = "removed";
				}
			} catch (cleanupError) {
				log(`Optional community app cleanup warning: failed to remove partial app state: ${String(cleanupError)}`);
			}
		}
		return failure(
			`${error instanceof Error ? error.message : String(error)}; partial app state ${partialState}`,
			log,
		);
	} finally {
		let removeTempRoot = true;
		if (mountAttempted && mountPoint) {
			try {
				if (cleanupUnsafe) {
					removeTempRoot = false;
					log(
						"Optional community app cleanup warning: a native helper did not terminate safely; retaining temporary state",
					);
				} else if (
					mountState === "attached" &&
					mountIdentity &&
					!(await sameDirectoryIdentity(mountPoint, mountIdentity))
				) {
					removeTempRoot = false;
					log("Optional community app cleanup warning: mountpoint identity changed; refusing detach");
				} else if (mountState === "unknown") {
					removeTempRoot = false;
					log("Optional community app cleanup warning: mount identity was unavailable; refusing pathname detach");
				} else if (mountState === "none") {
					// The attach attempt completed without establishing a mount.
				} else {
					const detach = await rawCommand(["/usr/bin/hdiutil", "detach", mountPoint, "-force"]);
					if (detach.reaped === false) cleanupUnsafe = true;
					if (detach.reaped === false) {
						removeTempRoot = false;
						log("Optional community app cleanup warning: detach helper did not terminate safely");
					} else if (detach.exitCode !== 0) {
						removeTempRoot = false;
						log("Optional community app cleanup warning: hdiutil could not detach the temporary DMG");
					} else {
						mountState = "none";
					}
				}
			} catch (error) {
				if (mountState !== "none") removeTempRoot = false;
				log(`Optional community app cleanup warning: failed to detach the temporary DMG: ${String(error)}`);
			}
		}
		if (removeTempRoot && tempRoot && tempRootIdentity && (await sameDirectoryIdentity(tempRoot, tempRootIdentity))) {
			try {
				await fs.rm(tempRoot, { recursive: true, force: true });
			} catch (error) {
				log(`Optional community app cleanup warning: failed to remove temporary files: ${String(error)}`);
			}
		} else if (tempRoot) {
			log("Optional community app cleanup warning: temporary root identity changed; refusing recursive removal");
		}
		removeSignalHandlers();
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

export async function runCommunityAppCommandForTest(
	argv: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	return runCommand(argv);
}
