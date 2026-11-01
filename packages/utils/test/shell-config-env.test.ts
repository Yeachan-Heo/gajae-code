import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getShellConfig, resetShellConfigCache } from "../src/procmgr";

/**
 * `docs/environment-variables.md` documents `GJC_BASH_NO_CI` / `GJC_BASH_NO_LOGIN`,
 * but the shell config only read the legacy `PI_*` / `CLAUDE_*` names, so the
 * documented names were silent no-ops.
 *
 * These pin the resolution contract for both knobs: documented name honored,
 * each legacy alias honored, canonical boolean parsing (so `0`/`false`/`off`
 * do NOT enable), GJC-first precedence (an explicit falsey GJC beats a truthy
 * legacy alias), and the memoized config staying sticky without an explicit
 * cache reset.
 */

const KEYS = [
	"GJC_BASH_NO_LOGIN",
	"PI_BASH_NO_LOGIN",
	"CLAUDE_BASH_NO_LOGIN",
	// Inherited into the spawn env otherwise, which would confound assertions.
	"CI",
] as const;

const saved = new Map<string, string | undefined>();

beforeEach(() => {
	for (const key of KEYS) {
		saved.set(key, Bun.env[key]);
		delete Bun.env[key];
	}
	resetShellConfigCache();
});

afterEach(() => {
	for (const [key, value] of saved) {
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
	}
	resetShellConfigCache();
});

/** Set env then re-derive the memoized config. */
function configWith(env: Record<string, string>): ReturnType<typeof getShellConfig> {
	for (const [key, value] of Object.entries(env)) Bun.env[key] = value;
	resetShellConfigCache();
	return getShellConfig();
}

describe("spawn env CI environment (no default injection)", () => {
	it("does not inject CI when no environment variable is set", () => {
		expect(getShellConfig().env.CI).toBeUndefined();
	});

	it("preserves inherited CI when already set in the process environment", () => {
		expect(configWith({ CI: "true" }).env.CI).toBe("true");
		expect(configWith({ CI: "false" }).env.CI).toBe("false");
	});

	it("does not use GJC_BASH_NO_CI since there is no default CI to suppress", () => {
		// GJC_BASH_NO_CI is no longer relevant; inherited CI is always passed through.
		expect(configWith({ GJC_BASH_NO_CI: "1" }).env.CI).toBeUndefined();
		expect(configWith({ GJC_BASH_NO_CI: "1", CI: "true" }).env.CI).toBe("true");
	});
});

describe("login shell args (GJC_BASH_NO_LOGIN)", () => {
	it("uses a login shell when no knob is set", () => {
		expect(getShellConfig().args).toEqual(["-l", "-c"]);
	});

	it("honors the documented GJC_BASH_NO_LOGIN", () => {
		expect(configWith({ GJC_BASH_NO_LOGIN: "1" }).args).toEqual(["-c"]);
	});

	it("honors the legacy PI_BASH_NO_LOGIN alias", () => {
		expect(configWith({ PI_BASH_NO_LOGIN: "1" }).args).toEqual(["-c"]);
	});

	it("honors the legacy CLAUDE_BASH_NO_LOGIN alias", () => {
		expect(configWith({ CLAUDE_BASH_NO_LOGIN: "1" }).args).toEqual(["-c"]);
	});

	it.each(["0", "false", "off", "no"])("treats GJC_BASH_NO_LOGIN=%s as not set", value => {
		expect(configWith({ GJC_BASH_NO_LOGIN: value }).args).toEqual(["-l", "-c"]);
	});

	it("resolves GJC-first: an explicit GJC_BASH_NO_LOGIN=0 beats a truthy legacy alias", () => {
		expect(configWith({ GJC_BASH_NO_LOGIN: "0", PI_BASH_NO_LOGIN: "1" }).args).toEqual(["-l", "-c"]);
	});

	it("accepts case-insensitive truthy spellings", () => {
		expect(configWith({ GJC_BASH_NO_LOGIN: "true" }).args).toEqual(["-c"]);
		expect(configWith({ GJC_BASH_NO_LOGIN: "YES" }).args).toEqual(["-c"]);
		expect(configWith({ GJC_BASH_NO_LOGIN: "on" }).args).toEqual(["-c"]);
	});
});

describe("shell config memoization", () => {
	it("stays sticky until the cache is reset", () => {
		expect(getShellConfig().args).toEqual(["-l", "-c"]);

		// Same process, new env, no reset: the memoized config must not change.
		Bun.env.GJC_BASH_NO_LOGIN = "1";
		expect(getShellConfig().args).toEqual(["-l", "-c"]);

		resetShellConfigCache();
		expect(getShellConfig().args).toEqual(["-c"]);
	});
});
