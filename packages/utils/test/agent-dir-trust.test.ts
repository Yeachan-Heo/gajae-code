import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createTrustTempDirs } from "./helpers/trust-temp-dirs";

/**
 * `GJC_CODING_AGENT_DIR` selects the agent directory, and the agent's own `.env`
 * is one of the trusted sources `$credentialEnv` consults. Bun loads `cwd/.env`
 * into `process.env` before any module runs, so a repository that plants this
 * variable can point the agent directory at a directory it ships — making its
 * own `.env` "trusted" and recovering every redirect the credential boundary is
 * meant to reject.
 *
 * Both the override and `projectEnv` are resolved at module load from
 * `process.cwd()`, so these drive a child process with a controlled cwd.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "agent-dir-trust-probe.ts");
const PROBE_VAR = "GJC_TRUST_PROBE_VALUE";

interface Resolved {
	trustedHome: string;
	agentDir: string;
	configRoot: string;
	pluginsDir: string;
	pythonGatewayDir: string;
	probeValue: string | null;
}

const { tempDir, projectDir } = createTrustTempDirs("gjc-agent-dir-trust-");

/** A directory holding an `.env` that sets the probe variable. */
function agentDirWith(value: string): string {
	const dir = tempDir();
	fs.writeFileSync(path.join(dir, ".env"), `${PROBE_VAR}=${value}\n`);
	return dir;
}

async function resolveIn(cwd: string, overrides: Record<string, string> = {}): Promise<Resolved> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	delete env.GJC_CODING_AGENT_DIR;
	delete env.GJC_CONFIG_DIR;
	delete env.PI_CONFIG_DIR;
	delete env[PROBE_VAR];
	// Keep the other trusted file sources neutral.
	env.HOME = tempDir();
	Object.assign(env, overrides);

	const proc = Bun.spawn([process.execPath, PROBE], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}`);
	return JSON.parse(stdout.trim()) as Resolved;
}

async function resolveWithoutPlatformHome(cwd: string, hostileHome: string): Promise<Resolved> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	if (process.platform === "win32") {
		delete env.USERPROFILE;
		env.HOME = hostileHome;
	} else {
		delete env.HOME;
		env.USERPROFILE = hostileHome;
	}
	const proc = Bun.spawn([process.execPath, PROBE], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}`);
	return JSON.parse(stdout.trim()) as Resolved;
}

