import * as net from "node:net";
import * as path from "node:path";
import { Process, ProcessStatus } from "@gajae-code/natives";
import type { Browser, Page } from "puppeteer-core";
import { ToolError, throwIfAborted } from "../tool-errors";

const ATTACH_TARGET_SKIP_PATTERN =
	/request[\s_-]?handler|devtools|background[\s_-]?(?:page|host)|service[\s_-]?worker/i;

/**
 * Allocate an unused TCP port on 127.0.0.1 by binding to port 0 and reading
 * back the kernel-assigned port. There's a small race between close and the
 * subsequent bind in the launched app, but Chromium's listener will retry.
 */
export async function findFreeCdpPort(): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const server = net.createServer();
	server.unref();
	server.once("error", reject);
	server.listen(0, "127.0.0.1", () => {
		const addr = server.address();
		if (addr && typeof addr === "object" && typeof addr.port === "number") {
			const port = addr.port;
			server.close(closeErr => (closeErr ? reject(closeErr) : resolve(port)));
		} else {
			server.close();
			reject(new Error("Failed to allocate ephemeral CDP port"));
		}
	});
	return promise;
}

/** Poll `${cdpUrl}/json/version` until it responds with 200, with abort + timeout support. */
export async function waitForCdp(cdpUrl: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastErr: unknown;
	const probeUrl = `${cdpUrl.replace(/\/+$/, "")}/json/version`;
	while (Date.now() < deadline) {
		throwIfAborted(signal);
		const probeTimeout = AbortSignal.timeout(2000);
		const probeSignal = signal ? AbortSignal.any([signal, probeTimeout]) : probeTimeout;
		try {
			const res = await fetch(probeUrl, { signal: probeSignal });
			if (res.ok) {
				await res.body?.cancel();
				return;
			}
			lastErr = new Error(`HTTP ${res.status}`);
			await res.body?.cancel();
		} catch (err) {
			if (signal?.aborted) throwIfAborted(signal);
			lastErr = err;
		}
		await Bun.sleep(150);
	}
	throw new ToolError(
		`Timed out waiting for CDP endpoint ${cdpUrl}${lastErr instanceof Error ? `: ${lastErr.message}` : ""}`,
	);
}

/**
 * Pull a `--remote-debugging-port=<n>` value out of an argv array (Chromium
 * accepts both `--flag=value` and `--flag value`). Returns null if absent or
 * malformed.
 */
export function findCdpPortInArgsForTest(args: string[]): number | null {
	return findCdpPortInArgs(args);
}
export function findCdpAddressInArgsForTest(args: readonly string[]): string | null {
	return findCdpAddressInArgs(args);
}

export function isSafeCdpAddressForTest(address: string | null): boolean {
	return isSafeCdpAddress(address);
}

function findCdpPortInArgs(args: string[]): number | null {
	for (const arg of args) {
		const m = /^--remote-debugging-port=(\d+)$/.exec(arg);
		if (m) {
			const port = Number.parseInt(m[1]!, 10);
			if (Number.isFinite(port) && port > 0) return port;
		}
	}
	for (let i = 0; i < args.length - 1; i++) {
		if (args[i] === "--remote-debugging-port") {
			const port = Number.parseInt(args[i + 1]!, 10);
			if (Number.isFinite(port) && port > 0) return port;
		}
	}
	return null;
}

function findArgValue(args: readonly string[], name: string): string | null {
	const prefix = `${name}=`;
	for (const arg of args) {
		if (arg.startsWith(prefix)) return arg.slice(prefix.length);
	}
	for (let i = 0; i < args.length - 1; i++) {
		if (args[i] === name) return args[i + 1] ?? null;
	}
	return null;
}

function normalizeProfilePath(input: string): string {
	return path.resolve(input);
}

export function argsMatchChromeProfileForTest(
	args: readonly string[],
	profile: { userDataDir: string; profileDirectory: string },
): boolean {
	return argsMatchChromeProfile(args, profile);
}

function argsMatchChromeProfile(
	args: readonly string[],
	profile: { userDataDir: string; profileDirectory: string },
): boolean {
	const userDataDir = findArgValue(args, "--user-data-dir");
	const profileDirectory = findArgValue(args, "--profile-directory") ?? "Default";
	return (
		userDataDir !== null &&
		normalizeProfilePath(userDataDir) === normalizeProfilePath(profile.userDataDir) &&
		profileDirectory === profile.profileDirectory
	);
}

/** One-shot probe: returns true when `/json/version` answers 200 within the timeout. */
async function probeCdpAt(port: number, signal?: AbortSignal): Promise<boolean> {
	const probeTimeout = AbortSignal.timeout(1500);
	const probeSignal = signal ? AbortSignal.any([signal, probeTimeout]) : probeTimeout;
	try {
		const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: probeSignal });
		await res.body?.cancel();
		return res.ok;
	} catch {
		return false;
	}
}

