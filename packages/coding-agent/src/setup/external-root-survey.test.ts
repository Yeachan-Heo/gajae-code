import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { runExternalRootSurvey } from "./external-root-survey";

const packageRoot = path.resolve(import.meta.dir, "../..");

const createdRoots: string[] = [];

function tempRoot(prefix: string): string {
	const root = mkdtempSync(path.join(tmpdir(), prefix));
	createdRoots.push(root);
	return root;
}

afterEach(() => {
	while (createdRoots.length > 0) {
		const root = createdRoots.pop();
		if (root) rmSync(root, { recursive: true, force: true });
	}
});

function writeText(filePath: string, content: string): void {
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, content);
}

function writeSqlite(filePath: string): void {
	mkdirSync(path.dirname(filePath), { recursive: true });
	const db = new Database(filePath, { create: true });
	try {
		db.run("CREATE TABLE demo (id INTEGER PRIMARY KEY, secret_token TEXT, visible TEXT)");
		db.run("INSERT INTO demo (secret_token, visible) VALUES ('sk-secret1234567890', 'row-value')");
	} finally {
		db.close();
	}
}

function buildSurveyFixture(): string {
	const root = tempRoot("gjc-survey-test-");
	const hookCommand = "bash -lc 'echo sk-secret1234567890 && rm -rf /tmp/not-real'";
	writeText(
		path.join(root, ".claude", "settings.json"),
		JSON.stringify({ hooks: { Stop: [{ matcher: "*", command: hookCommand }] }, apiKey: "sk-secret1234567890" }),
	);
	writeText(path.join(root, ".claude.json"), JSON.stringify({ oauthToken: "Bearer rawtoken" }));
	writeText(
		path.join(root, ".codex", "config.toml"),
		`model = "gpt-test"\nOPENAI_API_KEY = "sk-secret1234567890"\n[hooks]\ncommand = ${JSON.stringify(hookCommand)}\n`,
	);
	writeText(
		path.join(root, ".codex", "log", "codex-tui.log"),
		"ERROR failed with Bearer rawtoken\nWARN retry sk-secret1234567890\nINFO done\n",
	);
	writeText(
		path.join(root, ".codex", "skills", "demo-skill", "SKILL.md"),
		"---\nname: demo ghp_1234567890abcdefABCDEF\ndescription: password=frontmatter-secret\nsecret: sk-secret1234567890\n---\n# Demo\n",
	);
	writeSqlite(path.join(root, ".codex", "state_5.sqlite"));
	writeText(
		path.join(root, ".gemini", "settings.json"),
		JSON.stringify({ mcpServers: { demo: { command: hookCommand } } }),
	);
	writeText(path.join(root, ".gemini", "GEMINI.md"), "# Gemini\nsecret sk-secret1234567890\n");
	writeText(
		path.join(root, ".gemini", "projects.json"),
		JSON.stringify({ projects: { [root]: { token: "Bearer rawtoken" } } }),
	);
	writeText(
		path.join(root, ".gemini", "extensions", "demo", "gemini-extension.json"),
		JSON.stringify({ name: "demo" }),
	);
	writeText(
		path.join(root, ".hermes", "config.yaml"),
		`mcp_servers:\n  demo:\n    command: ${JSON.stringify(hookCommand)}\n`,
	);
	writeText(path.join(root, ".hermes", "SOUL.md"), "# Soul\n");
	writeText(path.join(root, ".hermes", "logs", "agent.log"), "FATAL crashed with sk-secret1234567890\n");
	writeText(
		path.join(root, ".hermes", "skills", "demo-skill", "SKILL.md"),
		"---\nname: hermes\ndescription: Hermes skill\n---\n# Hermes\n",
	);
	writeSqlite(path.join(root, ".hermes", "state.db"));
	writeText(path.join(root, ".ssh", "id_rsa"), "raw-ssh-secret");
	return root;
}

