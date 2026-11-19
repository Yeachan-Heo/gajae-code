import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetAgentDirFromEnvironment, setAgentDir } from "@gajae-code/utils";
import fc from "fast-check";
import { MigrateArgsError, resolveSources, runMigrate } from "../src/cli/migrate-cli";
import { readSourceText } from "../src/migrate/adapters/index";
import { renderHuman } from "../src/migrate/report";

function symlinkSupported(): boolean {
	const probe = fsSync.mkdtempSync(path.join(os.tmpdir(), "migrate-link-probe-"));
	let supported = true;
	try {
		fsSync.symlinkSync("target", path.join(probe, "link"));
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "EPERM" && code !== "EACCES") throw error;
		supported = false;
	} finally {
		fsSync.rmSync(probe, { recursive: true, force: true });
	}
	return supported;
}

const SYMLINKS = symlinkSupported();
const MKFIFO = process.platform === "win32" ? null : Bun.which("mkfifo");

let home: string;
let cwd: string;

async function write(rel: string, content: string): Promise<void> {
	const full = path.join(home, rel);
	await fs.mkdir(path.dirname(full), { recursive: true });
	await fs.writeFile(full, content, "utf-8");
}

async function exists(p: string): Promise<boolean> {
	try {
		await fs.stat(p);
		return true;
	} catch {
		return false;
	}
}

beforeEach(async () => {
	home = await fs.mkdtemp(path.join(os.tmpdir(), "migrate-cli-home-"));
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "migrate-cli-cwd-"));
	await write(".claude.json", JSON.stringify({ mcpServers: { srv: { command: "bin" } } }));
	await write(".claude/skills/alpha/SKILL.md", "---\ndescription: a\n---\nbody");
});

afterEach(async () => {
	await fs.rm(home, { recursive: true, force: true });
	await fs.rm(cwd, { recursive: true, force: true });
});

describe("resolveSources", () => {
	test("expands all", () => {
		expect(resolveSources(["all"])).toEqual(["claude-code", "codex", "opencode"]);
	});
	test("dedupes and returns canonical order regardless of input order", () => {
		expect(resolveSources(["opencode", "claude-code", "opencode"])).toEqual(["claude-code", "opencode"]);
	});
	test("rejects unknown source", () => {
		expect(() => resolveSources(["bogus"])).toThrow(MigrateArgsError);
	});
	test("rejects empty selection", () => {
		expect(() => resolveSources([])).toThrow(MigrateArgsError);
	});
});

