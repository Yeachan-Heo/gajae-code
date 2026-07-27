import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
	agentDir: string;
	probeValue: string | null;
}

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-agent-dir-trust-"));
	tempDirs.push(dir);
	return dir;
}

/** A directory holding an `.env` that sets the probe variable. */
function agentDirWith(value: string): string {
	const dir = tempDir();
	fs.writeFileSync(path.join(dir, ".env"), `${PROBE_VAR}=${value}\n`);
	return dir;
}

function projectDir(dotenv: string): string {
	const dir = tempDir();
	fs.writeFileSync(path.join(dir, ".env"), dotenv);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

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
});
