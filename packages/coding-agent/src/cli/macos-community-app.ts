import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import type { Process as NativeProcess } from "@gajae-code/natives";
import { nativeProcessBindings } from "@gajae-code/utils/native-process";
import * as postmortem from "@gajae-code/utils/postmortem";

export const COMMUNITY_APP_REPOSITORY = "devswha/gajae-code-app";
export const COMMUNITY_APP_BUNDLE_ID = "app.gajae.desktop";
export const COMMUNITY_APP_TEAM_ID = "5987KT43TJ";
export const COMMUNITY_APP_SIGNING_AUTHORITY = "Developer ID Application: sangwoo ha";
export const COMMUNITY_APP_SUPPRESS_ENV = "GJC_NO_COMMUNITY_APP";
const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_RELEASE_ORIGIN = "https://github.com";
const MAX_DMG_BYTES = 512 * 1024 * 1024;
const MAX_RELEASE_BYTES = 1024 * 1024;
const MAX_CHECKSUM_BYTES = 128 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const METADATA_FETCH_TIMEOUT_MS = 30_000;
const ASSET_FETCH_TIMEOUT_MS = 10 * 60_000;
const COMMAND_TIMEOUT_MS = 120_000;
const CLEANUP_COMMAND_TIMEOUT_MS = 1_000;
const HELPER_REAP_TIMEOUT_MS = 750;
const HELPER_REAP_POLL_ATTEMPTS = 10;
const HELPER_OUTPUT_SETTLE_GRACE_MS = 250;
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
	signal?: AbortSignal;
	fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
	prompt?: () => Promise<boolean>;
	command?: CommandRunner;
	cleanupCommand?: CommandRunner;
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

async function writeResponseToFileAndHash(
	response: Response,
	handle: fs.FileHandle,
	maxBytes: number,
): Promise<string> {
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		throw new Error(`DMG exceeds the ${maxBytes} byte safety limit`);
	}
	const hash = createHash("sha256");
	let total = 0;
	const writeChunk = async (chunk: Uint8Array): Promise<void> => {
		total += chunk.byteLength;
		if (total > maxBytes) throw new Error(`DMG exceeds the ${maxBytes} byte safety limit`);
		hash.update(chunk);
		let offset = 0;
		while (offset < chunk.byteLength) {
			const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset, null);
			if (bytesWritten === 0) throw new Error("DMG staging write made no progress");
			offset += bytesWritten;
		}
	};
	if (!response.body) {
		await writeChunk(new Uint8Array(await response.arrayBuffer()));
		return hash.digest("hex");
	}
	const reader = response.body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value) await writeChunk(value);
		}
	} catch (error) {
		await reader.cancel().catch(() => undefined);
		throw error;
	} finally {
		reader.releaseLock();
	}
	return hash.digest("hex");
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
	if (!(await sameDirectoryIdentity(parentPath, parentIdentity))) {
		log("Optional community app cleanup warning: parent identity changed before removal");
		return false;
	}
	if (!(await sameDirectoryIdentity(filePath, identity))) {
		log("Optional community app cleanup warning: claimed directory identity changed before removal");
		return false;
	}
	const quarantineRoot = path.join(parentPath, `.gjc-community-app-cleanup-${process.pid}-${Date.now().toString(16)}`);
	try {
		await fs.mkdir(quarantineRoot, { mode: 0o700 });
		const quarantineIdentity = await fileIdentity(quarantineRoot);
		if (!quarantineIdentity || !(await sameDirectoryIdentity(parentPath, parentIdentity))) {
			log("Optional community app cleanup warning: quarantine identity changed before removal");
			return false;
		}
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
		if (await sameDirectoryIdentity(quarantineRoot, quarantineIdentity))
			await fs.rm(quarantineRoot, { force: true, recursive: true });
		return true;
	} catch (error) {
		log(`Optional community app cleanup warning: failed to remove partial app state: ${String(error)}`);
		return false;
	}
}

