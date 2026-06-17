import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Process, ProcessStatus } from "@gajae-code/natives";
import type { Browser } from "puppeteer-core";
import type { ToolSession } from "../../src/sdk";
import { type BrowserParams, resolveBrowserKindForTest } from "../../src/tools/browser";
import * as attach from "../../src/tools/browser/attach";
import {
	argsMatchChromeProfileForTest,
	findCdpAddressInArgsForTest,
	findCdpPortInArgsForTest,
	isSafeCdpAddressForTest,
} from "../../src/tools/browser/attach";
import * as launch from "../../src/tools/browser/launch";
import {
	type AcquireBrowserOptions,
	type BrowserHandle,
	type BrowserKind,
	buildChromeProfileLaunchArgs,
	openChromeProfileHandle,
	releaseBrowser,
} from "../../src/tools/browser/registry";

function makeSession(cwd: string): ToolSession {
	return {
		cwd,
		settings: { get: () => true },
	} as unknown as ToolSession;
}

function chromeProfileKind(
	overrides: Partial<Extract<BrowserKind, { kind: "chrome-profile" }>> = {},
): Extract<BrowserKind, { kind: "chrome-profile" }> {
	return {
		kind: "chrome-profile",
		path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		userDataDir: "/Users/me/Library/Application Support/Google/Chrome",
		profileDirectory: "Profile 10",
		background: false,
		noFocus: false,
		...overrides,
	};
}

function fakeConnectedBrowser(): Browser {
	return {
		connected: true,
		disconnect: vi.fn(),
	} as unknown as Browser;
}

function mockRunningChromeProcess(args: string[]): void {
	vi.spyOn(Process, "fromPath").mockReturnValue([
		{
			pid: 123,
			status: () => ProcessStatus.Running,
			args: () => args,
		},
	] as ReturnType<typeof Process.fromPath>);
}

function mockSuccessfulCdpProbe(): void {
	vi.spyOn(globalThis, "fetch").mockResolvedValue({
		ok: true,
		body: { cancel: vi.fn().mockResolvedValue(undefined) },
	} as unknown as Response);
}

