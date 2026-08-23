import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { safeRm } from "../../../scripts/safe-cleanup";
import {
	getAgentDir,
	getConfigDirName,
	getGpuCachePath,
	getLogsDir,
	getPluginsDir,
	getPuppeteerDir,
	getPythonGatewayDir,
	setAgentDir,
} from "../src/dirs";
import { Snowflake } from "../src/snowflake";

describe("python gateway directory", () => {
	let tempRoot = "";
	let originalAgentDir = "";
	let originalConfigDir: string | undefined;
	let originalGjcConfigDir: string | undefined;
	let originalXdgDataHome: string | undefined;
	let originalXdgStateHome: string | undefined;
	let originalXdgCacheHome: string | undefined;

	beforeEach(async () => {
		originalAgentDir = getAgentDir();
		originalConfigDir = process.env.PI_CONFIG_DIR;
		originalGjcConfigDir = process.env.GJC_CONFIG_DIR;
		originalXdgStateHome = process.env.XDG_STATE_HOME;
		originalXdgDataHome = process.env.XDG_DATA_HOME;
		originalXdgCacheHome = process.env.XDG_CACHE_HOME;
		tempRoot = path.join(os.tmpdir(), "pi-utils-python-gateway", Snowflake.next());
		await fs.mkdir(tempRoot, { recursive: true });
	});

	afterEach(async () => {
		if (originalConfigDir === undefined) {
			delete process.env.PI_CONFIG_DIR;
		} else {
			process.env.PI_CONFIG_DIR = originalConfigDir;
		}
		if (originalGjcConfigDir === undefined) {
			delete process.env.GJC_CONFIG_DIR;
		} else {
			process.env.GJC_CONFIG_DIR = originalGjcConfigDir;
		}
		if (originalXdgStateHome === undefined) {
			delete process.env.XDG_STATE_HOME;
		} else {
			process.env.XDG_STATE_HOME = originalXdgStateHome;
		}
		if (originalXdgDataHome === undefined) {
			delete process.env.XDG_DATA_HOME;
		} else {
			process.env.XDG_DATA_HOME = originalXdgDataHome;
		}
		if (originalXdgCacheHome === undefined) {
			delete process.env.XDG_CACHE_HOME;
		} else {
			process.env.XDG_CACHE_HOME = originalXdgCacheHome;
		}
		setAgentDir(originalAgentDir);
		await safeRm(tempRoot, { recursive: true, force: true });
	});

	it("uses XDG state for the default agent profile", async () => {
		if (process.platform === "win32") return;

		process.env.PI_CONFIG_DIR = `.gjc-test-${Snowflake.next()}`;
		process.env.XDG_STATE_HOME = path.join(tempRoot, "state");
		await fs.mkdir(path.join(process.env.XDG_STATE_HOME, "gjc"), { recursive: true });

		const defaultAgentDir = path.join(os.homedir(), getConfigDirName(), "agent");
		setAgentDir(defaultAgentDir);

		expect(getPythonGatewayDir()).toBe(path.join(process.env.XDG_STATE_HOME, "gjc", "python-gateway"));
	});

	it("keeps custom agent profiles isolated from XDG shared state", async () => {
		if (process.platform === "win32") return;

		process.env.XDG_STATE_HOME = path.join(tempRoot, "state");
		await fs.mkdir(path.join(process.env.XDG_STATE_HOME, "gjc"), { recursive: true });
		const customAgentDir = path.join(tempRoot, "custom-agent");

		setAgentDir(customAgentDir);

		expect(getPythonGatewayDir()).toBe(path.join(customAgentDir, "python-gateway"));
	});

	it("keeps custom agent profile GPU cache out of the global config root", async () => {
		const customAgentDir = path.join(tempRoot, "custom-agent");

		setAgentDir(customAgentDir);

		expect(getGpuCachePath()).toBe(path.join(customAgentDir, "gpu_cache.json"));
	});

	it("refreshes every category path after a post-import config override", async () => {
		if (process.platform === "win32") return;

		const dataHome = path.join(tempRoot, "data");
		const stateHome = path.join(tempRoot, "state");
		const cacheHome = path.join(tempRoot, "cache");
		await Promise.all([
			fs.mkdir(path.join(dataHome, "gjc"), { recursive: true }),
			fs.mkdir(path.join(stateHome, "gjc"), { recursive: true }),
			fs.mkdir(path.join(cacheHome, "gjc"), { recursive: true }),
		]);
		process.env.XDG_DATA_HOME = dataHome;
		process.env.XDG_STATE_HOME = stateHome;
		process.env.XDG_CACHE_HOME = cacheHome;
		const before = getLogsDir();
		process.env.PI_CONFIG_DIR = `.gjc-refresh-${Snowflake.next()}`;
		setAgentDir(path.join(os.homedir(), getConfigDirName(), "agent"));
		const expected = (base: string, child: string) => path.join(base, "gjc", child);

		expect(getPluginsDir()).toBe(expected(dataHome, "plugins"));
		expect(getLogsDir()).toBe(expected(stateHome, "logs"));
		expect(getPuppeteerDir()).toBe(expected(cacheHome, "puppeteer"));
		expect(getPythonGatewayDir()).toBe(expected(stateHome, "python-gateway"));
		expect(getLogsDir()).not.toBe(before);
	});
});
