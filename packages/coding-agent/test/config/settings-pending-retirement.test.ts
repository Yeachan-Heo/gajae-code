import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import * as nodeCrypto from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { safeRm } from "../../../../scripts/safe-cleanup";

const PROBE = path.join(import.meta.dir, "../fixtures/settings-workflow-migration-probe.ts");

const temporaryDirectories: string[] = [];

function symlinkCreationAllowed(): boolean {
	const directory = fsSync.mkdtempSync(path.join(os.tmpdir(), "gjc-symlink-probe-"));
	try {
		fsSync.symlinkSync("target", path.join(directory, "link"));
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		const denied = code === "EPERM" || code === "EACCES";
		if (denied) {
			return false;
		}
		throw error;
	} finally {
		fsSync.rmSync(directory, { recursive: true, force: true });
	}
}

const symlinkAllowed = process.platform === "win32" ? false : symlinkCreationAllowed();

async function tempDir(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-retirement-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => safeRm(directory, { recursive: true, force: true })),
	);
});

async function loadAgentSettings(cwd: string, home: string): Promise<void> {
	const proc = Bun.spawn([process.execPath, PROBE], {
		cwd,
		env: {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			GJC_CONFIG_DIR: ".myconfig",
			GJC_CODING_AGENT_DIR: undefined,
			PI_CODING_AGENT_DIR: undefined,
			PI_CONFIG_DIR: undefined,
			XDG_DATA_HOME: undefined,
			XDG_STATE_HOME: undefined,
			XDG_CACHE_HOME: undefined,
			XDG_CONFIG_HOME: undefined,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	if ((await proc.exited) !== 0) throw new Error(`probe failed (exit ${await proc.exited}): ${err}\n${out}`);
}

async function setupAgent(home: string): Promise<{ agentDir: string; settingsPath: string }> {
	const agentDir = path.join(home, ".myconfig", "agent");
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	const settingsPath = path.join(agentDir, "settings.json");
	await fs.writeFile(settingsPath, JSON.stringify({ "theme.dark": "red-claw" }), { mode: 0o600 });
	return { agentDir, settingsPath };
}

/** Leave the marker on disk: a malformed legacy row aborts the load after the marker write. */
function plantUnreadableLegacyDatabase(agentDir: string): void {
	const db = new Database(path.join(agentDir, "agent.db"));
	db.run("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0)");
	db.run("CREATE TABLE schema_version (version INTEGER PRIMARY KEY)");
	db.run("INSERT INTO schema_version (version) VALUES (5)");
	db.run("INSERT INTO settings (key, value, updated_at) VALUES ('gjc.ralplan.maxIterations', '{broken', 0)");
	db.close();
}

describe("agent settings pending-retirement marker", () => {
	test.skipIf(process.platform === "win32" || !symlinkAllowed)(
		"a symlinked pending-retirement marker does not write the source hash outside",
		async () => {
			const home = await tempDir();
			const cwd = await tempDir();
			const outside = await tempDir();
			const { agentDir } = await setupAgent(home);
			const victim = path.join(outside, "victim-marker");
			await fs.writeFile(victim, "OUTSIDE-ORIGINAL", { mode: 0o666 });
			await fs.symlink(victim, path.join(agentDir, "settings.json.pending-retirement"));

			await loadAgentSettings(cwd, home);

			expect(await fs.readFile(victim, "utf8")).toBe("OUTSIDE-ORIGINAL");
			expect((await fs.lstat(path.join(agentDir, "settings.json.pending-retirement"))).isSymbolicLink()).toBe(true);
			expect(await fs.readFile(path.join(agentDir, "settings.json"), "utf8")).toContain("red-claw");
		},
	);

	test.skipIf(process.platform === "win32" || !symlinkAllowed)(
		"a symlinked pending-retirement marker does not retire an edited settings.json",
		async () => {
			const home = await tempDir();
			const cwd = await tempDir();
			const outside = await tempDir();
			const { agentDir, settingsPath } = await setupAgent(home);
			const edited = JSON.stringify({ "gjc.ralplan.maxIterations": 9 });
			await fs.writeFile(settingsPath, edited, { mode: 0o600 });
			await fs.writeFile(
				path.join(agentDir, "config.yml"),
				"configSchemaVersion: 2\ngjc:\n  ralplan:\n    maxIterations: 7\n",
			);
			const victim = path.join(outside, "victim-marker");
			const staleHash = nodeCrypto
				.createHash("sha256")
				.update(JSON.stringify({ "gjc.ralplan.maxIterations": 7 }))
				.digest("hex");
			await fs.writeFile(victim, staleHash, { mode: 0o600 });
			await fs.symlink(victim, path.join(agentDir, "settings.json.pending-retirement"));

			await loadAgentSettings(cwd, home);

			expect(await fs.readFile(victim, "utf8")).toBe(staleHash);
			expect(await fs.readFile(settingsPath, "utf8")).toBe(edited);
			expect(await fs.stat(`${settingsPath}.bak`).catch(() => null)).toBeNull();
			const config = await fs.readFile(path.join(agentDir, "config.yml"), "utf8");
			expect(config).toContain("maxIterations: 7");
			expect(config).not.toContain("maxIterations: 9");
			expect((await fs.lstat(path.join(agentDir, "settings.json.pending-retirement"))).isSymbolicLink()).toBe(true);
		},
	);

	test.skipIf(process.platform === "win32")(
		"an existing mode 0666 pending-retirement marker is rewritten to mode 0600",
		async () => {
			const home = await tempDir();
			const cwd = await tempDir();
			const { agentDir, settingsPath } = await setupAgent(home);
			const marker = path.join(agentDir, "settings.json.pending-retirement");
			await fs.writeFile(marker, "old-marker");
			await fs.chmod(marker, 0o666);
			plantUnreadableLegacyDatabase(agentDir);

			await loadAgentSettings(cwd, home);

			const raw = await fs.readFile(settingsPath, "utf8");
			expect(await fs.readFile(marker, "utf8")).toBe(nodeCrypto.createHash("sha256").update(raw).digest("hex"));
			expect((await fs.stat(marker)).mode & 0o777).toBe(0o600);
		},
	);

	test("keeps a new pending-retirement marker at mode 0600", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { agentDir, settingsPath } = await setupAgent(home);
		plantUnreadableLegacyDatabase(agentDir);

		await loadAgentSettings(cwd, home);

		const marker = path.join(agentDir, "settings.json.pending-retirement");
		const raw = await fs.readFile(settingsPath, "utf8");
		expect(await fs.readFile(marker, "utf8")).toBe(nodeCrypto.createHash("sha256").update(raw).digest("hex"));
		if (process.platform !== "win32") {
			expect((await fs.stat(marker)).mode & 0o777).toBe(0o600);
		}
		expect(await fs.readFile(settingsPath, "utf8")).toBe(raw);
	});

	test("still allows a regular agent settings file to migrate", async () => {
		const home = await tempDir();
		const cwd = await tempDir();
		const { agentDir, settingsPath } = await setupAgent(home);

		await loadAgentSettings(cwd, home);

		expect(await fs.stat(settingsPath).catch(() => null)).toBeNull();
		expect(await fs.readFile(`${settingsPath}.bak`, "utf8")).toContain("red-claw");
		expect(await fs.readFile(path.join(agentDir, "config.yml"), "utf8")).toContain("red-claw");
		expect(await fs.lstat(`${settingsPath}.pending-retirement`).catch(() => null)).toBeNull();
	});
});
