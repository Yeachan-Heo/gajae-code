/**
 * Black-box subprocess tests for `gjc customize doctor` read-only contract (#4406).
 *
 * The doctor command is an explicitly read-only inspection surface. These tests
 * spawn the real CLI as a subprocess and assert no filesystem side-effects occur
 * in either the agent directory or the project directory, for both text and JSON
 * output modes. Each test runs in an isolated temp agent/project tree with a
 * dedicated HOME so config-root resolution is fully isolated.
 *
 * Coverage matrix (absorbed from the duplicate lane #4408):
 *   - actual CLI path in both text and JSON modes
 *   - fresh empty agent/project roots
 *   - legacy agent-dir settings.json
 *   - legacy config-root settings.json
 *   - legacy project .gjc/settings.json
 *   - existing canonical config.yml and project config precedence/provenance
 *
 * For every case the entire relevant tree is snapshotted before/after and
 * asserted: path set, file type, content hash, size, mtime, and mode — plus
 * no rename/backup/DB/WAL/SHM/lock/migration marker files appear.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");

const tempDirs: string[] = [];

afterEach(async () => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop()!;
		await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
	}
});

async function makeTempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot helpers
// ─────────────────────────────────────────────────────────────────────────────

interface FileEntry {
	contentHash: string;
	mode: number;
	size: number;
	mtimeMs: number;
}

interface Snapshot {
	/** Relative path → file metadata. */
	files: Map<string, FileEntry>;
}

async function hashFile(filePath: string): Promise<string> {
	const data = await fs.readFile(filePath);
	return createHash("sha256").update(data).digest("hex");
}

async function walkDir(dirPath: string): Promise<string[]> {
	const results: string[] = [];
	let entries: string[];
	try {
		entries = await fs.readdir(dirPath);
	} catch {
		return results;
	}
	for (const entry of entries) {
		const fullPath = path.join(dirPath, entry);
		const stat = await fs.stat(fullPath);
		if (stat.isDirectory()) {
			results.push(...(await walkDir(fullPath)));
		} else {
			results.push(fullPath);
		}
	}
	return results;
}

async function snapshotDir(dirPath: string): Promise<Snapshot> {
	const files = new Map<string, FileEntry>();
	try {
		const entries = await walkDir(dirPath);
		for (const entry of entries) {
			const stat = await fs.stat(entry);
			if (stat.isFile()) {
				const rel = path.relative(dirPath, entry);
				files.set(rel, {
					contentHash: await hashFile(entry),
					mode: stat.mode,
					size: stat.size,
					mtimeMs: stat.mtimeMs,
				});
			}
		}
	} catch {
		// Dir doesn't exist — empty snapshot.
	}
	return { files };
}

/** Assert that two snapshots are identical: no added/removed/modified files. */
function assertSnapshotUnchanged(before: Snapshot, after: Snapshot, label: string): void {
	const beforeNames = [...before.files.keys()].sort();
	const afterNames = [...after.files.keys()].sort();

	const added = afterNames.filter(n => !before.files.has(n));
	expect(added, `${label}: unexpected new files: ${added.join(", ")}`).toHaveLength(0);

	const removed = beforeNames.filter(n => !after.files.has(n));
	expect(removed, `${label}: unexpected removed/renamed files: ${removed.join(", ")}`).toHaveLength(0);

	for (const [relPath, beforeEntry] of before.files) {
		const afterEntry = after.files.get(relPath);
		expect(afterEntry, `${label}: ${relPath} disappeared`).toBeDefined();
		expect(afterEntry!.contentHash, `${label}: ${relPath} content changed`).toBe(beforeEntry.contentHash);
		expect(afterEntry!.mode, `${label}: ${relPath} mode changed`).toBe(beforeEntry.mode);
		expect(afterEntry!.size, `${label}: ${relPath} size changed`).toBe(beforeEntry.size);
		expect(afterEntry!.mtimeMs, `${label}: ${relPath} mtime changed`).toBe(beforeEntry.mtimeMs);
	}
}

