import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@gajae-code/utils";
import type { Subprocess } from "bun";
import type { Browser, CDPSession } from "puppeteer-core";
import { ToolAbortError, ToolError } from "../tool-errors";
import {
	findFreeCdpPort,
	findReusableCdp,
	findRunningChromeProfile,
	gracefulKillTreeOnce,
	killExistingByPath,
	waitForCdp,
} from "./attach";
import { BROWSER_PROTOCOL_TIMEOUT_MS, launchHeadlessBrowser, loadPuppeteer, type UserAgentOverride } from "./launch";
import { defaultDiscoveryEnv } from "./profile-discovery";
import type { ProfileReusePosture } from "./profile-posture";
import { resolveProfileReuse } from "./profile-reuse";

export type BrowserKind =
	| { kind: "headless"; headless: boolean }
	| { kind: "spawned"; path: string }
	| {
			kind: "chrome-profile";
			path: string;
			userDataDir: string;
			profileDirectory: string;
			background: boolean;
			noFocus: boolean;
			cdpPort?: number;
	  }
	| { kind: "connected"; cdpUrl: string };

export type BrowserKindTag = BrowserKind["kind"];

export interface BrowserHandle {
	key: string;
	kind: BrowserKind;
	browser: Browser;
	cdpUrl?: string;
	pid?: number;
	subprocess?: Subprocess;
	refCount: number;
	stealth: { browserSession: CDPSession | null; override: UserAgentOverride | null };
}

type SpawnedChromeProfileKind = Extract<BrowserKind, { kind: "chrome-profile" }>;

const browsers = new Map<string, BrowserHandle>();

/**
 * Upper bound on the CDP `browser.close()` round-trip during a forced (signal-path)
 * teardown before we fall back to killing the Chrome process tree. Only applies when
 * `kill` is set; graceful release still awaits close() unbounded.
 */
const HEADLESS_FORCE_CLOSE_GRACE_MS = 1_500;

function browserKey(kind: BrowserKind): string {
	switch (kind.kind) {
		case "headless":
			return `headless:${kind.headless ? "1" : "0"}`;
		case "spawned":
			return `spawned:${kind.path}`;
		case "chrome-profile":
			return `chrome-profile:${kind.path}:${kind.userDataDir}:${kind.profileDirectory}:${kind.cdpPort ?? 0}`;
		case "connected":
			return `connected:${kind.cdpUrl}`;
	}
}

export interface AcquireBrowserOptions {
	cwd: string;
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
	appArgs?: string[];
	signal?: AbortSignal;
	/**
	 * Profile-reuse posture for the default headless path (from settings
	 * `browser.profileReuse`, resolved by the settings-aware caller). When set,
	 * the headless browser may warm up from an isolated copy of the user's real
	 * Chrome profile (see profile-reuse.ts). Omitted = synthetic session.
	 */
	profileReuse?: ProfileReusePosture;
}

export async function acquireBrowser(kind: BrowserKind, opts: AcquireBrowserOptions): Promise<BrowserHandle> {
	const key = browserKey(kind);
	const existing = browsers.get(key);
	if (existing) {
		if (existing.browser.connected) return existing;
		browsers.delete(key);
		await disposeBrowserHandle(existing, { kill: false });
	}

	const handle = await openBrowserHandle(kind, opts);
	browsers.set(key, handle);
	return handle;
}

async function openBrowserHandle(kind: BrowserKind, opts: AcquireBrowserOptions): Promise<BrowserHandle> {
	if (kind.kind === "headless") {
		let profileWarmupDir: string | undefined;
		if (opts.profileReuse) {
			const reuse = resolveProfileReuse({
				posture: opts.profileReuse,
				discoveryEnv: defaultDiscoveryEnv(fs.existsSync),
			});
			if (reuse.mode === "real" && reuse.warmupDir) {
				profileWarmupDir = reuse.warmupDir;
				if (reuse.warning) logger.warn(reuse.warning);
			}
		}
		const browser = await launchHeadlessBrowser({
			headless: kind.headless,
			viewport: opts.viewport,
			profileWarmupDir,
		});
		return {
			key: browserKey(kind),
			kind,
			browser,
			refCount: 0,
			stealth: { browserSession: null, override: null },
		};
	}
	if (kind.kind === "connected") {
		const cdpUrl = kind.cdpUrl.replace(/\/+$/, "");
		await waitForCdp(cdpUrl, 5_000, opts.signal);
		const puppeteer = await loadPuppeteer();
		const browser = await puppeteer.connect({
			browserURL: cdpUrl,
			defaultViewport: null,
			protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
		});
		return {
			key: browserKey(kind),
			kind,
			browser,
			cdpUrl,
			refCount: 0,
			stealth: { browserSession: null, override: null },
		};
	}
	if (kind.kind === "chrome-profile") {
		return await openChromeProfileHandle(kind, opts);
	}

	return await openSpawnedBrowserHandle(kind, opts);
}

const CHROME_PROFILE_LOCK_FILES = ["SingletonLock", "SingletonSocket", "SingletonCookie"] as const;

