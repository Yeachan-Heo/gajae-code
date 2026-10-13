import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Default `/share` spawns `gh auth status` and `gh gist create` with an
 * explicit environment copy. The project dotenv is already in that environment.
 * These probes use the public `handleShareCommand` entry.
 */

const PROBE = path.join(import.meta.dir, "../../fixtures/share-gh-env-probe.ts");
const DESTINATION_KEYS = ["GH_HOST", "GH_CONFIG_DIR", "GH_TOKEN", "GH_HOST_PLANTED", "GH_CONFIG_PLANTED"] as const;

interface GhSpawn {
	args: string[];
	GH_HOST: string | null;
	GH_CONFIG_DIR: string | null;
	GH_TOKEN: string | null;
}

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeGh(binDir: string): void {
	fs.mkdirSync(binDir, { recursive: true });
	const gh = path.join(binDir, "gh");
	fs.writeFileSync(
		gh,
		`#!/usr/bin/env -S bun --no-env-file
import { appendFileSync } from "node:fs";
const record = process.env.GJC_SHARE_GH_RECORD;
if (!record) {
	console.error("missing share record");
	process.exit(2);
}
appendFileSync(
	record,
	JSON.stringify({
		args: process.argv.slice(2),
		GH_HOST: process.env.GH_HOST ?? null,
		GH_CONFIG_DIR: process.env.GH_CONFIG_DIR ?? null,
		GH_TOKEN: process.env.GH_TOKEN ?? null,
	}) + "\\n",
);
if (process.argv[2] === "auth") process.exit(0);
process.stdout.write("https://gist.github.com/example/abc123\\n");
`,
	);
	fs.chmodSync(gh, 0o755);
	const open = path.join(binDir, "open");
	fs.writeFileSync(open, "#!/bin/sh\nexit 0\n");
	fs.chmodSync(open, 0o755);
}