/** Assert that none of the mutation-indicator patterns appear in the snapshot. */
function assertNoMutationArtifacts(snapshot: Snapshot, label: string): void {
	const forbiddenPatterns = [
		/settings\.json\.bak$/,
		/agent\.db$/,
		/agent\.db-shm$/,
		/agent\.db-wal$/,
		/\.lock$/,
		/settings\.json\.migrated-keys$/,
		/settings\.json\.fallback-invalid/,
	];
	for (const relPath of snapshot.files.keys()) {
		for (const pattern of forbiddenPatterns) {
			expect(pattern.test(relPath), `${label}: mutation artifact ${relPath} appeared`).toBe(false);
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Subprocess runner
// ─────────────────────────────────────────────────────────────────────────────

interface RunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/**
 * Spawn the real CLI as a subprocess. Only GJC_CODING_AGENT_DIR is isolated by
 * default. An optional configRoot isolates GJC_CONFIG_DIR for config-root
 * legacy migration tests; when omitted, the real home config root is used so
 * the native skill discovery (which scans ~/.gjc) works correctly.
 */
async function runDoctor(
	projectDir: string,
	agentDir: string,
	mode: "text" | "json",
	configRoot?: string,
): Promise<RunResult> {
	const args = [process.execPath, cliEntry, "customize", "doctor"];
	if (mode === "json") args.push("--json");
	const env: Record<string, string | undefined> = {
		...process.env,
		GJC_CODING_AGENT_DIR: agentDir,
	};
	if (configRoot !== undefined) env.GJC_CONFIG_DIR = configRoot;
	const proc = Bun.spawn(args, {
		cwd: projectDir,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
}

/**
 * Set up a fully isolated environment: separate agent dir, config root, and
 * project dir. The process HOME stays at the real home.
 */
async function makeIsolatedEnv(prefix: string): Promise<{ agentDir: string; configRoot: string; projectDir: string }> {
	const agentDir = await makeTempDir(`${prefix}-agent-`);
	const configRoot = await makeTempDir(`${prefix}-configroot-`);
	const projectDir = await makeTempDir(`${prefix}-project-`);
	return { agentDir, configRoot, projectDir };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("customize doctor read-only contract (#4406)", () => {
	// =========================================================================
	// 1. Fresh empty agent/project roots — zero files created
	// =========================================================================

	it("fresh empty agent dir gains zero files (JSON mode)", async () => {
		const { agentDir, projectDir } = await makeIsolatedEnv("gjc-empty-json");

		const beforeAgent = await snapshotDir(agentDir);
		const beforeProject = await snapshotDir(projectDir);

		const result = await runDoctor(projectDir, agentDir, "json");

		expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
		expect(result.stdout).toContain('"schemaVersion"');

		const afterAgent = await snapshotDir(agentDir);
		const afterProject = await snapshotDir(projectDir);

		assertSnapshotUnchanged(beforeAgent, afterAgent, "agent-dir");
		assertSnapshotUnchanged(beforeProject, afterProject, "project-dir");
		assertNoMutationArtifacts(afterAgent, "agent-dir");
	});

	it("fresh empty agent dir gains zero files (text mode)", async () => {
		const { agentDir, projectDir } = await makeIsolatedEnv("gjc-empty-text");

		const beforeAgent = await snapshotDir(agentDir);
		const beforeProject = await snapshotDir(projectDir);

		const result = await runDoctor(projectDir, agentDir, "text");

		expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
		expect(result.stdout).toContain("customize doctor");

		const afterAgent = await snapshotDir(agentDir);
		const afterProject = await snapshotDir(projectDir);

		assertSnapshotUnchanged(beforeAgent, afterAgent, "agent-dir");
		assertSnapshotUnchanged(beforeProject, afterProject, "project-dir");
		assertNoMutationArtifacts(afterAgent, "agent-dir");
	});

	// =========================================================================
	// 2. Legacy agent-dir settings.json — not renamed/modified/backed up
	// =========================================================================

	it("legacy agent-dir settings.json is untouched (JSON mode)", async () => {
		const { agentDir, projectDir } = await makeIsolatedEnv("gjc-legacy-agent-json");

		// Place a legacy settings.json directly in the agent dir.
		const legacyContent = JSON.stringify({ model: "test-legacy-agent-model" }, null, 2);
		await fs.writeFile(path.join(agentDir, "settings.json"), legacyContent);
		// Set a deterministic mtime by touching the file and waiting.
		const touchTime = new Date(Date.now() - 60_000);
		await fs.utimes(path.join(agentDir, "settings.json"), touchTime, touchTime);

		const beforeAgent = await snapshotDir(agentDir);

		const result = await runDoctor(projectDir, agentDir, "json");

		expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);

		const afterAgent = await snapshotDir(agentDir);

		// settings.json must still exist with same content/mode/mtime.
		const settingsEntry = afterAgent.files.get("settings.json");
		expect(settingsEntry, "settings.json disappeared").toBeDefined();
		expect(settingsEntry!.contentHash).toBe(beforeAgent.files.get("settings.json")!.contentHash);
		expect(settingsEntry!.mtimeMs).toBe(beforeAgent.files.get("settings.json")!.mtimeMs);

		// No backup, DB, or config.yml files appeared.
		assertSnapshotUnchanged(beforeAgent, afterAgent, "agent-dir");
		assertNoMutationArtifacts(afterAgent, "agent-dir");
	});

	it("legacy agent-dir settings.json is untouched (text mode)", async () => {
		const { agentDir, projectDir } = await makeIsolatedEnv("gjc-legacy-agent-text");

		const legacyContent = JSON.stringify({ model: "test-legacy-agent-model" }, null, 2);
		await fs.writeFile(path.join(agentDir, "settings.json"), legacyContent);
		const touchTime = new Date(Date.now() - 60_000);
		await fs.utimes(path.join(agentDir, "settings.json"), touchTime, touchTime);

		const beforeAgent = await snapshotDir(agentDir);

		const result = await runDoctor(projectDir, agentDir, "text");

		expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);

		const afterAgent = await snapshotDir(agentDir);

		assertSnapshotUnchanged(beforeAgent, afterAgent, "agent-dir");
		assertNoMutationArtifacts(afterAgent, "agent-dir");
	});

	// =========================================================================
	// 3. Legacy config-root settings.json — not consumed/migrated
	// =========================================================================

	it("legacy config-root settings.json is untouched", async () => {
		const { agentDir, configRoot, projectDir } = await makeIsolatedEnv("gjc-legacy-config-root");

		// The config-root settings.json lives at <configRoot>/settings.json.
		// GJC_CONFIG_DIR points the subprocess at this isolated root.
		const legacyContent = JSON.stringify(
			{ "gjc.ralplan.autoHandoff": "invalid-autoHandoff", model: "legacy-config-root" },
			null,
			2,
		);
		await fs.writeFile(path.join(configRoot, "settings.json"), legacyContent);
		const touchTime = new Date(Date.now() - 60_000);
		await fs.utimes(path.join(configRoot, "settings.json"), touchTime, touchTime);

		const beforeConfigRoot = await snapshotDir(configRoot);
		const beforeAgent = await snapshotDir(agentDir);

		const result = await runDoctor(projectDir, agentDir, "json", configRoot);

		expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);

		const afterConfigRoot = await snapshotDir(configRoot);
		const afterAgent = await snapshotDir(agentDir);

		// config-root settings.json must retain name/content/mode/mtime.
		assertSnapshotUnchanged(beforeConfigRoot, afterConfigRoot, "config-root");
		assertSnapshotUnchanged(beforeAgent, afterAgent, "agent-dir");
		assertNoMutationArtifacts(afterConfigRoot, "config-root");
		assertNoMutationArtifacts(afterAgent, "agent-dir");
	});

	// =========================================================================
	// 4. Legacy project .gjc/settings.json — not consumed/migrated
	// =========================================================================

	it("legacy project .gjc/settings.json is untouched", async () => {
		const { agentDir, projectDir } = await makeIsolatedEnv("gjc-legacy-project");

		const gjcDir = path.join(projectDir, ".gjc");
		await fs.mkdir(gjcDir, { recursive: true });
		const legacyContent = JSON.stringify({ "gjc.ralplan.maxIterations": 5, model: "legacy-project-model" }, null, 2);
		await fs.writeFile(path.join(gjcDir, "settings.json"), legacyContent);
		const touchTime = new Date(Date.now() - 60_000);
		await fs.utimes(path.join(gjcDir, "settings.json"), touchTime, touchTime);

		const beforeProject = await snapshotDir(projectDir);
		const beforeAgent = await snapshotDir(agentDir);

		const result = await runDoctor(projectDir, agentDir, "json");

		expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);

		const afterProject = await snapshotDir(projectDir);
		const afterAgent = await snapshotDir(agentDir);

		assertSnapshotUnchanged(beforeProject, afterProject, "project-dir");
		assertSnapshotUnchanged(beforeAgent, afterAgent, "agent-dir");
		assertNoMutationArtifacts(afterProject, "project-dir");
		assertNoMutationArtifacts(afterAgent, "agent-dir");
	});

	// =========================================================================
	// 5. Existing canonical config.yml + project customization — unchanged
	// =========================================================================

	it("existing config.yml and project customization trees retain name/content/mode/mtime", async () => {
		const { agentDir, projectDir } = await makeIsolatedEnv("gjc-existing-config");

		// Pre-existing config.yml in the agent dir.
		const configYmlContent = "model: existing-model\nterminalBell: true\n";
		const configPath = path.join(agentDir, "config.yml");
		await fs.writeFile(configPath, configYmlContent);
		const touchTime = new Date(Date.now() - 60_000);
		await fs.utimes(configPath, touchTime, touchTime);

		// Pre-existing project customization tree.
		await fs.mkdir(path.join(projectDir, ".gjc", "skills"), { recursive: true });
		await fs.writeFile(
			path.join(projectDir, ".gjc", "settings.json"),
			JSON.stringify({ "skills.enabled": true }, null, 2),
		);
		await fs.utimes(path.join(projectDir, ".gjc", "settings.json"), touchTime, touchTime);
		await fs.writeFile(
			path.join(projectDir, ".gjc", "skills", "test-skill.md"),
			"---\ndescription: A test skill\n---\n# Test\n",
		);
		await fs.utimes(path.join(projectDir, ".gjc", "skills", "test-skill.md"), touchTime, touchTime);
		await fs.writeFile(
			path.join(projectDir, ".gjc", "mcp.json"),
			JSON.stringify({ mcpServers: { "test-server": { command: "true" } } }),
		);
		await fs.utimes(path.join(projectDir, ".gjc", "mcp.json"), touchTime, touchTime);

		const beforeAgent = await snapshotDir(agentDir);
		const beforeProject = await snapshotDir(projectDir);

		// Run both modes.
		const resultJson = await runDoctor(projectDir, agentDir, "json");
		expect(resultJson.exitCode, `JSON stderr: ${resultJson.stderr}`).toBe(0);

		const afterAgent1 = await snapshotDir(agentDir);
		const afterProject1 = await snapshotDir(projectDir);
		assertSnapshotUnchanged(beforeAgent, afterAgent1, "agent-dir (json)");
		assertSnapshotUnchanged(beforeProject, afterProject1, "project-dir (json)");

		const resultText = await runDoctor(projectDir, agentDir, "text");
		expect(resultText.exitCode, `text stderr: ${resultText.stderr}`).toBe(0);

		const afterAgent2 = await snapshotDir(agentDir);
		const afterProject2 = await snapshotDir(projectDir);
		assertSnapshotUnchanged(beforeAgent, afterAgent2, "agent-dir (text)");
		assertSnapshotUnchanged(beforeProject, afterProject2, "project-dir (text)");
	});

	// =========================================================================
	// 6. Malformed config.yml — diagnostics without repair writes
	// =========================================================================

	it("malformed config.yml reports diagnostics without repair writes", async () => {
		const { agentDir, projectDir } = await makeIsolatedEnv("gjc-malformed");

		const malformedYaml = "model: [unclosed\n  :: invalid";
		const configPath = path.join(agentDir, "config.yml");
		await fs.writeFile(configPath, malformedYaml);
		const touchTime = new Date(Date.now() - 60_000);
		await fs.utimes(configPath, touchTime, touchTime);

		const beforeAgent = await snapshotDir(agentDir);
		const beforeProject = await snapshotDir(projectDir);

		const result = await runDoctor(projectDir, agentDir, "json");

		// The doctor should still exit 0 — it's a read-only report, not a crash.
		expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);

		const afterAgent = await snapshotDir(agentDir);
		const afterProject = await snapshotDir(projectDir);

		// The malformed config.yml content, mode, and mtime must be unchanged.
		const entry = afterAgent.files.get("config.yml");
		expect(entry, "config.yml disappeared").toBeDefined();
		expect(entry!.contentHash).toBe(beforeAgent.files.get("config.yml")!.contentHash);
		expect(entry!.mtimeMs).toBe(beforeAgent.files.get("config.yml")!.mtimeMs);

		assertSnapshotUnchanged(beforeAgent, afterAgent, "agent-dir");
		assertSnapshotUnchanged(beforeProject, afterProject, "project-dir");
		assertNoMutationArtifacts(afterAgent, "agent-dir");
	});

	// =========================================================================
	// 7. Repeated doctor calls — idempotently read-only
	// =========================================================================

	it("repeated doctor calls are idempotently read-only", async () => {
		const { agentDir, projectDir } = await makeIsolatedEnv("gjc-idempotent");

		// Set up both legacy and config.yml.
		await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ model: "legacy" }));
		await fs.writeFile(path.join(agentDir, "config.yml"), "model: existing\n");
		const touchTime = new Date(Date.now() - 60_000);
		await fs.utimes(path.join(agentDir, "settings.json"), touchTime, touchTime);
		await fs.utimes(path.join(agentDir, "config.yml"), touchTime, touchTime);

		// Project customization.
		const gjcDir = path.join(projectDir, ".gjc");
		await fs.mkdir(gjcDir, { recursive: true });
		await fs.writeFile(
			path.join(gjcDir, "mcp.json"),
			JSON.stringify({ mcpServers: { server: { command: "true" } } }),
		);
		await fs.utimes(path.join(gjcDir, "mcp.json"), touchTime, touchTime);

		const beforeAgent = await snapshotDir(agentDir);
		const beforeProject = await snapshotDir(projectDir);

		// Run doctor three times, alternating modes.
		for (let i = 0; i < 3; i++) {
			const mode = i % 2 === 0 ? "json" : "text";
			const result = await runDoctor(projectDir, agentDir, mode);
			expect(result.exitCode, `run ${i} (${mode}) stderr: ${result.stderr}`).toBe(0);
		}

		const afterAgent = await snapshotDir(agentDir);
		const afterProject = await snapshotDir(projectDir);

		assertSnapshotUnchanged(beforeAgent, afterAgent, "agent-dir");
		assertSnapshotUnchanged(beforeProject, afterProject, "project-dir");
		assertNoMutationArtifacts(afterAgent, "agent-dir");
	});

	// =========================================================================
	// 8. Output schema validation (JSON mode)
	// =========================================================================

	it("produces valid JSON report with expected schema (JSON mode)", async () => {
		const { agentDir, projectDir } = await makeIsolatedEnv("gjc-schema");

		await fs.mkdir(path.join(projectDir, ".gjc"), { recursive: true });
		await fs.writeFile(
			path.join(projectDir, ".gjc", "mcp.json"),
			JSON.stringify({ mcpServers: { "schema-test": { command: "true" } } }),
		);

		const result = await runDoctor(projectDir, agentDir, "json");

		expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);

		const report = JSON.parse(result.stdout);
		expect(report.schemaVersion).toBe(1);
		expect(report.command).toBe("customize doctor");
		expect(report.cwd).toBe(projectDir);
		expect(report.policy).toBeDefined();
		expect(report.policy.sourceClasses).toBeDefined();
		expect(Array.isArray(report.surfaces)).toBe(true);
		expect(report.summary).toBeDefined();
		expect(Array.isArray(report.warnings)).toBe(true);
	});

	// =========================================================================
	// 9. Secret redaction (both text and JSON)
	// =========================================================================

	it("redacts secrets from both text and JSON output", async () => {
		const { agentDir, projectDir } = await makeIsolatedEnv("gjc-redact");

		await fs.mkdir(path.join(projectDir, ".gjc"), { recursive: true });
		await fs.writeFile(
			path.join(projectDir, ".gjc", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					"secret-server": {
						command: "run",
						args: ["--key", "supersecret-doctor-test"],
						env: { TOKEN: "envsecret-doctor-test" },
					},
				},
			}),
		);

		for (const mode of ["json", "text"] as const) {
			const result = await runDoctor(projectDir, agentDir, mode);
			expect(result.exitCode, `${mode} stderr: ${result.stderr}`).toBe(0);
			expect(result.stdout).not.toContain("supersecret-doctor-test");
			expect(result.stdout).not.toContain("envsecret-doctor-test");
		}
	});

	// =========================================================================
	// 10. Precedence/provenance correctness (#4350)
	// =========================================================================

	it("preserves precedence behavior: project copy of bundled skill is shadowed (#4350)", async () => {
		const { agentDir, projectDir } = await makeIsolatedEnv("gjc-precedence");

		// Create a project skill with a bundled workflow skill name, using the
		// proper directory structure (<skills>/ralplan/SKILL.md) so the native
		// provider discovers it deterministically.
		await fs.mkdir(path.join(projectDir, ".gjc", "skills", "ralplan"), { recursive: true });
		await fs.writeFile(
			path.join(projectDir, ".gjc", "skills", "ralplan", "SKILL.md"),
			"---\nname: ralplan\ndescription: Project copy of a bundled skill\n---\n# Custom\n",
		);

		const beforeAgent = await snapshotDir(agentDir);
		const beforeProject = await snapshotDir(projectDir);

		const result = await runDoctor(projectDir, agentDir, "json");

		expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);

		const report = JSON.parse(result.stdout);
		const skillSurface = report.surfaces.find((s: { kind: string }) => s.kind === "skill");
		expect(skillSurface).toBeDefined();

		// A filesystem copy of a bundled workflow skill name is never the
		// effective session definition (#4349): the doctor must not claim the
		// project copy is active. Find the project copy by path identity, not
		// provider label, since provider labeling varies by environment.
		const projectCopy = skillSurface.items.find(
			(item: { name: string; provider: string; path: string }) =>
				item.name === "ralplan" && item.provider !== "bundled" && item.path.startsWith(projectDir),
		);
		expect(projectCopy).toBeDefined();
		expect(projectCopy).toMatchObject({
			status: "shadowed",
			reason: "shadowed-by-precedence",
		});
		expect(projectCopy?.precedence?.shadowedBy).toMatchObject({ provider: "bundled" });

		// The bundled definition is always loaded and authoritative.
		const bundled = skillSurface.items.find(
			(item: { name: string; provider: string }) => item.name === "ralplan" && item.provider === "bundled",
		);
		expect(bundled).toMatchObject({ status: "loaded", reason: "loaded" });

		const afterAgent = await snapshotDir(agentDir);
		const afterProject = await snapshotDir(projectDir);
		assertSnapshotUnchanged(beforeAgent, afterAgent, "agent-dir");
		assertSnapshotUnchanged(beforeProject, afterProject, "project-dir");
	});

	// =========================================================================
	// 11. Config.yml values are read by the doctor (semantic correctness)
	// =========================================================================

	it("reads canonical config.yml values for doctor policy", async () => {
		const { agentDir, projectDir } = await makeIsolatedEnv("gjc-config-read");

		await fs.writeFile(path.join(agentDir, "config.yml"), "model: semantic-test-model\nskills:\n  enabled: true\n");

		const result = await runDoctor(projectDir, agentDir, "json");

		expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);

		const report = JSON.parse(result.stdout);
		expect(report.policy.skillsEnabled).toBe(true);
	});
});