function assertNoSensitiveMarkers(value: unknown): void {
	const text = JSON.stringify(value);
	for (const marker of [
		"sk-secret1234567890",
		"Bearer rawtoken",
		"raw-ssh-secret",
		"rm -rf /tmp/not-real",
		"frontmatter-secret",
		"ghp_1234567890abcdefABCDEF",
	]) {
		expect(text.includes(marker), marker).toBe(false);
	}
}

describe("external-root-survey", () => {
	test("inventory is shallow and does not read content", async () => {
		const home = buildSurveyFixture();
		const result = await runExternalRootSurvey({ home, depth: "inventory", anchor: ["home"] });

		expect(result.ok).toBe(true);
		expect(result.depth).toBe("inventory");
		expect(result.anchors).toEqual(["home"]);
		expect(result.counters.content_read_attempts ?? 0).toBe(0);
		expect(
			result.observations.some(
				observation => observation.kind === "home_named_anchor" && observation.path === "~/.codex",
			),
		).toBe(true);
		assertNoSensitiveMarkers(result);
	});

	test("config and deep tiers summarize safely with caps, hashes, and no row dumps", async () => {
		const home = buildSurveyFixture();
		const deep = await runExternalRootSurvey({
			home,
			depth: "deep",
			anchor: ["codex", "hermes"],
			maxBytes: "1048576",
			maxEntries: "32",
			timeoutMs: "10000",
		});

		expect(deep.ok).toBe(true);
		expect(deep.observations.some(observation => observation.kind === "sqlite_schema")).toBe(true);
		expect(deep.observations.some(observation => observation.kind === "log_summary")).toBe(true);
		expect(deep.observations.some(observation => observation.kind === "skill_frontmatter_inventory")).toBe(true);
		expect(deep.observations.some(observation => observation.kind === "hook_command_hashes")).toBe(true);
		assertNoSensitiveMarkers(deep);

		const serialized = JSON.stringify(deep);
		expect(serialized.includes("row-value")).toBe(false);
		expect(serialized.includes(createHash("sha256").update("row-value").digest("hex"))).toBe(false);
		expect(deep.observations.every(observation => !observation.path.startsWith("~/.ssh"))).toBe(true);
	});

	test("deep tier emits sanitized absorption catalog candidates and exclusions", async () => {
		const home = buildSurveyFixture();
		const result = await runExternalRootSurvey({
			home,
			depth: "deep",
			anchor: ["claude", "codex", "gemini", "hermes"],
			maxBytes: "1048576",
			maxEntries: "64",
			timeoutMs: "10000",
		});

		expect(result.catalog.candidates.length).toBeGreaterThan(0);
		expect(result.catalog.candidates.some(candidate => candidate.source_family === "codex")).toBe(true);
		expect(result.catalog.candidates.some(candidate => candidate.source_family === "hermes")).toBe(true);
		expect(result.catalog.candidates.every(candidate => candidate.treatment === "wrap_catalog")).toBe(true);
		expect(result.catalog.summary.assets_wrapped).toBe(result.catalog.candidates.length);
		expect(result.catalog.exclusions.some(exclusion => exclusion.excluded_kind === "sqlite_rows")).toBe(true);
		expect(result.catalog.exclusions.some(exclusion => exclusion.excluded_kind === "raw_logs")).toBe(true);
		expect(result.catalog.exclusions.some(exclusion => exclusion.excluded_kind === "raw_hook_commands")).toBe(true);
		assertNoSensitiveMarkers(result);
	});

	test("deep tier rejects symlink escapes before stat/list/read/open", async () => {
		const home = tempRoot("gjc-survey-symlink-home-");
		const outside = tempRoot("gjc-survey-symlink-outside-");
		mkdirSync(path.join(home, ".codex", "skills"), { recursive: true });
		mkdirSync(path.join(home, ".codex", "log"), { recursive: true });

		writeText(path.join(outside, "config.toml"), `model = "outside-model"\napi_key = "outside-config-secret"\n`);
		writeText(path.join(outside, "escape.log"), "ERROR outside-log-secret\n");
		writeText(
			path.join(outside, "escape.md"),
			"---\nname: outside-md\ndescription: outside markdown secret\n---\n# Outside\n",
		);
		writeText(
			path.join(outside, "private-skill", "SKILL.md"),
			"---\nname: outside-dir\ndescription: outside private description\n---\n# Outside\n",
		);
		writeSqlite(path.join(outside, "state_5.sqlite"));

		symlinkSync(path.join(outside, "config.toml"), path.join(home, ".codex", "config.toml"));
		symlinkSync(path.join(outside, "state_5.sqlite"), path.join(home, ".codex", "state_5.sqlite"));
		symlinkSync(path.join(outside, "escape.log"), path.join(home, ".codex", "log", "escape.log"));
		symlinkSync(path.join(outside, "escape.md"), path.join(home, ".codex", "skills", "escape.md"));
		symlinkSync(path.join(outside, "private-skill"), path.join(home, ".codex", "skills", "link-out"), "dir");

		const result = await runExternalRootSurvey({
			home,
			depth: "deep",
			anchor: ["codex"],
			maxBytes: "1048576",
			maxEntries: "64",
			timeoutMs: "10000",
		});

		expect(result.ok).toBe(true);
		expect(result.counters.sqlite_open_attempts ?? 0).toBe(0);
		expect(result.counters.content_read_attempts ?? 0).toBe(0);
		expect(
			result.skipped.some(skip => skip.reason === "outside_root_symlink" || skip.reason === "outside_root"),
		).toBe(true);
		const serialized = JSON.stringify(result);
		for (const marker of [
			"outside-model",
			"outside-config-secret",
			"outside-log-secret",
			"outside markdown secret",
			"outside private description",
			"outside-md",
			"outside-dir",
			"row-value",
		]) {
			expect(serialized.includes(marker), marker).toBe(false);
		}
		expect(result.observations.some(observation => observation.kind === "sqlite_schema")).toBe(false);
		expect(result.catalog.candidates).toHaveLength(0);
	});

	test("depth and hard-cap validation reject unsafe survey requests", async () => {
		const home = buildSurveyFixture();
		await expect(runExternalRootSurvey({ home, depth: "deep", anchor: ["home"] })).rejects.toThrow(
			"--depth deep requires",
		);
		await expect(
			runExternalRootSurvey({ home, depth: "deep", anchor: ["codex"], maxBytes: "999999999" }),
		).rejects.toThrow("--max-bytes must be <=");
	});

	test("CLI surface executes against synthetic fixtures", () => {
		const home = buildSurveyFixture();
		const proc = spawnSync(
			process.execPath,
			[
				"run",
				"src/cli.ts",
				"setup",
				"external-root-survey",
				"--json",
				"--home",
				home,
				"--depth",
				"config",
				"--anchor",
				"claude",
				"--anchor",
				"codex",
			],
			{ cwd: packageRoot, encoding: "utf8" },
		);

		expect(proc.status).toBe(0);
		const result = JSON.parse(proc.stdout);
		expect(result.observations.some((observation: { kind: string }) => observation.kind === "config_json")).toBe(
			true,
		);
		expect(result.observations.some((observation: { kind: string }) => observation.kind === "config_toml")).toBe(
			true,
		);
		assertNoSensitiveMarkers(result);
		const reportProc = spawnSync(
			process.execPath,
			[
				"run",
				"src/cli.ts",
				"setup",
				"external-root-survey",
				"--report",
				"--home",
				home,
				"--depth",
				"deep",
				"--anchor",
				"codex",
				"--anchor",
				"hermes",
			],
			{ cwd: packageRoot, encoding: "utf8" },
		);
		expect(reportProc.status, reportProc.stderr || reportProc.stdout).toBe(0);
		expect(reportProc.stdout).toContain("External root absorption catalog");
		expect(reportProc.stdout).toContain("Candidates:");
		expect(reportProc.stdout).toContain("Exclusions:");
		assertNoSensitiveMarkers(reportProc.stdout);
	});
});
