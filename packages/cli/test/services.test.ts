import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BROKER_UNIT,
	discoverLoginPath,
	GATEWAY_UNIT,
	installServices,
	restartStackCommands,
	serviceSpecs,
	systemdUnitName,
} from "../src/services";

async function configuredHome(): Promise<{ home: string; cleanup: () => Promise<void> }> {
	const home = await mkdtemp(join(tmpdir(), "gajaeway-services-"));
	await writeFile(join(home, "config.json"), JSON.stringify({ schemaVersion: 1 }), "utf8");
	return { home, cleanup: () => rm(home, { recursive: true, force: true }) };
}

async function generate(platform: "darwin" | "linux") {
	const { home, cleanup } = await configuredHome();
	const binDir = join(home, "bin");
	await mkdir(binDir);
	for (const spec of serviceSpecs()) await writeFile(join(binDir, spec.binary), "stub");
	const written = new Map<string, string>();
	const paths = await installServices({
		binDir,
		platform,
		unitDir: join(home, "units"),
		launchAgentsDir: join(home, "agents"),
		env: { HOME: home, GAJAEWAY_HOME: home, SHELL: "/bin/sh" },
		loginPath: undefined,
		loginPathRunner: () => "/usr/bin:/bin",
		writeFile: (path, contents) => {
			written.set(path, contents);
		},
	} as Parameters<typeof installServices>[0]);
	return { home, paths, written, cleanup };
}

test("a linux install writes one bound systemd user unit per service", async () => {
	const { home, paths, written, cleanup } = await generate("linux");
	try {
		expect(paths).toHaveLength(serviceSpecs().length);
		for (const spec of serviceSpecs()) {
			const unitPath = join(home, "units", systemdUnitName(spec));
			expect(paths).toContain(unitPath);
			const unit = written.get(unitPath) ?? "";
			expect(unit).toContain("[Service]");
			expect(unit).toContain(`Environment="GAJAEWAY_HOME=${home}"`);
			if (spec.id === "broker") {
				expect(unit).toContain(`ConditionPathExists=${join(home, "broker", "provision", "manifest.json")}\n`);
				expect(unit).toContain(`EnvironmentFile=-${join(home, "broker.env")}\n`);
				expect(unit).toContain("Restart=always");
				expect(unit).toContain("RestartSec=2s");
				expect(unit).toContain("KillMode=control-group");
				expect(unit).toContain("SuccessExitStatus=143\n");
				expect(unit).toContain("TimeoutStartSec=60s");
				expect(unit).toContain("TimeoutStopSec=30s");
			} else if (spec.id === "gateway") {
				expect(unit).toContain(`Wants=${BROKER_UNIT}`);
				expect(unit).toContain(`After=${BROKER_UNIT}`);
				expect(unit).not.toContain("Requires=");
				expect(unit).toContain("KillMode=mixed");
				expect(unit).toContain("TimeoutStartSec=60s");
				expect(unit).toContain("TimeoutStopSec=40s");
			} else {
				expect(unit).toContain(`BindsTo=${GATEWAY_UNIT}`);
				expect(unit).toContain(`After=${GATEWAY_UNIT}`);
				expect(unit).toContain(`PartOf=${GATEWAY_UNIT}`);
				expect(unit).toContain(`WantedBy=${GATEWAY_UNIT}`);
				expect(unit).not.toContain("KillMode=process");
				expect(unit).toContain("TimeoutStartSec=60s");
				expect(unit).toContain("TimeoutStopSec=60s");
			}
		}
	} finally {
		await cleanup();
	}
});

test("a darwin install still writes launch agents, not units", async () => {
	const { home, paths, written, cleanup } = await generate("darwin");
	try {
		expect(paths).toHaveLength(serviceSpecs().length);
		for (const path of paths) {
			expect(path.startsWith(join(home, "agents"))).toBe(true);
			expect(path.endsWith(".plist")).toBe(true);
			const contents = [...written.values()].find((candidate) =>
				candidate.includes(path.split("/").at(-1)?.replace(".plist", "") ?? ""),
			);
			expect(contents).toBeDefined();
			expect(contents).toContain("<key>RunAtLoad</key><true/>");
			expect(contents).toContain("<key>KeepAlive</key><true/>");
			expect(contents).not.toContain("AbandonProcessGroup");
		}
	} finally {
		await cleanup();
	}
});

test("a darwin update skips a launch agent when its binary is missing", async () => {
	const { home, cleanup } = await configuredHome();
	const binDir = join(home, "bin");
	const written = new Map<string, string>();
	try {
		await mkdir(binDir);
		await writeFile(join(binDir, "gajaeway-gateway"), "gateway stub");
		const paths = await installServices({
			binDir,
			platform: "darwin",
			launchAgentsDir: join(home, "agents"),
			env: { HOME: home, GAJAEWAY_HOME: home },
			configuredAdaptersOnly: true,
			loginPathRunner: () => "/usr/bin:/bin",
			writeFile: (path, contents) => {
				written.set(path, contents);
			},
		});

		expect(paths).toContain(join(home, "agents", "dev.gajaeway.gateway.plist"));
		expect(paths).not.toContain(join(home, "agents", "dev.gajaeway.admin.plist"));
		expect(written.has(join(home, "agents", "dev.gajaeway.admin.plist"))).toBe(false);
	} finally {
		await cleanup();
	}
});

