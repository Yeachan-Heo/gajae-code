import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Browser } from "puppeteer-core";
import * as attach from "../../src/tools/browser/attach";
import { type BrowserHandle, releaseBrowser } from "../../src/tools/browser/registry";

interface FakeBrowserOptions {
	pid?: number;
	close?: () => Promise<void>;
}

function makeHeadlessHandle(opts: FakeBrowserOptions = {}): { handle: BrowserHandle; close: ReturnType<typeof vi.fn> } {
	const close = vi.fn(opts.close ?? (async () => {}));
	const browser = {
		connected: true,
		close,
		process: () => (opts.pid === undefined ? null : ({ pid: opts.pid } as never)),
	} as unknown as Browser;
	const handle: BrowserHandle = {
		key: "headless:1",
		kind: { kind: "headless", headless: true },
		browser,
		refCount: 1,
		stealth: { browserSession: null, override: null },
	};
	return { handle, close };
}

describe("browser registry headless teardown (#698)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("force-kills the headless Chrome process tree on a forced (signal) release", async () => {
		const killSpy = vi.spyOn(attach, "gracefulKillTreeOnce").mockResolvedValue(undefined);
		const { handle, close } = makeHeadlessHandle({ pid: 4242 });

		await releaseBrowser(handle, { kill: true });

		expect(close).toHaveBeenCalledTimes(1);
		expect(killSpy).toHaveBeenCalledTimes(1);
		expect(killSpy).toHaveBeenCalledWith(4242);
	});

	it("kills the captured process even when CDP close hangs on a wedged renderer", async () => {
		const killSpy = vi.spyOn(attach, "gracefulKillTreeOnce").mockResolvedValue(undefined);
		// close() never resolves: bounded by HEADLESS_FORCE_CLOSE_GRACE_MS so the kill still runs.
		const { handle } = makeHeadlessHandle({ pid: 99, close: () => new Promise<void>(() => {}) });

		await releaseBrowser(handle, { kill: true });

		expect(killSpy).toHaveBeenCalledWith(99);
	});

	it("closes gracefully without killing on a normal release (kill:false)", async () => {
		const killSpy = vi.spyOn(attach, "gracefulKillTreeOnce").mockResolvedValue(undefined);
		const { handle, close } = makeHeadlessHandle({ pid: 4242 });

		await releaseBrowser(handle, { kill: false });

		expect(close).toHaveBeenCalledTimes(1);
		expect(killSpy).not.toHaveBeenCalled();
	});

	it("only disposes once refCount reaches zero", async () => {
		const killSpy = vi.spyOn(attach, "gracefulKillTreeOnce").mockResolvedValue(undefined);
		const { handle, close } = makeHeadlessHandle({ pid: 4242 });
		handle.refCount = 2;

		await releaseBrowser(handle, { kill: true });
		expect(close).not.toHaveBeenCalled();
		expect(killSpy).not.toHaveBeenCalled();

		await releaseBrowser(handle, { kill: true });
		expect(close).toHaveBeenCalledTimes(1);
		expect(killSpy).toHaveBeenCalledWith(4242);
	});
});