describe("Chrome profile browser mode (#809)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("parses Chromium CDP and profile argv forms", () => {
		expect(findCdpPortInArgsForTest(["--remote-debugging-port=9222"])).toBe(9222);
		expect(findCdpPortInArgsForTest(["--remote-debugging-port", "9223"])).toBe(9223);
		expect(findCdpPortInArgsForTest(["--remote-debugging-port=0"])).toBeNull();
		expect(findCdpAddressInArgsForTest(["--remote-debugging-address=127.0.0.1"])).toBe("127.0.0.1");
		expect(findCdpAddressInArgsForTest(["--remote-debugging-address", "0.0.0.0"])).toBe("0.0.0.0");
		expect(isSafeCdpAddressForTest(null)).toBe(true);
		expect(isSafeCdpAddressForTest("127.0.0.1")).toBe(true);
		expect(isSafeCdpAddressForTest("localhost")).toBe(true);
		expect(isSafeCdpAddressForTest("::1")).toBe(true);
		expect(isSafeCdpAddressForTest("0.0.0.0")).toBe(false);
		expect(isSafeCdpAddressForTest("::")).toBe(false);
		expect(isSafeCdpAddressForTest("192.168.1.50")).toBe(false);
		expect(
			argsMatchChromeProfileForTest(["--user-data-dir=/tmp/chrome", "--profile-directory=Profile 10"], {
				userDataDir: "/tmp/chrome",
				profileDirectory: "Profile 10",
			}),
		).toBe(true);
		expect(
			argsMatchChromeProfileForTest(["--user-data-dir", "/tmp/chrome"], {
				userDataDir: "/tmp/chrome",
				profileDirectory: "Default",
			}),
		).toBe(true);
		expect(
			argsMatchChromeProfileForTest(["--user-data-dir=/tmp/chrome", "--profile-directory=Profile 9"], {
				userDataDir: "/tmp/chrome",
				profileDirectory: "Profile 10",
			}),
		).toBe(false);
	});

	it("builds localhost-only Chrome profile launch args with background guard", () => {
		const args = buildChromeProfileLaunchArgs(
			chromeProfileKind({ background: true, userDataDir: "/tmp/chrome", profileDirectory: "Profile 10" }),
			[
				"--disable-features=Foo",
				"--remote-debugging-address=0.0.0.0",
				"--remote-debugging-port",
				"9999",
				"--user-data-dir=/wrong",
			],
			9333,
		);

		expect(args).toEqual([
			"--disable-features=Foo",
			"--user-data-dir=/tmp/chrome",
			"--profile-directory=Profile 10",
			"--remote-debugging-port=9333",
			"--remote-debugging-address=127.0.0.1",
			"--no-startup-window",
		]);
	});

	it("resolves app.browser chrome config using repo-consistent snake_case fields", () => {
		const params: BrowserParams = {
			action: "open",
			app: {
				browser: "chrome",
				path: "bin/google-chrome",
				user_data_dir: "profiles/chrome",
				profile_directory: "Profile 10",
				background: true,
				no_focus: true,
				cdp_port: 9444,
			},
		};
		const kind = resolveBrowserKindForTest(params, makeSession("/work"));

		expect(kind).toEqual({
			kind: "chrome-profile",
			path: path.join("/work", "bin/google-chrome"),
			userDataDir: path.join("/work", "profiles/chrome"),
			profileDirectory: "Profile 10",
			background: true,
			noFocus: true,
			cdpPort: 9444,
		});
	});

	it("refuses an already-running matching profile without attachable CDP", async () => {
		vi.spyOn(attach, "findRunningChromeProfile").mockResolvedValue({ pid: 123, cdpUrl: null });
		const killSpy = vi.spyOn(attach, "gracefulKillTreeOnce").mockResolvedValue(undefined);
		const spawnSpy = vi.spyOn(Bun, "spawn");

		await expect(
			openChromeProfileHandle(chromeProfileKind(), { cwd: "/work" } as AcquireBrowserOptions),
		).rejects.toThrow(/already running without an attachable localhost CDP endpoint/);
		expect(spawnSpy).not.toHaveBeenCalled();
		expect(killSpy).not.toHaveBeenCalled();
	});

	it("reuses matching profile CDP when no remote debugging address is present", async () => {
		mockRunningChromeProcess([
			"--user-data-dir=/Users/me/Library/Application Support/Google/Chrome",
			"--profile-directory=Profile 10",
			"--remote-debugging-port=9222",
		]);
		mockSuccessfulCdpProbe();

		await expect(
			attach.findRunningChromeProfile("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", {
				userDataDir: "/Users/me/Library/Application Support/Google/Chrome",
				profileDirectory: "Profile 10",
			}),
		).resolves.toEqual({ pid: 123, cdpUrl: "http://127.0.0.1:9222" });
	});

	it("reuses matching profile CDP when remote debugging address is localhost", async () => {
		mockRunningChromeProcess([
			"--user-data-dir=/Users/me/Library/Application Support/Google/Chrome",
			"--profile-directory=Profile 10",
			"--remote-debugging-port=9222",
			"--remote-debugging-address=127.0.0.1",
		]);
		mockSuccessfulCdpProbe();

		await expect(
			attach.findRunningChromeProfile("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", {
				userDataDir: "/Users/me/Library/Application Support/Google/Chrome",
				profileDirectory: "Profile 10",
			}),
		).resolves.toEqual({ pid: 123, cdpUrl: "http://127.0.0.1:9222" });
	});

	it("refuses matching profile CDP when remote debugging address is wildcard", async () => {
		mockRunningChromeProcess([
			"--user-data-dir=/Users/me/Library/Application Support/Google/Chrome",
			"--profile-directory=Profile 10",
			"--remote-debugging-port=9222",
			"--remote-debugging-address=0.0.0.0",
		]);
		mockSuccessfulCdpProbe();

		const running = await attach.findRunningChromeProfile(
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			{
				userDataDir: "/Users/me/Library/Application Support/Google/Chrome",
				profileDirectory: "Profile 10",
			},
		);

		expect(running).toEqual({
			pid: 123,
			cdpUrl: null,
			unsafeCdpReason:
				'Refusing to reuse Chrome profile CDP endpoint because --remote-debugging-address="0.0.0.0" is not a loopback-only address. Restart Chrome with --remote-debugging-address=127.0.0.1 or omit the address flag.',
		});
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("refuses an already-running matching profile with unsafe CDP address", async () => {
		vi.spyOn(attach, "findRunningChromeProfile").mockResolvedValue({
			pid: 123,
			cdpUrl: null,
			unsafeCdpReason:
				'Refusing to reuse Chrome profile CDP endpoint because --remote-debugging-address="0.0.0.0" is not a loopback-only address.',
		});
		const killSpy = vi.spyOn(attach, "gracefulKillTreeOnce").mockResolvedValue(undefined);
		const spawnSpy = vi.spyOn(Bun, "spawn");

		await expect(
			openChromeProfileHandle(chromeProfileKind(), { cwd: "/work" } as AcquireBrowserOptions),
		).rejects.toThrow(/remote-debugging-address="0\.0\.0\.0"/);
		expect(spawnSpy).not.toHaveBeenCalled();
		expect(killSpy).not.toHaveBeenCalled();
	});

	it("refuses a locked Chrome user data directory without killing or spawning", async () => {
		const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-chrome-profile-"));
		await Bun.write(path.join(userDataDir, "SingletonLock"), "");
		vi.spyOn(attach, "findRunningChromeProfile").mockResolvedValue(null);
		const killSpy = vi.spyOn(attach, "gracefulKillTreeOnce").mockResolvedValue(undefined);
		const spawnSpy = vi.spyOn(Bun, "spawn");

		await expect(
			openChromeProfileHandle(chromeProfileKind({ userDataDir }), { cwd: "/work" } as AcquireBrowserOptions),
		).rejects.toThrow(/appears to be locked/);
		expect(spawnSpy).not.toHaveBeenCalled();
		expect(killSpy).not.toHaveBeenCalled();
	});

	it("reuses externally-owned profile CDP and cleanup disconnects only", async () => {
		vi.spyOn(attach, "findRunningChromeProfile").mockResolvedValue({ pid: 123, cdpUrl: "http://127.0.0.1:9222" });
		const connect = vi.fn().mockResolvedValue(fakeConnectedBrowser());
		vi.spyOn(launch, "loadPuppeteer").mockResolvedValue({ connect } as unknown as Awaited<
			ReturnType<typeof launch.loadPuppeteer>
		>);
		const killSpy = vi.spyOn(attach, "gracefulKillTreeOnce").mockResolvedValue(undefined);

		const handle = await openChromeProfileHandle(chromeProfileKind(), { cwd: "/work" } as AcquireBrowserOptions);
		handle.refCount = 1;
		await releaseBrowser(handle, { kill: true });

		expect(connect).toHaveBeenCalledWith(expect.objectContaining({ browserURL: "http://127.0.0.1:9222" }));
		expect(killSpy).not.toHaveBeenCalled();
	});

	it("kills only a GJC-launched profile browser on cleanup", async () => {
		const browser = fakeConnectedBrowser();
		const handle: BrowserHandle = {
			key: "chrome-profile:test",
			kind: chromeProfileKind(),
			browser,
			pid: 456,
			subprocess: { pid: 456 } as BrowserHandle["subprocess"],
			refCount: 1,
			stealth: { browserSession: null, override: null },
		};
		const killSpy = vi.spyOn(attach, "gracefulKillTreeOnce").mockResolvedValue(undefined);

		await releaseBrowser(handle, { kill: true });

		expect(browser.disconnect).toHaveBeenCalledTimes(1);
		expect(killSpy).toHaveBeenCalledWith(456);
	});
});
