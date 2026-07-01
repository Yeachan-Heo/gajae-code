import { afterEach, describe, expect, it, mock } from "bun:test";
import type { ToolSession } from "../../src/sdk";
import { type BrowserParams, resolveBrowserKindForTest } from "../../src/tools/browser";
import type { AsideCliProbe } from "../../src/tools/browser/aside-cli";

// Controllable probe result — the browser module imports probeAsideCli from here.
let probeResult: AsideCliProbe = { ok: true, path: "/Users/me/.local/bin/aside" };
mock.module("../../src/tools/browser/aside-cli", () => ({
	probeAsideCli: () => probeResult,
	ASIDE_INSTALL_COMMAND: "curl -fsSL https://releases.aside.com/install.sh | bash",
	ASIDE_INSTALL_URL: "https://releases.aside.com/install.sh",
}));

const realPlatform = process.platform;
function setPlatform(p: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value: p, configurable: true });
}

function makeSession(settings: Record<string, unknown>): ToolSession {
	return {
		cwd: "/tmp/work",
		settings: { get: (key: string) => settings[key] },
	} as unknown as ToolSession;
}

function params(app?: BrowserParams["app"]): BrowserParams {
	return { action: "open", ...(app ? { app } : {}) } as BrowserParams;
}

afterEach(() => {
	setPlatform(realPlatform);
	probeResult = { ok: true, path: "/Users/me/.local/bin/aside" };
});

describe("browser.backend resolution", () => {
	it("defaults to native headless when backend is native", () => {
		const kind = resolveBrowserKindForTest(
			params(),
			makeSession({ "browser.backend": "native", "browser.headless": true }),
		);
		expect(kind).toEqual({ kind: "headless", headless: true });
	});

	it("treats a missing backend setting as native", () => {
		const kind = resolveBrowserKindForTest(params(), makeSession({ "browser.headless": false }));
		expect(kind).toEqual({ kind: "headless", headless: false });
	});

	it("resolves aside on macOS when the CLI is present", () => {
		setPlatform("darwin");
		probeResult = { ok: true, path: "/Users/me/.local/bin/aside" };
		const kind = resolveBrowserKindForTest(params(), makeSession({ "browser.backend": "aside" }));
		expect(kind).toEqual({
			kind: "aside",
			cliPath: "/Users/me/.local/bin/aside",
			liveProfile: true,
			defaultBackend: true,
		});
	});

	it("fails clearly for aside off macOS", () => {
		setPlatform("linux");
		expect(() => resolveBrowserKindForTest(params(), makeSession({ "browser.backend": "aside" }))).toThrow(
			/only supported on macOS/i,
		);
	});

	it("fails with install guidance when the CLI is missing on macOS", () => {
		setPlatform("darwin");
		probeResult = {
			ok: false,
			searched: ["/Users/me/.local/bin/aside"],
			manualInstallCommand: "curl -fsSL https://releases.aside.com/install.sh | bash",
			url: "https://releases.aside.com/install.sh",
		};
		expect(() => resolveBrowserKindForTest(params(), makeSession({ "browser.backend": "aside" }))).toThrow(
			/Aside CLI not found/i,
		);
	});

	it("keeps explicit app.cdp_url native even when backend is aside", () => {
		setPlatform("darwin");
		const kind = resolveBrowserKindForTest(
			params({ cdp_url: "http://127.0.0.1:9222/" }),
			makeSession({ "browser.backend": "aside" }),
		);
		expect(kind).toEqual({ kind: "connected", cdpUrl: "http://127.0.0.1:9222" });
	});

	it("keeps explicit app.path native even when backend is aside", () => {
		setPlatform("darwin");
		const kind = resolveBrowserKindForTest(
			params({ path: "/Applications/Some.app/Contents/MacOS/Some" }),
			makeSession({ "browser.backend": "aside" }),
		);
		expect(kind).toEqual({ kind: "spawned", path: "/Applications/Some.app/Contents/MacOS/Some" });
	});
});