/** The account home of the running user, from the passwd database on Linux. */
async function accountHomeOfRunningUser(): Promise<string> {
	if (process.platform === "linux") {
		// NSS, matching production: reading `/etc/passwd` directly would disagree
		// with the resolver for any LDAP- or SSSD-backed account, which has no local
		// entry, and report a false failure.
		// `Bun.spawn` throws when the executable is missing rather than returning a
		// non-zero exit, so a host without `getent` must fall through to the portable
		// path instead of failing the suite.
		try {
			const uid = os.userInfo().uid;
			const proc = Bun.spawn(["getent", "passwd", String(uid)], { stdout: "pipe", stderr: "ignore" });
			const stdout = await new Response(proc.stdout).text();
			if ((await proc.exited) === 0) {
				const home = stdout.split("\n")[0]?.split(":")[5];
				if (home && path.isAbsolute(home) && home !== path.parse(home).root) return home;
			}
		} catch {}
	}
	return os.userInfo().homedir;
}
describe("agent directory trust boundary", () => {
	it("honors an agent directory inherited from the launching shell", async () => {
		const agentDir = agentDirWith("from-operator-agent-env");
		const resolved = await resolveIn(projectDir("SOMETHING_ELSE=1\n"), { GJC_CODING_AGENT_DIR: agentDir });
		expect(resolved.agentDir).toBe(agentDir);
		expect(resolved.probeValue).toBe("from-operator-agent-env");
	});

	it("ignores an agent directory planted by the project .env", async () => {
		const agentDir = agentDirWith("from-attacker-agent-env");
		const resolved = await resolveIn(projectDir(`GJC_CODING_AGENT_DIR=${agentDir}\n`));
		expect(resolved.agentDir).not.toBe(agentDir);
		expect(resolved.probeValue).toBeNull();
	});

	it("ignores an exported agent directory planted by the project .env", async () => {
		const agentDir = agentDirWith("from-attacker-exported-agent-env");
		const resolved = await resolveIn(projectDir(`export GJC_CODING_AGENT_DIR=${agentDir}\n`));
		expect(resolved.agentDir).not.toBe(agentDir);
		expect(resolved.probeValue).toBeNull();
	});
	it("ignores an agent directory planted with whitespace around the equals sign", async () => {
		// Bun's dotenv loader accepts `KEY = value`; the guard must see the same key.
		const agentDir = agentDirWith("from-attacker-spaced-agent-env");
		const resolved = await resolveIn(projectDir(`GJC_CODING_AGENT_DIR = ${agentDir}\n`));
		expect(resolved.agentDir).not.toBe(agentDir);
		expect(resolved.probeValue).toBeNull();
	});

	it("does not let the project .env redirect an inherited agent directory", async () => {
		const operatorDir = agentDirWith("from-operator-agent-env");
		const attackerDir = agentDirWith("from-attacker-agent-env");
		const resolved = await resolveIn(projectDir(`GJC_CODING_AGENT_DIR=${attackerDir}\n`), {
			GJC_CODING_AGENT_DIR: operatorDir,
		});
		expect(resolved.agentDir).toBe(operatorDir);
		expect(resolved.probeValue).toBe("from-operator-agent-env");
	});

	it("ignores a config directory planted by the project .env", async () => {
		// GJC_CONFIG_DIR builds the config root, whose `.env` is another trusted source.
		const configDir = tempDir();
		fs.mkdirSync(path.join(configDir, "agent"), { recursive: true });
		fs.writeFileSync(path.join(configDir, ".env"), `${PROBE_VAR}=from-attacker-config-env\n`);
		const home = tempDir();
		const relative = path.relative(home, configDir);
		const resolved = await resolveIn(projectDir(`GJC_CONFIG_DIR=${relative}\n`), { HOME: home });
		expect(resolved.probeValue).toBeNull();
	});

	it("honors a config directory inherited from the launching shell", async () => {
		const home = tempDir();
		const configDir = path.join(home, ".custom");
		fs.mkdirSync(path.join(configDir, "agent"), { recursive: true });
		fs.writeFileSync(path.join(configDir, ".env"), `${PROBE_VAR}=from-operator-config-env\n`);
		const resolved = await resolveIn(projectDir("SOMETHING_ELSE=1\n"), { HOME: home, GJC_CONFIG_DIR: ".custom" });
		expect(resolved.probeValue).toBe("from-operator-config-env");
	});

	it("honors the PI_CODING_AGENT_DIR alias from the launching shell", async () => {
		// The module header documents the legacy alias, and gc-runtime/deep-interview
		// already resolve it. Reading only the GJC_ spelling split the agent directory
		// in two: `gjc gc` followed the alias while getAgentDir() stayed on the default.
		const agentDir = agentDirWith("from-operator-pi-alias");
		const resolved = await resolveIn(projectDir("SOMETHING_ELSE=1\n"), { PI_CODING_AGENT_DIR: agentDir });
		expect(resolved.agentDir).toBe(agentDir);
		expect(resolved.probeValue).toBe("from-operator-pi-alias");
	});

	it("ignores a PI_CODING_AGENT_DIR planted by the project .env", async () => {
		const agentDir = agentDirWith("from-attacker-pi-alias");
		const resolved = await resolveIn(projectDir(`PI_CODING_AGENT_DIR=${agentDir}\n`));
		expect(resolved.agentDir).not.toBe(agentDir);
		expect(resolved.probeValue).toBeNull();
	});

	it("prefers the GJC_ spelling when both are set", async () => {
		const gjcDir = agentDirWith("from-gjc-spelling");
		const piDir = agentDirWith("from-pi-spelling");
		const resolved = await resolveIn(projectDir("SOMETHING_ELSE=1\n"), {
			GJC_CODING_AGENT_DIR: gjcDir,
			PI_CODING_AGENT_DIR: piDir,
		});
		expect(resolved.agentDir).toBe(gjcDir);
	});

	it("uses the static higher-precedence dotenv layer for agent and XDG resolution", async () => {
		if (process.platform !== "linux") return;
		const operatorAgent = agentDirWith("from-layered-operator-agent");
		const home = tempDir();
		const xdgState = tempDir();
		const staticXdgState = tempDir();
		const xdgData = tempDir();
		const xdgCache = tempDir();
		for (const root of [xdgState, xdgData, xdgCache]) fs.mkdirSync(path.join(root, "gjc"), { recursive: true });
		const cwd = projectDir(
			`GJC_CODING_AGENT_DIR=$LOWER_DYNAMIC\nGJC_CONFIG_DIR=.layered\nXDG_STATE_HOME=$LOWER_STATE\n`,
		);
		fs.writeFileSync(
			path.join(cwd, ".env.local"),
			"GJC_CODING_AGENT_DIR=/tmp/static-project-agent\nGJC_CONFIG_DIR=.layered-static\nXDG_STATE_HOME=" +
				staticXdgState +
				"\n",
		);
		const resolved = await resolveIn(cwd, {
			HOME: home,
			NODE_ENV: "production",
			GJC_CODING_AGENT_DIR: operatorAgent,
			GJC_CONFIG_DIR: ".operator-config",
			XDG_STATE_HOME: xdgState,
			XDG_DATA_HOME: xdgData,
			XDG_CACHE_HOME: xdgCache,
		});
		expect(resolved.agentDir).toBe(operatorAgent);
		expect(resolved.configRoot).toBe(path.join(home, ".operator-config"));
		expect(resolved.pythonGatewayDir).toBe(path.join(operatorAgent, "python-gateway"));
		expect(resolved.pluginsDir).toBe(path.join(home, ".operator-config", "plugins"));
	});

	it("uses the account home when POSIX HOME is absent despite hostile USERPROFILE", async () => {
		if (process.platform === "win32") return;
		const cwd = projectDir("SOMETHING_ELSE=1\n");
		const hostileHome = tempDir();
		const resolved = await resolveWithoutPlatformHome(cwd, hostileHome);
		// Expect the passwd database directly: a parent-side os.userInfo().homedir
		// follows an isolated HOME, while the child probe has HOME deleted and
		// resolves the real account home.
		const accountHome = await accountHomeOfRunningUser();
		expect(resolved.trustedHome).toBe(accountHome);
		expect(resolved.trustedHome).not.toBe(hostileHome);
		expect(resolved.configRoot).toBe(path.join(accountHome, ".gjc"));
	});

	it("uses the account home when Windows USERPROFILE is absent despite hostile HOME", async () => {
		if (process.platform !== "win32") return;
		const cwd = projectDir("SOMETHING_ELSE=1\n");
		const hostileHome = tempDir();
		const resolved = await resolveWithoutPlatformHome(cwd, hostileHome);
		const accountHome = await accountHomeOfRunningUser();
		expect(resolved.trustedHome).toBe(accountHome);
		expect(resolved.trustedHome).not.toBe(hostileHome);
		expect(resolved.configRoot).toBe(path.join(accountHome, ".gjc"));
	});
});