async function runCommand(argv: string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<CommandResult> {
	const controller = new AbortController();
	activeCommandControllers.add(controller);
	const child = Bun.spawn(argv, {
		stdout: "pipe",
		stderr: "pipe",
		signal: controller.signal,
		killSignal: "SIGTERM",
		detached: true,
	});
	const waitForSpawnGroupGone = async (): Promise<boolean> => {
		for (let attempt = 0; attempt < HELPER_REAP_POLL_ATTEMPTS; attempt++) {
			try {
				process.kill(-child.pid, 0);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
			}
			await Bun.sleep(50);
		}
		return false;
	};
	const processRef = nativeProcessBindings().Process.fromPid(child.pid);
	if (!processRef) {
		child.kill("SIGKILL");
		await Promise.race([child.exited.catch(() => undefined), Bun.sleep(500)]);
		const reaped = await waitForSpawnGroupGone();
		activeCommandControllers.delete(controller);
		return {
			exitCode: 125,
			stdout: "",
			stderr: `could not bind helper process identity: ${argv[0]}`,
			reaped,
		};
	}
	const descendants = new Map<string, NativeProcess>();
	const captureDescendants = (parent: NativeProcess): void => {
		for (const descendant of parent.children()) {
			descendants.set(descendant.incarnation, descendant);
			captureDescendants(descendant);
		}
	};
	let trackingDescendants = true;
	const descendantTracker = (async () => {
		while (trackingDescendants) {
			captureDescendants(processRef);
			await Bun.sleep(25);
		}
		captureDescendants(processRef);
	})();
	let terminationPromise: Promise<boolean> | undefined;
	const terminateAndReap = (gracefulMs: number): Promise<boolean> => {
		if (!terminationPromise) {
			terminationPromise = (async () => {
				captureDescendants(processRef);
				const rootExited = await processRef.terminate({
					group: false,
					gracefulMs,
					timeoutMs: HELPER_REAP_TIMEOUT_MS,
				});
				const descendantResults = await Promise.all(
					[...descendants.values()].map(descendant =>
						descendant.terminate({ gracefulMs: -1, timeoutMs: HELPER_REAP_TIMEOUT_MS }),
					),
				);
				return rootExited && descendantResults.every(Boolean) && (await waitForSpawnGroupGone());
			})();
		}
		return terminationPromise;
	};
	controller.signal.addEventListener(
		"abort",
		() => {
			void terminateAndReap(500);
		},
		{ once: true },
	);
	try {
		const childExit = child.exited.then(
			code => ({ code, reaped: true }),
			() => ({ code: 125, reaped: false }),
		);
		const outputPromise = Promise.all([
			readResponseText(new Response(child.stdout), MAX_COMMAND_OUTPUT_BYTES),
			readResponseText(new Response(child.stderr), MAX_COMMAND_OUTPUT_BYTES),
			childExit,
		]);
		const timeout = Promise.withResolvers<boolean>();
		const timer: NodeJS.Timeout = setTimeout(() => {
			void terminateAndReap(500).then(reaped => timeout.resolve(reaped));
		}, timeoutMs);
		const output = await Promise.race([
			outputPromise
				.then(value => ({ kind: "output" as const, value }))
				.catch(error => ({ kind: "error" as const, error })),
			timeout.promise.then(reaped => ({ kind: "timeout" as const, reaped })),
		]);
		clearTimeout(timer);
		if (output.kind === "timeout") {
			await Promise.race([outputPromise.catch(() => undefined), Bun.sleep(HELPER_OUTPUT_SETTLE_GRACE_MS)]);
			return {
				exitCode: 124,
				stdout: "",
				stderr: `command timed out: ${argv[0]}`,
				timedOut: true,
				reaped: output.reaped,
			};
		}
		if (output.kind === "error") {
			const reaped = await terminateAndReap(-1);
			return { exitCode: 125, stdout: "", stderr: String(output.error), reaped };
		}
		const [stdout, stderr, childResult] = output.value;
		const reaped = childResult.reaped && (await terminateAndReap(0));
		return {
			exitCode: childResult.code,
			stdout,
			stderr,
			reaped,
		};
	} finally {
		trackingDescendants = false;
		await descendantTracker;
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
				const linkTarget = await fs.readlink(entryPath).catch(() => undefined);
				if (!linkTarget || path.isAbsolute(linkTarget)) return false;
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

async function hasExpectedDeveloperIdSignature(bundlePath: string, command: CommandRunner): Promise<boolean> {
	const result = await command(["/usr/bin/codesign", "--display", "--verbose=4", bundlePath]);
	if (result.exitCode !== 0 || result.reaped === false) return false;
	const details = `${result.stdout}\n${result.stderr}`;
	return (
		details.includes(`Authority=${COMMUNITY_APP_SIGNING_AUTHORITY}`) &&
		details.includes(`TeamIdentifier=${COMMUNITY_APP_TEAM_ID}`)
	);
}

async function isVerifiedCommunityApp(
	bundlePath: string,
	arch: "arm64" | "x64",
	command: CommandRunner,
): Promise<boolean> {
	if (!(await isExpectedBundle(bundlePath, command))) return false;
	const executable = await readBundleValue(bundlePath, "CFBundleExecutable", command);
	const executablePath = executable ? await resolveVerifiedExecutable(bundlePath, executable) : undefined;
	if (!executablePath) return false;
	const signature = await command(["/usr/bin/codesign", "--verify", "--deep", "--strict", bundlePath]);
	if (signature.exitCode !== 0 || signature.reaped === false) return false;
	if (!(await hasExpectedDeveloperIdSignature(bundlePath, command))) return false;
	const policyAssessment = await command(["/usr/sbin/spctl", "--assess", "--type", "execute", bundlePath]);
	if (policyAssessment.exitCode !== 0 || policyAssessment.reaped === false) return false;
	const archCheck = await command(["/usr/bin/lipo", "-archs", executablePath]);
	const executableArch = arch === "x64" ? "x86_64" : arch;
	return (
		archCheck.exitCode === 0 && archCheck.reaped !== false && archCheck.stdout.split(/\s+/).includes(executableArch)
	);
}

async function findInstalledApp(
	homeDir: string,
	arch: "arm64" | "x64",
	command: CommandRunner,
): Promise<string | undefined> {
	const candidates = [
		path.join(homeDir, "Applications", "Gajae Code App.app"),
		path.join(homeDir, "Applications", "Gajae-Code-App.app"),
		"/Applications/Gajae Code App.app",
		"/Applications/Gajae-Code-App.app",
	];
	for (const candidate of candidates) {
		if (await isVerifiedCommunityApp(candidate, arch, command)) return candidate;
	}
	const result = await command(["/usr/bin/mdfind", `kMDItemCFBundleIdentifier == '${COMMUNITY_APP_BUNDLE_ID}'`]);
	if (result.exitCode !== 0) return undefined;
	for (const candidate of result.stdout
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(Boolean)) {
		if (await isVerifiedCommunityApp(candidate, arch, command)) return candidate;
	}
	return undefined;
}

async function defaultPrompt(signal?: AbortSignal): Promise<boolean> {
	const readline = createInterface({ input: process.stdin, output: process.stdout });
	const interrupted = Promise.withResolvers<string>();
	const onAbort = () => {
		readline.close();
		interrupted.reject(new Error("community app offer interrupted"));
	};
	if (signal?.aborted) onAbort();
	else signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const answer = await Promise.race([
			readline.question("Install Gajae Code App (experimental, community-built)? [y/N] "),
			interrupted.promise,
		]);
		return /^y(?:es)?$/i.test(answer.trim());
	} finally {
		signal?.removeEventListener("abort", onAbort);
		readline.close();
	}
}

function failure(reason: string, log: (message: string) => void): CommunityAppOfferResult {
	log(`Optional community app offer unavailable: ${reason}. See https://github.com/${COMMUNITY_APP_REPOSITORY}`);
	return { status: "failed", reason };
}

function environmentFlagEnabled(value: string | undefined): boolean {
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	return normalized !== "0" && normalized !== "false" && normalized !== "no" && normalized !== "off";
}

function signalExitCode(signal: "SIGINT" | "SIGTERM" | "SIGHUP"): number {
	switch (signal) {
		case "SIGINT":
			return 130;
		case "SIGTERM":
			return 143;
		case "SIGHUP":
			return 129;
	}
}

export async function offerMacosCommunityApp(
	deps: CommunityAppOfferDependencies = {},
): Promise<CommunityAppOfferResult> {
	const platform = deps.platform ?? process.platform;
	const env = deps.env ?? process.env;
	const log = deps.log ?? (() => undefined);
	if (platform !== "darwin") return { status: "skipped", reason: "unsupported platform" };
	if (env[COMMUNITY_APP_SUPPRESS_ENV] === "1" || env[COMMUNITY_APP_SUPPRESS_ENV]?.toLowerCase() === "true") {
		return { status: "skipped", reason: "suppressed by environment" };
	}
	if (
		environmentFlagEnabled(env.CI) ||
		environmentFlagEnabled(env.GITHUB_ACTIONS) ||
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

	let receivedSignal: "SIGINT" | "SIGTERM" | "SIGHUP" | undefined;
	let cleanupUnsafe = false;
	const providedCommand = deps.command;
	const rawCommand: CommandRunner = providedCommand ?? runCommand;
	const cleanupCommand: CommandRunner = deps.cleanupCommand ?? (argv => runCommand(argv, CLEANUP_COMMAND_TIMEOUT_MS));
	const command: CommandRunner = async argv => {
		if (receivedSignal) throw new Error(`interrupted by ${receivedSignal}`);
		const result = await rawCommand(argv);
		if (result.reaped === false) cleanupUnsafe = true;
		return result;
	};
	const signalNames = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
	const signalHandlers = new Map<NodeJS.Signals, () => void>();
	const offerSettled = Promise.withResolvers<void>();
	const fetchAbortController = new AbortController();
	const fetchAbortSignal = deps.signal
		? AbortSignal.any([deps.signal, fetchAbortController.signal])
		: fetchAbortController.signal;
	const onSignal = (signal: "SIGINT" | "SIGTERM" | "SIGHUP") => {
		receivedSignal = signal;
		fetchAbortController.abort();
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
	const unregisterPostmortemCleanup = postmortem.register("macos-community-app-offer", async reason => {
		if (reason === postmortem.Reason.SIGINT) onSignal("SIGINT");
		else if (reason === postmortem.Reason.SIGTERM) onSignal("SIGTERM");
		else if (reason === postmortem.Reason.SIGHUP) onSignal("SIGHUP");
		await offerSettled.promise;
	});
	const finishOwnership = (result: CommunityAppOfferResult): CommunityAppOfferResult => {
		offerSettled.resolve();
		unregisterPostmortemCleanup();
		removeSignalHandlers();
		if (receivedSignal) process.exitCode = signalExitCode(receivedSignal);
		return result;
	};
	const homeDir = deps.homeDir ?? os.homedir();
	const arch = deps.arch ?? process.arch;
	if (!isMacArchitecture(arch)) return finishOwnership(failure(`unsupported macOS architecture ${arch}`, log));
	try {
		if (await findInstalledApp(homeDir, arch, command))
			return finishOwnership({ status: "skipped", reason: "already installed" });
		if (!(await (deps.prompt ?? (() => defaultPrompt(fetchAbortSignal)))()))
			return finishOwnership({ status: "skipped", reason: "cancelled" });
	} catch (error) {
		return finishOwnership(failure(error instanceof Error ? error.message : String(error), log));
	}

	const fetchImpl = deps.fetchImpl ?? fetch;
	const fetchOptions = (timeoutMs: number): RequestInit => ({
		signal: AbortSignal.any([fetchAbortSignal, AbortSignal.timeout(timeoutMs)]),
	});
	let tempRoot: string | undefined;
	let tempRootIdentity: FileIdentity | undefined;
	let mountPoint: string | undefined;
	let mountIdentity: FileIdentity | undefined;
	let mountAttempted = false;
	let mountState: "none" | "unknown" | "attached" = "none";
	let installedDestination: { path: string; identity: FileIdentity } | undefined;
	let destinationRoot: string | undefined;
	let destinationRootIdentity: FileIdentity | undefined;
	const throwIfInterrupted = () => {
		if (receivedSignal) throw new Error(`community app offer interrupted by ${receivedSignal}`);
		if (fetchAbortSignal.aborted) throw new Error("community app offer interrupted");
	};
	try {
		const releaseResponse = await fetchImpl(
			`${GITHUB_API_ORIGIN}/repos/${COMMUNITY_APP_REPOSITORY}/releases?per_page=20`,
			{
				headers: {
					Accept: "application/vnd.github+json",
					"User-Agent": "gjc-community-app-offer",
					"X-GitHub-Api-Version": "2022-11-28",
				},
				signal: fetchOptions(METADATA_FETCH_TIMEOUT_MS).signal,
			},
		);
		if (!releaseResponse.ok)
			return failure(`no canonical published release is available (HTTP ${releaseResponse.status})`, log);
		const payload = JSON.parse(await readResponseText(releaseResponse, MAX_RELEASE_BYTES)) as
			| ReleasePayload
			| ReleasePayload[];
		const releases = Array.isArray(payload) ? payload : [payload];
		throwIfInterrupted();
		const release = releases.find(candidate => {
			const tagVersion = releaseVersion(candidate.tag_name);
			return Boolean(tagVersion && !candidate.draft && candidate.assets?.length);
		});
		if (!release) return failure("no canonical published release is available", log);
		const tagVersion = releaseVersion(release.tag_name);
		if (!tagVersion || !release.assets?.length) return failure("no canonical published release is available", log);
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
			fetchImpl(dmg.browser_download_url, fetchOptions(ASSET_FETCH_TIMEOUT_MS)),
			fetchImpl(checksumAsset.browser_download_url, fetchOptions(METADATA_FETCH_TIMEOUT_MS)),
		]);
		if (!dmgResponse.ok || !checksumResponse.ok)
			return failure("the canonical release assets could not be downloaded", log);
		const expected = parseChecksum(await readResponseText(checksumResponse, MAX_CHECKSUM_BYTES), dmg.name);
		throwIfInterrupted();
		if (!expected) return failure("the published checksum does not name the DMG", log);

		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-community-app-"));
		tempRootIdentity = await fileIdentity(tempRoot);
		if (!tempRootIdentity) return failure("the temporary root was not a real directory", log);
		const dmgPath = path.join(tempRoot, dmg.name);
		mountPoint = path.join(tempRoot, "mount");
		if (!(await sameDirectoryIdentity(tempRoot, tempRootIdentity)))
			return failure("the temporary root identity changed", log);
		await fs.mkdir(mountPoint);
		const dmgHandle = await fs.open(dmgPath, "wx");
		let actual: string;
		try {
			actual = await writeResponseToFileAndHash(dmgResponse, dmgHandle, MAX_DMG_BYTES);
		} finally {
			await dmgHandle.close();
		}
		if (actual !== expected) return failure("the DMG checksum did not match", log);
		const stagedDmgStat = await fs.lstat(dmgPath, { bigint: true }).catch(() => undefined);
		if (!stagedDmgStat?.isFile() || stagedDmgStat.isSymbolicLink())
			return failure("the staged DMG path was unsafe", log);
		const stagedDmgIdentity: FileIdentity = { dev: stagedDmgStat.dev, ino: stagedDmgStat.ino };
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
		throwIfInterrupted();
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
		if (signature.exitCode !== 0 || signature.reaped === false)
			return failure("the app bundle signature could not be verified", log);
		if (!(await hasExpectedDeveloperIdSignature(sourceApp, command)))
			return failure("the app bundle was signed by an unexpected publisher", log);
		const policyAssessment = await command(["/usr/sbin/spctl", "--assess", "--type", "execute", sourceApp]);
		if (policyAssessment.reaped === false) {
			cleanupUnsafe = true;
			return failure("Gatekeeper helper did not terminate safely", log);
		}
		if (policyAssessment.exitCode !== 0) return failure("Gatekeeper rejected the app bundle", log);
		const archCheck = await command(["/usr/bin/lipo", "-archs", executablePath]);
		const executableArch = arch === "x64" ? "x86_64" : arch;
		if (archCheck.reaped === false) {
			cleanupUnsafe = true;
			return failure("architecture helper did not terminate safely", log);
		}
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
		const existingDestination = await fs.lstat(destination).catch(() => undefined);
		if (existingDestination && (!existingDestination.isDirectory() || existingDestination.isSymbolicLink()))
			return failure("the destination already contains an unsafe path", log);
		const existingDestinationIdentity = existingDestination ? await fileIdentity(destination) : undefined;
		if (existingDestination && !existingDestinationIdentity)
			return failure("the existing destination identity was unavailable", log);
		const stagingDestination = path.join(currentDestinationRoot, `.${appEntry.name}.${randomUUID()}.tmp`);
		await fs.mkdir(stagingDestination);
		const stagingIdentity = await fileIdentity(stagingDestination);
		if (!stagingIdentity) throw new Error("the staging destination claim was not a regular directory");
		installedDestination = { path: stagingDestination, identity: stagingIdentity };
		if (
			!(await sameDirectoryIdentity(currentDestinationRoot, destinationRootIdentity)) ||
			!(await sameDirectoryIdentity(stagingDestination, stagingIdentity))
		)
			throw new Error("the staging destination identity changed before copy");
		throwIfInterrupted();
		if (!mountIdentity || !(await sameDirectoryIdentity(mountPoint, mountIdentity)))
			throw new Error("the mounted volume identity changed before copy");
		if (!(await isExpectedBundle(sourceApp, command))) throw new Error("the mounted app bundle changed before copy");
		const copy = await command(["/usr/bin/ditto", sourceApp, stagingDestination]);
		throwIfInterrupted();
		if (copy.reaped === false) {
			cleanupUnsafe = true;
			throw new Error("copy helper did not terminate safely");
		}
		if (copy.exitCode !== 0) throw new Error("copying the verified app bundle failed");
		if (
			!(await sameDirectoryIdentity(currentDestinationRoot, destinationRootIdentity)) ||
			!(await sameDirectoryIdentity(stagingDestination, stagingIdentity))
		)
			throw new Error("the staging destination identity changed after copy");
		if (!(await isExpectedBundle(stagingDestination, command)))
			throw new Error("the copied app bundle identity changed");
		const copiedExecutable = await readBundleValue(stagingDestination, "CFBundleExecutable", command);
		const copiedExecutablePath = copiedExecutable
			? await resolveVerifiedExecutable(stagingDestination, copiedExecutable)
			: undefined;
		if (!copiedExecutable || copiedExecutable !== executable || !copiedExecutablePath)
			throw new Error("the copied app executable identity changed");
		const copiedSignature = await command([
			"/usr/bin/codesign",
			"--verify",
			"--deep",
			"--strict",
			stagingDestination,
		]);
		if (copiedSignature.reaped === false) {
			cleanupUnsafe = true;
			throw new Error("copied app signature helper did not terminate safely");
		}
		if (copiedSignature.exitCode !== 0) throw new Error("the copied app signature could not be verified");
		if (!(await hasExpectedDeveloperIdSignature(stagingDestination, command)))
			throw new Error("the copied app was signed by an unexpected publisher");
		const copiedPolicyAssessment = await command([
			"/usr/sbin/spctl",
			"--assess",
			"--type",
			"execute",
			stagingDestination,
		]);
		if (copiedPolicyAssessment.reaped === false) {
			cleanupUnsafe = true;
			throw new Error("copied app Gatekeeper helper did not terminate safely");
		}
		if (copiedPolicyAssessment.exitCode !== 0) throw new Error("Gatekeeper rejected the copied app bundle");
		const copiedArchCheck = await command(["/usr/bin/lipo", "-archs", copiedExecutablePath]);
		if (copiedArchCheck.reaped === false) {
			cleanupUnsafe = true;
			throw new Error("copied app architecture helper did not terminate safely");
		}
		if (copiedArchCheck.exitCode !== 0 || !copiedArchCheck.stdout.split(/\s+/).includes(executableArch))
			throw new Error("the copied app architecture changed");
		const currentExistingDestination = await fs.lstat(destination).catch(() => undefined);
		if (
			currentExistingDestination &&
			(!currentExistingDestination.isDirectory() || currentExistingDestination.isSymbolicLink())
		)
			throw new Error("the destination changed to an unsafe path before replacement");
		const currentExistingDestinationIdentity = currentExistingDestination
			? await fileIdentity(destination)
			: undefined;
		if (
			existingDestinationIdentity
				? !currentExistingDestinationIdentity ||
					currentExistingDestinationIdentity.dev !== existingDestinationIdentity.dev ||
					currentExistingDestinationIdentity.ino !== existingDestinationIdentity.ino
				: currentExistingDestinationIdentity
		)
			throw new Error("the existing destination identity changed before replacement");
		if (currentExistingDestinationIdentity) {
			if (!(await sameDirectoryIdentity(destination, currentExistingDestinationIdentity)))
				throw new Error("the existing destination identity changed before replacement");
			if (await isVerifiedCommunityApp(destination, arch, command)) {
				try {
					const stagedRemoved = await removeClaimedDirectory(
						stagingDestination,
						stagingIdentity,
						currentDestinationRoot,
						destinationRootIdentity,
						log,
					);
					if (!stagedRemoved)
						throw new Error(
							"the staged app bundle could not be removed after detecting an existing verified installation",
						);
				} catch (error) {
					throw new Error(
						`concurrent verified installation detected but staged bundle cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				installedDestination = undefined;
				return { status: "skipped", reason: "already installed" };
			}
			const removed = await removeClaimedDirectory(
				destination,
				currentExistingDestinationIdentity,
				currentDestinationRoot,
				destinationRootIdentity,
				log,
			);
			if (!removed) throw new Error("the existing app bundle could not be replaced safely");
		}
		await fs.rename(stagingDestination, destination);
		const destinationIdentity = await fileIdentity(destination);
		if (!destinationIdentity) throw new Error("the installed destination identity was unavailable");
		installedDestination = { path: destination, identity: destinationIdentity };
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
					const detach = await cleanupCommand(["/usr/bin/hdiutil", "detach", mountPoint, "-force"]);
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
		offerSettled.resolve();
		unregisterPostmortemCleanup();
		removeSignalHandlers();
		if (receivedSignal) process.exitCode = signalExitCode(receivedSignal);
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
): Promise<{ exitCode: number; stdout: string; stderr: string; reaped?: boolean }> {
	return runCommand(argv);
}

export function abortActiveCommunityAppCommandsForTest(): void {
	for (const controller of activeCommandControllers) controller.abort();
}