async function hasChromeProfileLock(userDataDir: string): Promise<boolean> {
	for (const lockFile of CHROME_PROFILE_LOCK_FILES) {
		if (await Bun.file(path.join(userDataDir, lockFile)).exists()) return true;
	}
	return false;
}

const CHROME_PROFILE_MANAGED_FLAGS = new Set([
	"--user-data-dir",
	"--profile-directory",
	"--remote-debugging-address",
	"--remote-debugging-port",
]);

function filterChromeProfileAppArgs(appArgs: readonly string[] | undefined): string[] {
	if (!appArgs?.length) return [];
	const filtered: string[] = [];
	for (let i = 0; i < appArgs.length; i++) {
		const arg = appArgs[i]!;
		const flagName = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
		if (CHROME_PROFILE_MANAGED_FLAGS.has(flagName)) {
			if (!arg.includes("=") && i < appArgs.length - 1) i++;
			continue;
		}
		filtered.push(arg);
	}
	return filtered;
}

export function buildChromeProfileLaunchArgs(
	kind: SpawnedChromeProfileKind,
	appArgs: readonly string[] | undefined,
	port: number,
): string[] {
	const args = [
		...filterChromeProfileAppArgs(appArgs),
		`--user-data-dir=${kind.userDataDir}`,
		`--profile-directory=${kind.profileDirectory}`,
		`--remote-debugging-port=${port}`,
		"--remote-debugging-address=127.0.0.1",
	];
	if (kind.background || kind.noFocus) args.push("--no-startup-window");
	return args;
}

export function buildChromeProfileLaunchArgsForTest(
	kind: SpawnedChromeProfileKind,
	appArgs: readonly string[] | undefined,
	port: number,
): string[] {
	return buildChromeProfileLaunchArgs(kind, appArgs, port);
}

export async function openChromeProfileHandle(
	kind: SpawnedChromeProfileKind,
	opts: AcquireBrowserOptions,
): Promise<BrowserHandle> {
	const exe = kind.path;
	if (!path.isAbsolute(exe)) {
		throw new ToolError(
			`app.path must be absolute for app.browser="chrome" (got ${JSON.stringify(exe)}). Pass the Chrome binary path, not the .app bundle.`,
		);
	}

	const running = await findRunningChromeProfile(
		exe,
		{ userDataDir: kind.userDataDir, profileDirectory: kind.profileDirectory },
		opts.signal,
	);
	let cdpUrl: string;
	let pid: number | undefined;
	let subprocess: Subprocess | undefined;
	if (running?.cdpUrl) {
		logger.debug("Reusing existing Chrome profile CDP endpoint", {
			exe,
			pid: running.pid,
			cdpUrl: running.cdpUrl,
			profileDirectory: kind.profileDirectory,
		});
		cdpUrl = running.cdpUrl;
		pid = running.pid;
	} else if (running) {
		throw new ToolError(
			running.unsafeCdpReason ??
				`Chrome profile ${JSON.stringify(kind.profileDirectory)} under ${kind.userDataDir} is already running without an attachable localhost CDP endpoint. ` +
					"GJC will not kill or relaunch an existing Chrome profile. Close that Chrome profile first, or restart Chrome yourself with --remote-debugging-address=127.0.0.1 and --remote-debugging-port=<port> then use app.cdp_url.",
		);
	} else {
		if (await hasChromeProfileLock(kind.userDataDir)) {
			throw new ToolError(
				`Chrome user data directory ${kind.userDataDir} appears to be locked by an existing Chrome process without an attachable localhost CDP endpoint. ` +
					"GJC will not kill or relaunch an existing Chrome profile. Close that Chrome profile first, or restart Chrome yourself with --remote-debugging-address=127.0.0.1 and --remote-debugging-port=<port> then use app.cdp_url.",
			);
		}
		const port = kind.cdpPort ?? (await findFreeCdpPort());
		const launchArgs = buildChromeProfileLaunchArgs(kind, opts.appArgs, port);
		const child = Bun.spawn([exe, ...launchArgs], {
			stdout: "ignore",
			stderr: "ignore",
			stdin: "ignore",
		});
		child.unref();
		subprocess = child;
		pid = child.pid;
		cdpUrl = `http://127.0.0.1:${port}`;
		try {
			await waitForCdp(cdpUrl, 30_000, opts.signal);
		} catch (err) {
			await gracefulKillTreeOnce(child.pid).catch(() => undefined);
			if (err instanceof ToolAbortError) throw err;
			if (err instanceof Error && err.name === "AbortError") throw err;
			throw new ToolError(
				`Failed to attach to Chrome profile ${JSON.stringify(kind.profileDirectory)} on ${cdpUrl}: ${(err as Error).message}`,
			);
		}
	}

	const puppeteer = await loadPuppeteer();
	let browser: Browser;
	try {
		browser = await puppeteer.connect({
			browserURL: cdpUrl,
			defaultViewport: null,
			protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
		});
	} catch (err) {
		if (subprocess) await gracefulKillTreeOnce(subprocess.pid);
		throw new ToolError(`Connected to ${cdpUrl} but puppeteer.connect failed: ${(err as Error).message}`);
	}
	return {
		key: browserKey(kind),
		kind,
		browser,
		cdpUrl,
		pid,
		subprocess,
		refCount: 0,
		stealth: { browserSession: null, override: null },
	};
}

