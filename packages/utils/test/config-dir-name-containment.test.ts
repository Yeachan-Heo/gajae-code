import { afterEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getConfigAgentDirName, getConfigDirName } from "../src/dirs";

/**
 * The configured config-directory name is documented as home-relative — "even an
 * absolute-looking configured name is joined beneath `<home>`". Consumers join it
 * with `<home>` to locate user-level `mcp.json`, `SYSTEM.md`, skills, agents and
 * installed plugins, so a `..` segment would move that discovery outside the
 * config root. `path.join` neutralizes a leading separator but not `..`.
 */

const KEYS = ["GJC_CONFIG_DIR", "PI_CONFIG_DIR"] as const;
const saved = new Map<string, string | undefined>();

for (const key of KEYS) saved.set(key, process.env[key]);

afterEach(() => {
	for (const [key, value] of saved) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

function setOnly(key: (typeof KEYS)[number], value: string): void {
	for (const other of KEYS) delete process.env[other];
	process.env[key] = value;
}

/** Where a discovery consumer would land for the current configuration. */
function userAgentDirUnderHome(): string {
	return path.join(os.homedir(), getConfigAgentDirName());
}

describe("config directory name containment", () => {
	it("defaults when nothing is configured", () => {
		for (const key of KEYS) delete process.env[key];
		expect(getConfigDirName()).toBe(CONFIG_DIR_NAME);
	});

	it("honors an ordinary configured name", () => {
		setOnly("GJC_CONFIG_DIR", ".gjc-alt");
		expect(getConfigDirName()).toBe(".gjc-alt");
		expect(userAgentDirUnderHome()).toBe(path.join(os.homedir(), ".gjc-alt", "agent"));
	});

	it("honors the legacy PI_CONFIG_DIR name", () => {
		setOnly("PI_CONFIG_DIR", ".pi-alt");
		expect(getConfigDirName()).toBe(".pi-alt");
	});

	it("keeps an absolute-looking name beneath home, as documented", () => {
		setOnly("GJC_CONFIG_DIR", "/etc/gjc");
		const resolved = userAgentDirUnderHome();
		expect(resolved.startsWith(`${os.homedir()}${path.sep}`)).toBe(true);
	});

	it.each([
		"../escape",
		"../../tmp/evil",
		".gjc/../../tmp/evil",
		"a/b/../../../../tmp/evil",
	])("rejects the escaping name %p and falls back to the default", value => {
		setOnly("GJC_CONFIG_DIR", value);
		expect(getConfigDirName()).toBe(CONFIG_DIR_NAME);
		expect(userAgentDirUnderHome().startsWith(`${os.homedir()}${path.sep}`)).toBe(true);
	});

	it("rejects an escaping legacy PI_CONFIG_DIR name too", () => {
		setOnly("PI_CONFIG_DIR", "../../tmp/evil");
		expect(getConfigDirName()).toBe(CONFIG_DIR_NAME);
	});

	it("falls through to the legacy name when the primary one escapes", () => {
		for (const key of KEYS) delete process.env[key];
		process.env.GJC_CONFIG_DIR = "../../tmp/evil";
		process.env.PI_CONFIG_DIR = ".pi-alt";
		expect(getConfigDirName()).toBe(".pi-alt");
	});

	it("ignores a blank configured name", () => {
		setOnly("GJC_CONFIG_DIR", "   ");
		expect(getConfigDirName()).toBe(CONFIG_DIR_NAME);
	});
});