/**
 * Chromium binds remote debugging to loopback by default when no address is
 * provided. Reuse only loopback CDP listeners; a matching profile launched with
 * --remote-debugging-address=0.0.0.0, ::, or any LAN/public address is unsafe.
 */
function findCdpAddressInArgs(args: readonly string[]): string | null {
	return findArgValue(args, "--remote-debugging-address");
}

function isSafeCdpAddress(address: string | null): boolean {
	if (address === null || address.trim() === "") return true;
	const normalized = address.trim().toLowerCase();
	return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1" || normalized === "[::1]";
}

function unsafeCdpAddressReason(address: string): string {
	return `Refusing to reuse Chrome profile CDP endpoint because --remote-debugging-address=${JSON.stringify(
		address,
	)} is not a loopback-only address. Restart Chrome with --remote-debugging-address=127.0.0.1 or omit the address flag.`;
}

export async function findReusableCdp(
	exe: string,
	signal?: AbortSignal,
): Promise<{ cdpUrl: string; pid: number } | null> {
	const candidates = Process.fromPath(exe).filter(p => p.status() === ProcessStatus.Running);
	for (const proc of candidates) {
		let args: string[];
		try {
			args = proc.args();
		} catch {
			continue;
		}
		const port = findCdpPortInArgs(args);
		if (port === null) continue;
		const address = findCdpAddressInArgs(args);
		if (!isSafeCdpAddress(address)) continue;
		if (await probeCdpAt(port, signal)) {
			return { cdpUrl: `http://127.0.0.1:${port}`, pid: proc.pid };
		}
	}
	return null;
}

export interface RunningChromeProfile {
	pid: number;
	cdpUrl: string | null;
	unsafeCdpReason?: string;
}

export async function findRunningChromeProfile(
	exe: string,
	profile: { userDataDir: string; profileDirectory: string },
	signal?: AbortSignal,
): Promise<RunningChromeProfile | null> {
	const candidates = Process.fromPath(exe).filter(p => p.status() === ProcessStatus.Running);
	for (const proc of candidates) {
		let args: string[];
		try {
			args = proc.args();
		} catch {
			continue;
		}
		if (!argsMatchChromeProfile(args, profile)) continue;
		const port = findCdpPortInArgs(args);
		if (port !== null) {
			const address = findCdpAddressInArgs(args);
			if (!isSafeCdpAddress(address)) {
				return { pid: proc.pid, cdpUrl: null, unsafeCdpReason: unsafeCdpAddressReason(address ?? "") };
			}
			if (await probeCdpAt(port, signal)) {
				return { pid: proc.pid, cdpUrl: `http://127.0.0.1:${port}` };
			}
		}
		return { pid: proc.pid, cdpUrl: null };
	}
	return null;
}

/**
 * Pick the best page target on an attached browser. Without a matcher, prefer
 * a page that doesn't look like a helper window (devtools, request handler,
 * background pages); with a matcher, return the first url+title substring hit.
 */
export async function pickElectronTarget(browser: Browser, matcher?: string): Promise<Page> {
	const pages = await browser.pages();
	if (!pages.length) {
		throw new ToolError("No page targets available on the attached browser");
	}
	const enriched = await Promise.all(
		pages.map(async page => ({
			page,
			url: page.url(),
			title: ((await page.title().catch(() => "")) ?? "").trim(),
		})),
	);
	if (matcher) {
		const needle = matcher.toLowerCase();
		const hit = enriched.find(p => p.url.toLowerCase().includes(needle) || p.title.toLowerCase().includes(needle));
		if (hit) return hit.page;
		const summary = enriched.map(p => `- ${p.title || "(untitled)"}  ${p.url}`).join("\n");
		throw new ToolError(`No page target matched ${JSON.stringify(matcher)}. Available pages:\n${summary}`);
	}
	return (
		enriched.find(p => !ATTACH_TARGET_SKIP_PATTERN.test(p.url) && !ATTACH_TARGET_SKIP_PATTERN.test(p.title))?.page ??
		enriched[0]!.page
	);
}

/**
 * SIGTERM the process tree, wait briefly, then SIGKILL anything still alive.
 * Single-process variant for our own spawned children.
 */
export async function gracefulKillTreeOnce(pid: number, gracePeriodMs = 2000): Promise<void> {
	const process = Process.fromPid(pid);
	if (!process) return;
	await process.terminate({ gracefulMs: gracePeriodMs, timeoutMs: 500 });
}

/**
 * Multi-process variant for attach: find every PID running `executablePath`
 * (single-instance apps may keep an orphan around) and tear them all down.
 */
export async function killExistingByPath(executablePath: string, signal?: AbortSignal): Promise<number> {
	const processes = Process.fromPath(executablePath);
	if (!processes.length) return 0;
	const results = await Promise.all(
		processes.map(async process => {
			throwIfAborted(signal);
			return await process.terminate({ gracefulMs: 3000, timeoutMs: 1000 });
		}),
	);
	return results.length;
}
