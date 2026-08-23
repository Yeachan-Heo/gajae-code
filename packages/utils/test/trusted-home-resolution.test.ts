import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { safeRm } from "../../../scripts/safe-cleanup";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	getConfigRootDir,
	getPluginsDir,
	getTrustedConfigRootDir,
	getTrustedHomeDir,
} from "../src/dirs";

const PROBE = path.join(import.meta.dir, "fixtures", "agent-dir-override-probe.ts");
const DIRS = path.join(import.meta.dir, "..", "src", "dirs.ts");

interface ProbeResolved {
	trustedHome: string;
	agentDir: string;
	configRoot: string;
	agentDb: string;
}

interface ProbeResult {
	overrideDeclared: string | null;
	before: ProbeResolved;
	after: ProbeResolved;
}

/**
 * Resolve the agent directory in a child process, before and after the home
 * changes. Runs out of process so the parent's module-level resolver is never
 * mutated: `setAgentDir` installs an override resolver and cannot install a
 * default one, so an in-process restore would latch that override.
 */
async function probe(options: {
	agentDirOverride: string | null;
	secondHome: string;
	home?: string;
	xdgDataHome?: string;
}): Promise<ProbeResult> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	delete env.GJC_CODING_AGENT_DIR;
	delete env.PI_CODING_AGENT_DIR;
	delete env.GJC_CONFIG_DIR;
	delete env.PI_CONFIG_DIR;
	delete env.XDG_DATA_HOME;
	if (options.xdgDataHome) env.XDG_DATA_HOME = options.xdgDataHome;
	if (options.agentDirOverride) env.GJC_CODING_AGENT_DIR = options.agentDirOverride;
	if (options.home) {
		// Only the platform-authoritative variable selects the home, and the
		// opposite one is cleared so an inherited value cannot shadow it. The
		// second home arrives through an `os.homedir()` mock in the fixture, which
		// already resolves USERPROFILE on Windows.
		const homeKey = process.platform === "win32" ? "USERPROFILE" : "HOME";
		const unusedHomeKey = process.platform === "win32" ? "HOME" : "USERPROFILE";
		env[homeKey] = options.home;
		delete env[unusedHomeKey];
	}
	env.GJC_PROBE_SECOND_HOME = options.secondHome;

	const proc = Bun.spawn([process.execPath, PROBE], { cwd: import.meta.dir, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}`);
	return JSON.parse(stdout.trim()) as ProbeResult;
}

/**
 * The authoritative home for user-scope state must satisfy two properties at
 * once (issue #4761):
 *
 * 1. It is resolved at **call time**, not snapshotted at module load. A home
 *    established or changed after `dirs.ts` initializes must be honored —
 *    freezing it silently drops every user-scope location, which is how
 *    user-scope skill and MCP discovery regressed on `d9fabc8f5a`.
 * 2. It stays **provenance-checked**. A checkout's `.env` is overlaid into
 *    `process.env` before any module runs, so a home the project dotenv could
 *    have planted must never be honored; the OS account database wins instead.
 *    That rule is exercised out-of-process in `agent-dir-trust.test.ts`, which
 *    can control cwd and the inherited environment; here we pin the in-process
 *    half — the resolution that discovery actually calls.
 */

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-trusted-home-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => safeRm(dir, { recursive: true, force: true })));
});

describe("authoritative home resolution", () => {
	it("follows a home that only becomes visible after module load", async () => {
		// The regression: `dirs.ts` had already initialized by the time this
		// mock is installed, so an import-time snapshot keeps returning the
		// ambient home and every user-scope path points at the wrong place.
		const before = getTrustedHomeDir();
		const planted = await tempDir();
		expect(planted).not.toBe(before);

		vi.spyOn(os, "homedir").mockReturnValue(planted);
		expect(getTrustedHomeDir()).toBe(planted);
	});

	it("re-points the home-derived config root and plugins dir at the resolved home", async () => {
		// Discovery reads user-scope skills from `<configRoot>/agent/skills` and
		// user-scope MCP from `<configRoot>/agent/mcp.json`. Everything derived from
		// the home must move together, or reads and writes straddle two homes.
		const planted = await tempDir();
		vi.spyOn(os, "homedir").mockReturnValue(planted);

		expect(getConfigRootDir()).toBe(path.join(planted, CONFIG_DIR_NAME));
		expect(getTrustedConfigRootDir()).toBe(path.join(planted, CONFIG_DIR_NAME));
		expect(getPluginsDir()).toBe(path.join(planted, CONFIG_DIR_NAME, "plugins"));
	});

	it("keeps every cached path consistent when the home changes twice", async () => {
		// The resolver caches subdirectory paths. A stale cache is the same defect
		// as a stale snapshot, so a second change must invalidate the first.
		const first = await tempDir();
		const second = await tempDir();
		const spy = vi.spyOn(os, "homedir").mockReturnValue(first);
		expect(getConfigRootDir()).toBe(path.join(first, CONFIG_DIR_NAME));
		expect(getPluginsDir()).toBe(path.join(first, CONFIG_DIR_NAME, "plugins"));

		spy.mockReturnValue(second);
		expect(getTrustedHomeDir()).toBe(second);
		expect(getConfigRootDir()).toBe(path.join(second, CONFIG_DIR_NAME));
		expect(getPluginsDir()).toBe(path.join(second, CONFIG_DIR_NAME, "plugins"));
	});

	it("restores the ambient home once the override is gone", async () => {
		const ambient = getTrustedHomeDir();
		const planted = await tempDir();
		const spy = vi.spyOn(os, "homedir").mockReturnValue(planted);
		expect(getTrustedHomeDir()).toBe(planted);

		spy.mockRestore();
		expect(getTrustedHomeDir()).toBe(ambient);
		expect(getConfigRootDir()).toBe(path.join(ambient, CONFIG_DIR_NAME));
	});

	it("never anchors user state at a filesystem root", async () => {
		// A bare root would place user state at `/.gjc`. It is rejected as a
		// candidate, so resolution falls through to the account home rather than
		// adopting the root and failing later.
		const root = path.parse(process.cwd()).root;
		vi.spyOn(os, "homedir").mockReturnValue(root);

		const resolved = getTrustedHomeDir();
		expect(resolved).not.toBe(root);
		expect(path.isAbsolute(resolved)).toBe(true);
		expect(getConfigRootDir()).toBe(path.join(resolved, CONFIG_DIR_NAME));
	});

	it("never anchors user state beneath the working directory for a relative home", async () => {
		// Bun returns `HOME` verbatim, so a relative value would put the config
		// root, agent dir and plugins dir under whatever cwd happens to be. The
		// runtime home must be held to the same standard as the account home.
		vi.spyOn(os, "homedir").mockReturnValue("relative/evil");

		const resolved = getTrustedHomeDir();
		expect(path.isAbsolute(resolved)).toBe(true);
		expect(resolved).not.toBe("relative/evil");
		expect(resolved).not.toBe(path.resolve("relative/evil"));
		expect(getConfigRootDir().startsWith(process.cwd() + path.sep)).toBe(false);
		expect(getPluginsDir().startsWith(process.cwd() + path.sep)).toBe(false);
	});

	it("rejects every spelling of a filesystem root, not just the canonical one", async () => {
		// A root has many spellings. Comparing the raw string against
		// `path.parse(home).root` misses `/.`, `//`, `/..` and `/foo/..`, and
		// `path.join(home, ".gjc")` turns every one of them into `/.gjc`.
		const root = path.parse(process.cwd()).root;
		for (const alias of ["/.", "//", "/..", "/foo/..", "/./", "/../.."]) {
			const spy = vi.spyOn(os, "homedir").mockReturnValue(alias);
			const resolved = getTrustedHomeDir();
			expect(resolved).not.toBe(alias);
			expect(path.resolve(resolved)).not.toBe(root);
			expect(getConfigRootDir()).not.toBe(path.join(root, CONFIG_DIR_NAME));
			spy.mockRestore();
		}
	});

	it("resolves an empty runtime home to an absolute account home", async () => {
		// An empty string is neither absolute nor a root; it must not survive as a
		// candidate and produce a bare `/.gjc`.
		vi.spyOn(os, "homedir").mockReturnValue("");

		const resolved = getTrustedHomeDir();
		expect(path.isAbsolute(resolved)).toBe(true);
		expect(resolved).not.toBe(path.parse(process.cwd()).root);
	});

	// The two agent-directory lanes run out of process. `setAgentDir` can only
	// install an *override* resolver, so an in-process restore would latch
	// `#agentDirOverride` on a resolver that started out as the default and pin
	// later tests to a deleted temp dir. A subprocess cannot leak into this
	// worker's module-level resolver at all, which is what the `before` snapshot
	// in each result proves.
	it("pins an operator override and re-roots a default agent dir, without touching this worker", async () => {
		// Both lanes and the isolation check run in one ordered test so the parent
		// agent directory is observed directly before and after the probes.
		// `getConfigRootDir()` cannot stand in for that: it is home-derived and
		// stays correct even when `#agentDirOverride` is latched, so it would pass
		// against exactly the defect this is meant to rule out.
		const parentAgentDirBefore = getAgentDir();

		// Lane 1: `GJC_CODING_AGENT_DIR` is an explicit operator selection, not a
		// home-derived path. Re-deriving the home must not drag it around.
		const override = await tempDir();
		const overrideSecondHome = await tempDir();
		const pinned = await probe({ agentDirOverride: override, secondHome: overrideSecondHome });

		expect(pinned.overrideDeclared).toBe(override);
		expect(pinned.before.agentDir).toBe(override);
		// The home moved, so config root follows; the operator's agent dir does not.
		expect(pinned.after.trustedHome).toBe(overrideSecondHome);
		expect(pinned.after.configRoot).toBe(path.join(overrideSecondHome, CONFIG_DIR_NAME));
		expect(pinned.after.agentDir).toBe(override);
		expect(pinned.after.agentDb).toBe(pinned.before.agentDb);

		// Lane 2: without an override the agent dir is home-derived, so user-scope
		// skills (`<agentDir>/skills`) and MCP (`<agentDir>/mcp.json`) must follow
		// the resolved home. This is the discovery path that regressed.
		const firstHome = await tempDir();
		const secondHome = await tempDir();
		const rerooted = await probe({ agentDirOverride: null, secondHome, home: firstHome });

		expect(rerooted.overrideDeclared).toBeNull();
		expect(rerooted.before.trustedHome).toBe(firstHome);
		expect(rerooted.before.agentDir).toBe(path.join(firstHome, CONFIG_DIR_NAME, "agent"));
		expect(rerooted.after.trustedHome).toBe(secondHome);
		expect(rerooted.after.agentDir).toBe(path.join(secondHome, CONFIG_DIR_NAME, "agent"));
		expect(rerooted.after.configRoot).toBe(path.join(secondHome, CONFIG_DIR_NAME));

		// Isolation: neither child mutated this worker's resolver. Asserting the
		// agent directory itself is what proves no override was latched here.
		expect(getAgentDir()).toBe(parentAgentDirBefore);
		const ambient = getTrustedHomeDir();
		expect(getConfigRootDir()).toBe(path.join(ambient, CONFIG_DIR_NAME));
	});

	it("keeps an agent directory on one storage lane across a home refresh", async () => {
		// Naming the default profile explicitly IS the default profile, XDG included
		// (pinned by dirs-python-gateway.test.ts). What must never happen is a lane
		// *change*: an agent directory decided at construction must not be re-decided
		// from path shape because a home refresh made it coincide with the new
		// default. `getAgentDir()` would look unchanged while `agent.db` moved into
		// `$XDG_DATA_HOME/gjc` -- the same store read through two roots.
		const firstHome = await tempDir();
		const secondHome = await tempDir();
		const xdgDataHome = await tempDir();
		await fs.mkdir(path.join(xdgDataHome, "gjc"), { recursive: true });
		// Not the default under the startup home, but exactly the default under the
		// home the resolver refreshes to.
		const override = path.join(secondHome, CONFIG_DIR_NAME, "agent");
		await fs.mkdir(override, { recursive: true });

		const probed = await probe({ agentDirOverride: override, secondHome, home: firstHome, xdgDataHome });

		expect(probed.before.agentDir).toBe(override);
		expect(probed.before.agentDb).toBe(path.join(override, "agent.db"));
		expect(probed.after.agentDir).toBe(override);
		expect(probed.after.agentDb).toBe(probed.before.agentDb);
		expect(probed.after.agentDb).not.toBe(path.join(xdgDataHome, "gjc", "agent.db"));
	});

	it("keeps an XDG-eligible agent dir on XDG after a home refresh makes it non-default", async () => {
		// The converse of the case above. A dir that WAS the default at construction
		// stays XDG-eligible even once a home refresh makes its path no longer equal
		// the default. Without stickiness the recomputation flips it off the XDG lane
		// mid-process, so `agent.db` would move out of `$XDG_DATA_HOME/gjc` while the
		// agent dir itself never changed.
		const firstHome = await tempDir();
		const secondHome = await tempDir();
		const xdgDataHome = await tempDir();
		await fs.mkdir(path.join(xdgDataHome, "gjc"), { recursive: true });
		// Exactly the default under the *startup* home, so it starts XDG-eligible;
		// after the refresh to `secondHome` the same path is no longer the default.
		const agentDir = path.join(firstHome, CONFIG_DIR_NAME, "agent");
		await fs.mkdir(agentDir, { recursive: true });

		const probed = await probe({ agentDirOverride: agentDir, secondHome, home: firstHome, xdgDataHome });

		expect(probed.before.agentDir).toBe(agentDir);
		expect(probed.before.agentDb).toBe(path.join(xdgDataHome, "gjc", "agent.db"));
		// The home moved and the path is no longer default-shaped, but the lane holds.
		expect(probed.after.agentDir).toBe(agentDir);
		expect(probed.after.agentDb).toBe(probed.before.agentDb);
	});

	it("puts a parent and its child on the same storage lane for one profile", async () => {
		// `setAgentDir()` exports `GJC_CODING_AGENT_DIR`, so a child inherits the
		// exact value the parent set programmatically and cannot distinguish the two.
		// If an inherited agent dir equal to the default were treated as "not the
		// default profile", parent and child would read one logical store through two
		// different lanes -- the parent under `$XDG_STATE_HOME/gjc`, the child under
		// `<agentDir>` -- silently splitting live state in half.
		const home = await tempDir();
		const xdgStateHome = await tempDir();
		await fs.mkdir(path.join(xdgStateHome, "gjc"), { recursive: true });
		const defaultAgent = path.join(home, CONFIG_DIR_NAME, "agent");
		await fs.mkdir(defaultAgent, { recursive: true });

		const read = async (env: Record<string, string>): Promise<string> => {
			const childEnv: Record<string, string> = {};
			for (const [key, value] of Object.entries(process.env)) {
				if (value !== undefined) childEnv[key] = value;
			}
			delete childEnv.GJC_CODING_AGENT_DIR;
			delete childEnv.PI_CODING_AGENT_DIR;
			delete childEnv.GJC_CONFIG_DIR;
			delete childEnv.PI_CONFIG_DIR;
			Object.assign(childEnv, env);
			const source = `import { getPythonGatewayDir } from ${JSON.stringify(DIRS)};\nconsole.log(getPythonGatewayDir());`;
			const proc = Bun.spawn([process.execPath, "-e", source], { env: childEnv, stdout: "pipe", stderr: "pipe" });
			const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
			if ((await proc.exited) !== 0) throw new Error(`probe failed: ${err}`);
			return out.trim().split("\n").at(-1) ?? "";
		};

		const withoutOverride = await read({ HOME: home, XDG_STATE_HOME: xdgStateHome });
		const withInherited = await read({
			HOME: home,
			XDG_STATE_HOME: xdgStateHome,
			GJC_CODING_AGENT_DIR: defaultAgent,
		});

		expect(withInherited).toBe(withoutOverride);
	});

	it("honors an explicit non-authoritative home for plugins without moving the resolver", async () => {
		// `getPluginsDir(home)` is the documented escape hatch for callers that
		// carry their own home. It must not disturb the authoritative resolution.
		const planted = await tempDir();
		vi.spyOn(os, "homedir").mockReturnValue(planted);
		const explicit = await tempDir();

		expect(getPluginsDir(explicit)).toBe(path.join(explicit, CONFIG_DIR_NAME, "plugins"));
		// Passing the authoritative home is identical to the no-arg form.
		expect(getPluginsDir(planted)).toBe(getPluginsDir());
		expect(getTrustedHomeDir()).toBe(planted);
	});

	it("short-circuits an explicit plugin home when authoritative home is unavailable", async () => {
		const explicit = await tempDir();
		const root = path.parse(process.cwd()).root;
		vi.spyOn(os, "homedir").mockReturnValue(root);
		vi.spyOn(os, "userInfo").mockImplementation(() => {
			throw new Error("account identity unavailable");
		});
		if (process.platform !== "win32") vi.spyOn(process, "geteuid").mockReturnValue(65534);

		expect(getPluginsDir(explicit)).toBe(path.join(explicit, CONFIG_DIR_NAME, "plugins"));
	});

	it("never treats the project directory as the home", async () => {
		// Project scope (`<cwd>/.gjc`) and user scope (`<home>/.gjc`) must stay
		// distinct: collapsing them is what makes a checkout's `.gjc` readable as
		// trusted user state.
		const planted = await tempDir();
		vi.spyOn(os, "homedir").mockReturnValue(planted);
		expect(getConfigRootDir()).not.toBe(path.join(process.cwd(), CONFIG_DIR_NAME));
		expect(getTrustedHomeDir()).not.toBe(process.cwd());
	});
});