async function share(options: {
	dotenv?: string;
	env?: Record<string, string>;
	moveAway?: boolean;
	autoload?: boolean;
}): Promise<GhSpawn[]> {
	const cwd = tempDir("gjc-share-gh-env-");
	if (options.dotenv !== undefined) fs.writeFileSync(path.join(cwd, ".env"), options.dotenv);
	const binDir = path.join(cwd, "bin");
	const record = path.join(cwd, "spawns.ndjson");
	writeGh(binDir);
	const moveTo = options.moveAway ? tempDir("gjc-share-gh-move-") : undefined;

	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	for (const key of DESTINATION_KEYS) delete env[key];
	delete env.GJC_SHARE_EXPECT_HOST;
	delete env.GJC_SHARE_EXPECT_CONFIG;
	delete env.GJC_SHARE_MOVE_TO;
	env.GJC_SHARE_GH_RECORD = record;
	env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
	if (moveTo) env.GJC_SHARE_MOVE_TO = moveTo;
	Object.assign(env, options.env);

	const args = options.autoload ? [PROBE] : ["--no-env-file", PROBE];
	const proc = Bun.spawn([process.execPath, ...args], {
		cwd,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr || stdout}`);
	if (!fs.existsSync(record)) throw new Error(`probe produced no gh spawns: ${stderr || stdout}`);
	const spawns = fs
		.readFileSync(record, "utf8")
		.trim()
		.split("\n")
		.filter(line => line.length > 0)
		.map(line => JSON.parse(line) as GhSpawn);
	if (spawns.length !== 2) throw new Error(`expected auth and gist spawns, got ${JSON.stringify(spawns)} ${stderr}`);
	return spawns;
}

function expectDestination(
	spawns: GhSpawn[],
	expected: { GH_HOST: string | null; GH_CONFIG_DIR: string | null; GH_TOKEN: string | null },
): void {
	expect(spawns[0]?.args).toEqual(["auth", "status"]);
	expect(spawns[1]?.args.slice(0, 3)).toEqual(["gist", "create", "--public=false"]);
	for (const spawn of spawns) {
		expect(spawn.GH_HOST).toBe(expected.GH_HOST);
		expect(spawn.GH_CONFIG_DIR).toBe(expected.GH_CONFIG_DIR);
		expect(spawn.GH_TOKEN).toBe(expected.GH_TOKEN);
	}
}

// The recorder is a POSIX `env -S bun --no-env-file` script so it reports the
// environment `/share` passed in, instead of loading the project dotenv itself.
describe.skipIf(process.platform === "win32")("share gh destination trust", () => {
	it("omits a project dotenv host and config directory from both gh spawns", async () => {
		const spawns = await share({
			dotenv: "export GH_HOST=attacker-egress.example # note\nGH_CONFIG_DIR=attacker-config\n",
			env: {
				GH_TOKEN: "operator-token",
				GJC_SHARE_EXPECT_HOST: "attacker-egress.example",
				GJC_SHARE_EXPECT_CONFIG: "attacker-config",
			},
		});
		expectDestination(spawns, { GH_HOST: null, GH_CONFIG_DIR: null, GH_TOKEN: "operator-token" });
	});

	it("keeps an operator host and config directory the project does not declare", async () => {
		const spawns = await share({
			dotenv: "OTHER=1\n",
			env: {
				GH_HOST: "ghe.example.com",
				GH_CONFIG_DIR: "operator-config",
				GH_TOKEN: "operator-token",
				GJC_SHARE_EXPECT_HOST: "ghe.example.com",
				GJC_SHARE_EXPECT_CONFIG: "operator-config",
			},
		});
		expectDestination(spawns, {
			GH_HOST: "ghe.example.com",
			GH_CONFIG_DIR: "operator-config",
			GH_TOKEN: "operator-token",
		});
	});

	it("keeps an operator host that differs from the project declaration", async () => {
		const spawns = await share({
			dotenv: "GH_HOST=attacker-egress.example\nGH_CONFIG_DIR=attacker-config\n",
			env: {
				GH_HOST: "ghe.example.com",
				GH_CONFIG_DIR: "operator-config",
				GH_TOKEN: "operator-token",
				GJC_SHARE_EXPECT_HOST: "ghe.example.com",
				GJC_SHARE_EXPECT_CONFIG: "operator-config",
			},
		});
		expectDestination(spawns, {
			GH_HOST: "ghe.example.com",
			GH_CONFIG_DIR: "operator-config",
			GH_TOKEN: "operator-token",
		});
	});

	it("still omits the launch project host after the session cwd moves", async () => {
		const spawns = await share({
			dotenv: "GH_HOST=attacker-egress.example\nGH_CONFIG_DIR=attacker-config\n",
			moveAway: true,
			env: {
				GH_TOKEN: "operator-token",
				GJC_SHARE_EXPECT_HOST: "attacker-egress.example",
				GJC_SHARE_EXPECT_CONFIG: "attacker-config",
			},
		});
		expectDestination(spawns, { GH_HOST: null, GH_CONFIG_DIR: null, GH_TOKEN: "operator-token" });
	});

	it("omits a dynamic project declaration even when the runtime value differs", async () => {
		const spawns = await share({
			autoload: true,
			dotenv: `GH_HOST=$${""}{GH_HOST_PLANTED}\nGH_CONFIG_DIR=$${""}{GH_CONFIG_PLANTED}\n`,
			env: {
				GH_HOST_PLANTED: "attacker-egress.example",
				GH_CONFIG_PLANTED: "attacker-config",
				GH_TOKEN: "operator-token",
				GJC_SHARE_EXPECT_HOST: "attacker-egress.example",
				GJC_SHARE_EXPECT_CONFIG: "attacker-config",
			},
		});
		expectDestination(spawns, { GH_HOST: null, GH_CONFIG_DIR: null, GH_TOKEN: "operator-token" });
	});
});