describe("runMigrate", () => {
	test("--dry-run writes nothing", async () => {
		await fs.writeFile(path.join(cwd, "CLAUDE.md"), "Project instructions.", "utf-8");
		await fs.mkdir(path.join(cwd, ".claude", "commands"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".claude", "commands", "review.md"), "Review the patch.", "utf-8");
		const report = await runMigrate({
			from: ["claude-code"],
			project: true,
			force: false,
			dryRun: true,
			json: true,
			homeDir: home,
			cwd,
		});
		expect(report.dryRun).toBe(true);
		expect(report.actions.length).toBeGreaterThan(0);
		expect(report.actions).toContainEqual(
			expect.objectContaining({ type: "instruction", name: "CLAUDE.md", status: "imported" }),
		);
		expect(report.actions).toContainEqual(
			expect.objectContaining({ type: "command", name: "claude-code:review", status: "imported" }),
		);
		expect(renderHuman(report)).toContain("[claude-code] /claude-code:review: imported");
		expect(renderHuman(report)).toContain("[claude-code] CLAUDE.md: imported");
	});

	test("dry-run reports settings that need manual action", async () => {
		await fs.mkdir(path.join(cwd, ".claude"), { recursive: true });
		await fs.writeFile(
			path.join(cwd, ".claude", "settings.json"),
			JSON.stringify({
				model: "claude-sonnet-4-5",
				permissions: { deny: ["Read(./.env)"] },
				hooks: {
					PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "npm test" }] }],
					Notification: [{ hooks: [{ type: "command", command: "say done" }] }],
				},
			}),
			"utf-8",
		);
		const report = await runMigrate({
			from: ["claude-code"],
			project: true,
			force: false,
			dryRun: true,
			json: true,
			homeDir: home,
			cwd,
		});
		// Manual actions are advisory: they never turn a migration into a failure.
		expect(report.ok).toBe(true);
		expect(report.manualActions.map(action => action.area).sort()).toEqual([
			"settings.json: hooks.Notification",
			"settings.json: model",
			"settings.json: permissions",
		]);
		const hookActions = report.actions.filter(action => action.type === "hook");
		expect(hookActions.some(action => action.name === "Notification" && action.status === "skipped_unmappable")).toBe(
			true,
		);
		const hookAction = hookActions.find(action => action.status === "imported");
		expect(hookAction).toMatchObject({ name: "migrated-claude-code.ts", status: "imported" });
		expect(hookAction?.destination).toBe(path.join(report.destinations.hooksDir, "migrated-claude-code.ts"));
		expect(report.summary.byType.hook.imported).toBe(1);
		const rendered = renderHuman(report);
		expect(rendered).toContain("Manual actions:");
		expect(rendered).toContain("[claude-code] migrated-claude-code.ts: imported");
		expect(rendered).toContain("[claude-code] settings.json: hooks.Notification:");
		expect(await exists(path.join(cwd, ".gjc", "mcp.json"))).toBe(false);
		expect(await exists(path.join(cwd, ".gjc", "skills"))).toBe(false);
		expect(await exists(path.join(cwd, ".gjc", "AGENTS.md"))).toBe(false);
		expect(await exists(path.join(cwd, ".gjc", "commands", "claude-code", "review.md"))).toBe(false);
	});

	test("--json report carries taxonomy counts by total/type/source", async () => {
		const report = await runMigrate({
			from: ["claude-code"],
			project: true,
			force: false,
			dryRun: true,
			json: true,
			homeDir: home,
			cwd,
		});
		expect(report.summary.total).toHaveProperty("imported");
		expect(report.summary.byType).toHaveProperty("mcp");
		expect(report.summary.byType).toHaveProperty("skill");
		expect(report.summary.byType).toHaveProperty("command");
		expect(report.summary.byType).toHaveProperty("instruction");
		expect(report.summary.bySource).toHaveProperty("claude-code");
	});

	test("--project writes under cwd/.gjc", async () => {
		await fs.writeFile(path.join(cwd, "CLAUDE.md"), "Project instructions.", "utf-8");
		await fs.mkdir(path.join(cwd, ".claude", "commands"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".claude", "commands", "ship.md"), "Ship the project.", "utf-8");
		await runMigrate({
			from: ["claude-code"],
			project: true,
			force: false,
			dryRun: false,
			json: false,
			homeDir: home,
			cwd,
		});
		expect(await exists(path.join(cwd, ".gjc", "mcp.json"))).toBe(true);
		expect(await exists(path.join(cwd, ".gjc", "skills", "alpha", "SKILL.md"))).toBe(true);
		expect(await fs.readFile(path.join(cwd, ".gjc", "AGENTS.md"), "utf-8")).toBe("Project instructions.");
		expect(await fs.readFile(path.join(cwd, ".gjc", "commands", "claude-code", "ship.md"), "utf-8")).toBe(
			"Ship the project.",
		);
	});

	test("user scope writes under the agent dir", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "migrate-agent-"));
		await write(".claude/CLAUDE.md", "User instructions.");
		await write(".claude/commands/summarize.md", "Summarize $ARGUMENTS.");
		setAgentDir(agentDir);
		try {
			await runMigrate({
				from: ["claude-code"],
				project: false,
				force: false,
				dryRun: false,
				json: false,
				homeDir: home,
				cwd,
			});
			expect(await exists(path.join(agentDir, "mcp.json"))).toBe(true);
			expect(await exists(path.join(agentDir, "skills", "alpha", "SKILL.md"))).toBe(true);
			expect(await fs.readFile(path.join(agentDir, "AGENTS.md"), "utf-8")).toBe("User instructions.");
			expect(await fs.readFile(path.join(agentDir, "commands", "claude-code", "summarize.md"), "utf-8")).toBe(
				"Summarize $ARGUMENTS.",
			);
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	test("failure status makes report.ok false (malformed source)", async () => {
		await write(".claude.json", "{ not json");
		const report = await runMigrate({
			from: ["claude-code"],
			project: true,
			force: false,
			dryRun: true,
			json: true,
			homeDir: home,
			cwd,
		});
		expect(report.ok).toBe(false);
	});

	test("does not follow a symlinked project .gjc while migrating mcp", async () => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "migrate-cli-mcp-outside-"));
		try {
			await fs.symlink(outside, path.join(cwd, ".gjc"), "dir");
			const report = await runMigrate({
				from: ["claude-code"],
				project: true,
				force: false,
				dryRun: false,
				json: false,
				homeDir: home,
				cwd,
			});
			const mcp = report.actions.find(action => action.type === "mcp" && action.name === "srv");
			expect(mcp).toMatchObject({ operation: "fail", status: "failed_io" });
			expect(await exists(path.join(outside, "mcp.json"))).toBe(false);
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
		}
	});

	test("still allows a user-scope agent dir that is a symlink named .gjc", async () => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "migrate-cli-user-outside-"));
		const linkParent = await fs.mkdtemp(path.join(os.tmpdir(), "migrate-cli-user-link-"));
		const previous = process.env.GJC_CODING_AGENT_DIR;
		const agentDir = path.join(linkParent, ".gjc");
		await fs.symlink(outside, agentDir, "dir");
		setAgentDir(agentDir);
		try {
			const report = await runMigrate({
				from: ["claude-code"],
				project: false,
				force: false,
				dryRun: false,
				json: false,
				homeDir: home,
				cwd,
			});
			const mcp = report.actions.find(action => action.type === "mcp" && action.name === "srv");
			expect(mcp).toMatchObject({ operation: "create", status: "imported" });
			expect(await exists(path.join(outside, "mcp.json"))).toBe(true);
		} finally {
			if (previous === undefined) delete process.env.GJC_CODING_AGENT_DIR;
			else process.env.GJC_CODING_AGENT_DIR = previous;
			resetAgentDirFromEnvironment();
			await fs.rm(outside, { recursive: true, force: true });
			await fs.rm(linkParent, { recursive: true, force: true });
		}
	});

	test("still allows a user-scope agent dir whose parents do not exist yet", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "migrate-cli-user-missing-"));
		const previous = process.env.GJC_CODING_AGENT_DIR;
		const agentDir = path.join(root, "missing", "profile", ".gjc");
		setAgentDir(agentDir);
		try {
			const report = await runMigrate({
				from: ["claude-code"],
				project: false,
				force: false,
				dryRun: false,
				json: false,
				homeDir: home,
				cwd,
			});
			const mcp = report.actions.find(action => action.type === "mcp" && action.name === "srv");
			expect(mcp).toMatchObject({ operation: "create", status: "imported" });
			expect(await exists(path.join(agentDir, "mcp.json"))).toBe(true);
		} finally {
			if (previous === undefined) delete process.env.GJC_CODING_AGENT_DIR;
			else process.env.GJC_CODING_AGENT_DIR = previous;
			resetAgentDirFromEnvironment();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("--from all and repeated --from load every selected source once", async () => {
		const report = await runMigrate({
			from: ["opencode", "claude-code"],
			project: true,
			force: false,
			dryRun: true,
			json: true,
			homeDir: home,
			cwd,
		});
		expect(report.sources).toEqual(["claude-code", "opencode"]);
	});

	test("still allows a regular project CLAUDE.md", async () => {
		await fs.writeFile(path.join(cwd, "CLAUDE.md"), "Project instructions.");
		const report = await runMigrate({
			from: ["claude-code"],
			project: true,
			force: false,
			dryRun: true,
			json: true,
			homeDir: home,
			cwd,
		});
		expect(report.actions).toContainEqual(
			expect.objectContaining({ type: "instruction", name: "CLAUDE.md", status: "imported" }),
		);
	});

	test("still allows a regular project CLAUDE.md when the project path uses a dot segment", async () => {
		await fs.mkdir(path.join(cwd, "nested"));
		await fs.writeFile(path.join(cwd, "CLAUDE.md"), "Project instructions.");
		const report = await runMigrate({
			from: ["claude-code"],
			project: true,
			force: false,
			dryRun: true,
			json: true,
			homeDir: home,
			cwd: path.join(cwd, "nested", ".."),
		});
		expect(report.actions).toContainEqual(
			expect.objectContaining({ type: "instruction", name: "CLAUDE.md", status: "imported" }),
		);
	});

	test("still allows a regular project CLAUDE.md when the project path has a trailing slash", async () => {
		await fs.writeFile(path.join(cwd, "CLAUDE.md"), "Project instructions.");
		const report = await runMigrate({
			from: ["claude-code"],
			project: true,
			force: false,
			dryRun: true,
			json: true,
			homeDir: home,
			cwd: `${cwd}${path.sep}`,
		});
		expect(report.actions).toContainEqual(
			expect.objectContaining({ type: "instruction", name: "CLAUDE.md", status: "imported" }),
		);
	});

	test.skipIf(!SYMLINKS)("still allows a project opened through a symlinked directory", async () => {
		const linkParent = await fs.mkdtemp(path.join(os.tmpdir(), "migrate-cli-linked-"));
		const link = path.join(linkParent, "repo");
		try {
			await fs.writeFile(path.join(cwd, "CLAUDE.md"), "Project instructions.");
			await fs.symlink(cwd, link, "dir");
			const report = await runMigrate({
				from: ["claude-code"],
				project: true,
				force: false,
				dryRun: true,
				json: true,
				homeDir: home,
				cwd: link,
			});
			expect(report.actions).toContainEqual(
				expect.objectContaining({ type: "instruction", name: "CLAUDE.md", status: "imported" }),
			);
		} finally {
			await fs.rm(linkParent, { recursive: true, force: true });
		}
	});

	test.skipIf(process.platform === "win32")(
		"still allows a regular source whose name contains a backslash",
		async () => {
			const file = path.join(cwd, "a\\b");
			await fs.writeFile(file, "backslash-name");
			const read = await readSourceText(file, "claude-code", "instruction", cwd);
			expect(read).toEqual({ text: "backslash-name" });
		},
	);

	test.skipIf(!SYMLINKS)(
		"still imports a rootless Codex or OpenCode config when its final component is a symlink",
		async () => {
			const outside = await fs.mkdtemp(path.join(os.tmpdir(), "migrate-cli-rootless-"));
			const codexReal = path.join(outside, "config.toml");
			const openReal = path.join(outside, "opencode.json");
			try {
				await fs.writeFile(codexReal, '[mcp_servers.codexSrv]\ncommand = "cdx"\n');
				await fs.writeFile(openReal, JSON.stringify({ mcp: { ocSrv: { type: "local", command: "ocb" } } }));
				await fs.mkdir(path.join(home, ".codex"), { recursive: true });
				await fs.mkdir(path.join(home, ".config", "opencode"), { recursive: true });
				await fs.symlink(codexReal, path.join(home, ".codex", "config.toml"));
				await fs.symlink(openReal, path.join(home, ".config", "opencode", "opencode.json"));
				await fs.writeFile(path.join(home, ".codex", "AGENTS.md"), "Keep the Codex notes.");
				const report = await runMigrate({
					from: ["codex", "opencode"],
					project: false,
					force: false,
					dryRun: true,
					json: true,
					homeDir: home,
					cwd,
				});
				expect(report.actions).toContainEqual(
					expect.objectContaining({ type: "mcp", source: "codex", name: "codexSrv", status: "imported" }),
				);
				expect(report.actions).toContainEqual(
					expect.objectContaining({ type: "mcp", source: "opencode", name: "ocSrv", status: "imported" }),
				);
				expect(report.actions).toContainEqual(
					expect.objectContaining({
						type: "instruction",
						source: "codex",
						name: "AGENTS.md",
						status: "imported",
					}),
				);
				expect(report.actions.some(action => action.type === "source" && action.status === "failed_io")).toBe(
					false,
				);
			} finally {
				await fs.rm(outside, { recursive: true, force: true });
			}
		},
	);

	test.skipIf(!SYMLINKS)("project CLAUDE.md symlink is not copied into AGENTS.md", async () => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "migrate-cli-secret-"));
		const marker = "FAKE-SECRET-KEY-MATERIAL-0123456789";
		const secret = path.join(outside, "secret.txt");
		try {
			await fs.writeFile(secret, marker);
			await fs.symlink(secret, path.join(cwd, "CLAUDE.md"));
			const report = await runMigrate({
				from: ["claude-code"],
				project: true,
				force: false,
				dryRun: false,
				json: true,
				homeDir: home,
				cwd,
			});
			expect(
				report.actions.find(action => action.type === "instruction" && action.name === "CLAUDE.md")?.status,
			).not.toBe("imported");
			expect(report.actions).toContainEqual(expect.objectContaining({ type: "source", status: "failed_io" }));
			const agents = path.join(cwd, ".gjc", "AGENTS.md");
			if (await exists(agents)) expect(await fs.readFile(agents, "utf-8")).not.toContain(marker);
			expect(await fs.readFile(secret, "utf-8")).toBe(marker);
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
		}
	});

	test.skipIf(!SYMLINKS)("settings behind a symlinked .claude directory are not imported", async () => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "migrate-cli-settings-"));
		try {
			await fs.writeFile(path.join(outside, "settings.json"), JSON.stringify({ model: "claude-sonnet-4-5" }));
			await fs.symlink(outside, path.join(cwd, ".claude"), "dir");
			const report = await runMigrate({
				from: ["claude-code"],
				project: true,
				force: false,
				dryRun: true,
				json: true,
				homeDir: home,
				cwd,
			});
			expect(report.manualActions.some(action => action.area.includes("settings.json"))).toBe(false);
			expect(report.actions).toContainEqual(expect.objectContaining({ type: "source", status: "failed_io" }));
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
		}
	});

	test.skipIf(!SYMLINKS)("a symlinked skill file is not imported", async () => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "migrate-cli-skill-"));
		const marker = "SKILL-LINK-SECRET";
		const skill = path.join(home, ".claude", "skills", "alpha", "SKILL.md");
		try {
			await fs.writeFile(path.join(outside, "secret.md"), marker);
			await fs.rm(skill);
			await fs.symlink(path.join(outside, "secret.md"), skill);
			const report = await runMigrate({
				from: ["claude-code"],
				project: true,
				force: false,
				dryRun: false,
				json: true,
				homeDir: home,
				cwd,
			});
			expect(report.actions.find(action => action.type === "skill" && action.name === "alpha")?.status).not.toBe(
				"imported",
			);
			const written = path.join(cwd, ".gjc", "skills", "alpha", "SKILL.md");
			if (await exists(written)) expect(await fs.readFile(written, "utf-8")).not.toContain(marker);
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
		}
	});

	test.skipIf(process.platform === "win32" || MKFIFO === null)("a fifo migrate source is not read", async () => {
		const fifo = path.join(cwd, "CLAUDE.md");
		const made = Bun.spawnSync([MKFIFO as string, fifo]);
		expect(made.exitCode).toBe(0);
		const entry = path.join(import.meta.dir, "../src/cli/migrate-cli.ts");
		const script = `
			import { runMigrate } from ${JSON.stringify(entry)};
			import * as fs from "node:fs/promises";
			import * as path from "node:path";
			const project = process.env.MIGRATE_CWD ?? "";
			const homeDir = process.env.MIGRATE_HOME ?? "";
			const report = await runMigrate({
				from: ["claude-code"],
				project: true,
				force: false,
				dryRun: false,
				json: true,
				homeDir,
				cwd: project,
			});
			let agents = "";
			try {
				agents = await fs.readFile(path.join(project, ".gjc", "AGENTS.md"), "utf-8");
			} catch {}
			if (report.ok !== false) process.exit(2);
			if (agents.length > 0) process.exit(3);
			const refused = report.actions.some(action => action.type === "source" && action.status === "failed_io");
			process.exit(refused ? 0 : 4);
		`;
		const child = Bun.spawn([process.execPath, "-e", script], {
			cwd: path.join(import.meta.dir, "../../.."),
			env: { ...process.env, MIGRATE_CWD: cwd, MIGRATE_HOME: home },
			stdout: "ignore",
			stderr: "pipe",
		});
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finished = await Promise.race([
			child.exited.then(() => "exited" as const),
			new Promise<"timeout">(resolve => {
				timer = setTimeout(() => resolve("timeout"), 5000);
			}),
		]);
		if (timer) clearTimeout(timer);
		if (finished === "timeout") {
			child.kill(9);
			await child.exited;
		}
		const stderr = child.stderr ? await new Response(child.stderr).text() : "";
		expect(finished, stderr).toBe("exited");
		expect(child.exitCode, stderr).toBe(0);
	});

	test("property: migrate source containment stays inside the root, fc.property seed 17011, numRuns 64", async () => {
		const { migrateSourceInsideRoot } = await import("../src/migrate/adapters/index");
		fc.assert(
			fc.property(
				fc.array(fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._-]{0,7}$/), { minLength: 0, maxLength: 4 }),
				fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._-]{0,7}$/),
				(segments, name) => {
					const root = path.join("/proj", "repo");
					const inside = path.join(root, ...segments, name);
					expect(migrateSourceInsideRoot(root, inside)).toBe(true);
					expect(migrateSourceInsideRoot(root, path.join(root, ".", name))).toBe(true);
					expect(migrateSourceInsideRoot(root, path.join(root, "..", name))).toBe(false);
					expect(migrateSourceInsideRoot(root, inside)).toBe(
						migrateSourceInsideRoot(path.resolve(root), path.resolve(inside)),
					);
				},
			),
			{ seed: 17011, numRuns: 64 },
		);
	});
});