async function openSpawnedBrowserHandle(
	kind: Extract<BrowserKind, { kind: "spawned" }>,
	opts: AcquireBrowserOptions,
): Promise<BrowserHandle> {
	const exe = kind.path;
	if (!path.isAbsolute(exe)) {
		throw new ToolError(
			`app.path must be absolute (got ${JSON.stringify(exe)}). Pass the binary inside Foo.app/Contents/MacOS/, not the .app bundle.`,
		);
	}
	const reused = await findReusableCdp(exe, opts.signal);
	let cdpUrl: string;
	let pid: number;
	let subprocess: Subprocess | undefined;
	if (reused) {
		logger.debug("Reusing existing CDP endpoint for attach", { exe, pid: reused.pid, cdpUrl: reused.cdpUrl });
		cdpUrl = reused.cdpUrl;
		pid = reused.pid;
	} else {
		const killed = await killExistingByPath(exe, opts.signal);
		if (killed > 0) logger.debug("Killed existing instances before attach", { exe, killed });
		const port = await findFreeCdpPort();
		const launchArgs = [...(opts.appArgs ?? []), `--remote-debugging-port=${port}`];
		const child = Bun.spawn([exe, ...launchArgs], {
			stdout: "ignore",
			stderr: "ignore",
			stdin: "ignore",
		});
		child.unref();
		subprocess = child;
		pid = child.pid;
		cdpUrl = `http://127.0.0.1:${port}`;
		try {
			await waitForCdp(cdpUrl, 30_000, opts.signal);
		} catch (err) {
			await gracefulKillTreeOnce(child.pid).catch(() => undefined);
			if (err instanceof ToolAbortError) throw err;
			if (err instanceof Error && err.name === "AbortError") throw err;
			throw new ToolError(`Failed to attach to ${path.basename(exe)} on ${cdpUrl}: ${(err as Error).message}`);
		}
	}

	const puppeteer = await loadPuppeteer();
	let browser: Browser;
	try {
		browser = await puppeteer.connect({
			browserURL: cdpUrl,
			defaultViewport: null,
			protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
		});
	} catch (err) {
		if (subprocess) await gracefulKillTreeOnce(subprocess.pid);
		throw new ToolError(`Connected to ${cdpUrl} but puppeteer.connect failed: ${(err as Error).message}`);
	}
	return {
		key: browserKey(kind),
		kind,
		browser,
		cdpUrl,
		pid,
		subprocess,
		refCount: 0,
		stealth: { browserSession: null, override: null },
	};
}

export function holdBrowser(handle: BrowserHandle): void {
	handle.refCount++;
}

export async function releaseBrowser(handle: BrowserHandle, opts: { kill: boolean }): Promise<void> {
	handle.refCount = Math.max(0, handle.refCount - 1);
	if (handle.refCount === 0) {
		browsers.delete(handle.key);
		await disposeBrowserHandle(handle, opts);
	}
}

async function disposeBrowserHandle(handle: BrowserHandle, opts: { kill: boolean }): Promise<void> {
	if (handle.kind.kind === "headless") {
		// Capture the launched Chrome process before close() so a forced (signal-path)
		// teardown can SIGTERM/SIGKILL the tree even if the CDP close hangs on a wedged
		// renderer. Otherwise the headless Chrome reparents to PID 1 (#698).
		const proc = handle.browser.process();
		if (handle.browser.connected) {
			try {
				const closing = handle.browser.close();
				// Graceful release waits for close() to finish (it also removes the
				// puppeteer_dev_chrome_profile-* temp dir). Forced release bounds it so
				// the kill fallback below still runs within the signal handler's budget.
				await (opts.kill ? Promise.race([closing, Bun.sleep(HEADLESS_FORCE_CLOSE_GRACE_MS)]) : closing);
			} catch (err) {
				logger.debug("Failed to close headless browser", { error: (err as Error).message });
			}
		}
		if (opts.kill && proc?.pid !== undefined) await gracefulKillTreeOnce(proc.pid);
		return;
	}
	if (handle.kind.kind === "connected") {
		if (handle.browser.connected) {
			try {
				handle.browser.disconnect();
			} catch (err) {
				logger.debug("Failed to disconnect from remote browser", { error: (err as Error).message });
			}
		}
		return;
	}
	if (handle.browser.connected) {
		try {
			handle.browser.disconnect();
		} catch (err) {
			logger.debug(`Failed to disconnect from ${handle.kind.kind} browser`, { error: (err as Error).message });
		}
	}
	if (handle.kind.kind === "chrome-profile" && !handle.subprocess) return;
	if (opts.kill && handle.pid !== undefined) await gracefulKillTreeOnce(handle.pid);
}