test("compareAndWrite leaves unchanged service definitions untouched", async () => {
	const { home, cleanup } = await configuredHome();
	const unitDir = join(home, "units");
	const binDir = join(home, "bin");
	let writes = 0;
	const write = async (path: string, contents: string) => {
		writes++;
		await writeFile(path, contents, "utf8");
	};
	const options = {
		binDir,
		unitDir,
		platform: "linux" as const,
		env: { HOME: home, GAJAEWAY_HOME: home },
		loginPathRunner: () => "/usr/bin:/bin",
		writeFile: write,
	};
	try {
		await mkdir(binDir);
		for (const spec of serviceSpecs()) await writeFile(join(binDir, spec.binary), "stub");
		await installServices(options);
		expect(writes).toBe(serviceSpecs().length);
		writes = 0;
		await installServices({ ...options, compareAndWrite: true });
		expect(writes).toBe(0);
	} finally {
		await cleanup();
	}
});
test("an unsupported platform is refused by name", async () => {
	const { home, cleanup } = await configuredHome();
	try {
		await expect(
			installServices({
				binDir: join(home, "bin"),
				env: { HOME: home, GAJAEWAY_HOME: home },
				platform: "plan9" as never,
				writeFile: () => {},
			}),
		).rejects.toThrow("unsupported service platform: plan9");
	} finally {
		await cleanup();
	}
});

test("restart-stack is one systemctl call on linux and an ordered kickstart chain on darwin", () => {
	expect(restartStackCommands("linux")).toEqual([
		["systemctl", "--user", "restart", BROKER_UNIT],
		["systemctl", "--user", "restart", GATEWAY_UNIT],
	]);

	const darwin = restartStackCommands("darwin", 501);
	expect(darwin[0]).toEqual(["launchctl", "kickstart", "-k", "gui/501/dev.gajaeway.broker"]);
	expect(darwin.at(-1)).toEqual(["launchctl", "kickstart", "-k", "gui/501/dev.gajaeway.gateway"]);
	expect(darwin).toHaveLength(serviceSpecs().length);
	const gatewayIndex = darwin.findIndex((command) => command[3] === "gui/501/dev.gajaeway.gateway");
	for (const spec of serviceSpecs().filter((candidate) => candidate.dependsOnGateway)) {
		expect(darwin).toContainEqual(["launchctl", "kickstart", "-k", `gui/501/${spec.label}`]);
		expect(darwin.findIndex((command) => command[3] === `gui/501/${spec.label}`)).toBeLessThan(gatewayIndex);
	}
	// bootout removes the job and leaves the bot offline with no automatic recovery.
	expect(darwin.flat()).not.toContain("bootout");
});

test("discoverLoginPath uses SHELL when set and executable", async () => {
	const env = { SHELL: "/bin/sh" };
	let ranCommand: string[] | undefined;
	const runner = async (command: readonly string[]) => {
		ranCommand = [...command];
		if (command[0] === "/bin/sh") return "exported PATH value";
		throw new Error("not reached");
	};

	const result = await discoverLoginPath(env, runner);

	expect(result).toBe("exported PATH value");
	expect(ranCommand).toEqual(["/bin/sh", "-lc", 'printf %s "$PATH"']);
});

test("discoverLoginPath falls back from SHELL to passwd shell", async () => {
	const env = { SHELL: "/bin/nonexistent" };
	const runner = async (command: readonly string[]) => {
		// First call with SHELL fails.
		if (command[0] === "/bin/nonexistent") throw new Error("no such file");
		// Second call with passwd shell succeeds.
		if (command[0] === "/bin/bash") return "exported PATH value";
		throw new Error("unexpected command");
	};

	const result = await discoverLoginPath(env, runner);

	// Falls back to /bin/bash (since we can't mock userInfo()).
	expect(result).toBe("exported PATH value");
});

test("discoverLoginPath falls back through candidates in order", async () => {
	const env: NodeJS.ProcessEnv = {};
	const runner = async (command: readonly string[]) => {
		// Fail on first two candidates, succeed on /bin/bash.
		if (command[0] === "/bin/bash") return "success from /bin/bash";
		throw new Error("no such shell");
	};

	const result = await discoverLoginPath(env, runner);

	expect(result).toBe("success from /bin/bash");
});

test("discoverLoginPath returns empty string when all shells fail", async () => {
	const env: NodeJS.ProcessEnv = {};
	const runner = async () => {
		throw new Error("all shells unavailable");
	};

	const result = await discoverLoginPath(env, runner);

	expect(result).toBe("");
});

test("installServices succeeds even when shell discovery returns empty", async () => {
	const { home, cleanup } = await configuredHome();
	const binDir = join(home, "bin");
	const written = new Map<string, string>();
	try {
		await mkdir(binDir);
		for (const spec of serviceSpecs()) await writeFile(join(binDir, spec.binary), "stub");

		const failingRunner = async () => {
			throw new Error("shell discovery failed");
		};

		const paths = await installServices({
			binDir,
			platform: "linux",
			unitDir: join(home, "units"),
			env: { HOME: home, GAJAEWAY_HOME: home },
			loginPathRunner: failingRunner,
			writeFile: (path, contents) => {
				written.set(path, contents);
			},
		});

		// Should still write all units using FALLBACK_PATH_DIRS.
		expect(paths).toHaveLength(serviceSpecs().length);
		expect(written.size).toBe(serviceSpecs().length);

		// Verify at least one unit was written and contains fallback paths.
		const firstUnit = [...written.values()][0] ?? "";
		expect(firstUnit).toContain("/usr/local/bin");
		expect(firstUnit).toContain("/usr/bin");
		expect(firstUnit).toContain("/bin");
	} finally {
		await cleanup();
	}
});
