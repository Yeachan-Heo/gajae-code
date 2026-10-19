import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { planMigration } from "../src/migrate/action-planner";
import { executeActions } from "../src/migrate/executor";
import type { AdapterResult, McpCandidate, MigrateDestinations, SkillCandidate } from "../src/migrate/types";

let tmp: string;
let dest: MigrateDestinations;

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "migrate-planner-"));
	dest = {
		mcpConfigPath: path.join(tmp, "mcp.json"),
		skillsDir: path.join(tmp, "skills"),
		instructionsPath: path.join(tmp, "AGENTS.md"),
	};
});

afterEach(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

function mcp(name: string, raw: unknown): McpCandidate {
	return { source: "claude-code", name, raw };
}
function skill(slug: string, content = `---\ndescription: d\n---\nbody`): SkillCandidate {
	return { source: "claude-code", slug, content, warnings: [] };
}
function instruction(content: string, source: "claude-code" | "codex" = "claude-code") {
	return { source, name: source === "codex" ? "AGENTS.md" : "CLAUDE.md", content };
}
function result(partial: Partial<AdapterResult>): AdapterResult {
	return { mcpCandidates: [], skillCandidates: [], instructionCandidates: [], diagnostics: [], ...partial };
}

async function writeMcpConfig(servers: Record<string, unknown>): Promise<void> {
	await fs.writeFile(dest.mcpConfigPath, JSON.stringify({ mcpServers: servers }), "utf-8");
}
async function writeDestSkill(slug: string, frontmatter: string): Promise<void> {
	const dir = path.join(dest.skillsDir, slug);
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(path.join(dir, "SKILL.md"), `---\n${frontmatter}\n---\nbody`, "utf-8");
}

describe("planMigration — MCP", () => {
	test("fresh import is `imported`", async () => {
		const { actions } = await planMigration({
			results: [result({ mcpCandidates: [mcp("srv", { command: "bin" })] })],
			destinations: dest,
			force: false,
		});
		expect(actions).toHaveLength(1);
		expect(actions[0]).toMatchObject({ type: "mcp", name: "srv", operation: "create", status: "imported" });
	});

	test("existing server: skip without force, update with force", async () => {
		await writeMcpConfig({ srv: { command: "old" } });
		const candidate = result({ mcpCandidates: [mcp("srv", { command: "new" })] });
		const skipped = await planMigration({ results: [candidate], destinations: dest, force: false });
		expect(skipped.actions[0]).toMatchObject({ status: "skipped_exists", operation: "skip" });
		const forced = await planMigration({ results: [candidate], destinations: dest, force: true });
		expect(forced.actions[0]).toMatchObject({ status: "updated", operation: "update" });
	});

	test("invalid server name -> failed_invalid_source", async () => {
		const { actions } = await planMigration({
			results: [result({ mcpCandidates: [mcp("bad name", { command: "bin" })] })],
			destinations: dest,
			force: false,
		});
		expect(actions[0]).toMatchObject({ status: "failed_invalid_source", operation: "fail" });
	});

	test("unmappable entry -> skipped_unmappable", async () => {
		const { actions } = await planMigration({
			results: [result({ mcpCandidates: [mcp("srv", { foo: "bar" })] })],
			destinations: dest,
			force: false,
		});
		expect(actions[0]).toMatchObject({ status: "skipped_unmappable" });
	});

	test("malformed destination mcp.json -> failed_invalid_destination", async () => {
		await fs.writeFile(dest.mcpConfigPath, "{ not json", "utf-8");
		const { actions } = await planMigration({
			results: [result({ mcpCandidates: [mcp("srv", { command: "bin" })] })],
			destinations: dest,
			force: false,
		});
		expect(actions[0]).toMatchObject({ status: "failed_invalid_destination" });
	});

	test("force update of a disabled server preserves state and warns", async () => {
		await fs.writeFile(
			dest.mcpConfigPath,
			JSON.stringify({ mcpServers: { srv: { command: "old" } }, disabledServers: ["srv"] }),
			"utf-8",
		);
		const { actions, warnings } = await planMigration({
			results: [result({ mcpCandidates: [mcp("srv", { command: "new" })] })],
			destinations: dest,
			force: true,
		});
		expect(actions[0]).toMatchObject({ status: "updated" });
		expect(actions[0].warnings?.some(w => w.includes("disabled MCP state preserved"))).toBe(true);
		expect(warnings.some(w => w.message.includes("disabled MCP state preserved"))).toBe(true);
	});
});

describe("planMigration — skills", () => {
	test("fresh import is `imported`", async () => {
		const { actions } = await planMigration({
			results: [result({ skillCandidates: [skill("alpha")] })],
			destinations: dest,
			force: false,
		});
		expect(actions[0]).toMatchObject({
			type: "skill",
			name: "alpha",
			effectiveName: "alpha",
			operation: "create",
			status: "imported",
		});
	});

	test("existing skill: skip without force, update with force", async () => {
		await writeDestSkill("alpha", "description: existing");
		const cand = result({ skillCandidates: [skill("alpha")] });
		const skipped = await planMigration({ results: [cand], destinations: dest, force: false });
		expect(skipped.actions[0]).toMatchObject({ status: "skipped_exists" });
		const forced = await planMigration({ results: [cand], destinations: dest, force: true });
		expect(forced.actions[0]).toMatchObject({ status: "updated", operation: "update" });
	});

	test("stale dir (no SKILL.md): force reuses with warning reason", async () => {
		await fs.mkdir(path.join(dest.skillsDir, "alpha"), { recursive: true });
		const forced = await planMigration({
			results: [result({ skillCandidates: [skill("alpha")] })],
			destinations: dest,
			force: true,
		});
		expect(forced.actions[0]).toMatchObject({ status: "updated", reason: "stale skill directory reused" });
	});

	test("file at destination path: skip default, fail on force (no delete)", async () => {
		await fs.mkdir(dest.skillsDir, { recursive: true });
		await fs.writeFile(path.join(dest.skillsDir, "alpha"), "x", "utf-8");
		const skipped = await planMigration({
			results: [result({ skillCandidates: [skill("alpha")] })],
			destinations: dest,
			force: false,
		});
		expect(skipped.actions[0]).toMatchObject({ status: "skipped_exists" });
		const forced = await planMigration({
			results: [result({ skillCandidates: [skill("alpha")] })],
			destinations: dest,
			force: true,
		});
		expect(forced.actions[0]).toMatchObject({ status: "failed_invalid_destination" });
	});

	test("skills root symlink: skip default, fail on force", async () => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "migrate-planner-root-outside-"));
		try {
			await fs.symlink(outside, dest.skillsDir, "dir");
			const skipped = await planMigration({
				results: [result({ skillCandidates: [skill("alpha")] })],
				destinations: dest,
				force: false,
			});
			expect(skipped.actions[0]).toMatchObject({
				operation: "skip",
				status: "skipped_exists",
			});
			const forced = await planMigration({
				results: [result({ skillCandidates: [skill("alpha")] })],
				destinations: dest,
				force: true,
			});
			expect(forced.actions[0]).toMatchObject({
				operation: "fail",
				status: "failed_invalid_destination",
			});
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
		}
	});

	test("symlink at destination path: skip default, fail on force (no follow)", async () => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "migrate-planner-outside-"));
		try {
			await fs.mkdir(dest.skillsDir, { recursive: true });
			await fs.symlink(outside, path.join(dest.skillsDir, "alpha"), "dir");
			const skipped = await planMigration({
				results: [result({ skillCandidates: [skill("alpha")] })],
				destinations: dest,
				force: false,
			});
			expect(skipped.actions[0]).toMatchObject({
				operation: "skip",
				status: "skipped_exists",
			});
			const forced = await planMigration({
				results: [result({ skillCandidates: [skill("alpha")] })],
				destinations: dest,
				force: true,
			});
			expect(forced.actions[0]).toMatchObject({
				operation: "fail",
				status: "failed_invalid_destination",
			});
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
		}
	});

	test("effective-name collision across dirs: fail on force", async () => {
		// Existing dir "other" whose frontmatter name slugifies to "target".
		await writeDestSkill("other", "name: Target\ndescription: d");
		const forced = await planMigration({
			results: [result({ skillCandidates: [skill("target")] })],
			destinations: dest,
			force: true,
		});
		expect(forced.actions[0]).toMatchObject({ status: "failed_invalid_destination" });
	});

	test("intra-run duplicate slug -> second skipped_exists", async () => {
		const { actions } = await planMigration({
			results: [result({ skillCandidates: [skill("alpha"), skill("alpha")] })],
			destinations: dest,
			force: false,
		});
		expect(actions[0]).toMatchObject({ status: "imported" });
		expect(actions[1]).toMatchObject({ status: "skipped_exists", reason: "duplicate within this run" });
	});

	test("intra-run duplicate slug with --force: second overwrites same destination", async () => {
		const { actions } = await planMigration({
			results: [result({ skillCandidates: [skill("alpha"), skill("alpha")] })],
			destinations: dest,
			force: true,
		});
		expect(actions[0]).toMatchObject({ status: "imported" });
		expect(actions[1]).toMatchObject({ status: "updated", operation: "update" });
	});
});

describe("planMigration — instructions", () => {
	test("fresh instructions are imported and included in the scoped destination", async () => {
		const { actions } = await planMigration({
			results: [result({ instructionCandidates: [instruction("Follow the project rules.")] })],
			destinations: dest,
			force: false,
		});
		expect(actions[0]).toMatchObject({
			type: "instruction",
			name: "CLAUDE.md",
			destination: dest.instructionsPath,
			operation: "create",
			status: "imported",
			instruction: { content: "Follow the project rules." },
		});
	});

	test("existing instructions are skipped unless force is explicit", async () => {
		await fs.writeFile(dest.instructionsPath, "Existing instructions.", "utf-8");
		const candidate = result({ instructionCandidates: [instruction("Imported instructions.")] });
		const skipped = await planMigration({ results: [candidate], destinations: dest, force: false });
		expect(skipped.actions[0]).toMatchObject({ operation: "skip", status: "skipped_exists" });
		const forced = await planMigration({ results: [candidate], destinations: dest, force: true });
		expect(forced.actions[0]).toMatchObject({ operation: "update", status: "updated" });
	});

	test("multiple selected sources never silently overwrite the shared instructions file", async () => {
		const results = [
			result({ instructionCandidates: [instruction("Claude instructions.")] }),
			result({ instructionCandidates: [instruction("Codex instructions.", "codex")] }),
		];
		for (const force of [false, true]) {
			const { actions } = await planMigration({ results, destinations: dest, force });
			expect(actions[0]).toMatchObject({ status: "imported" });
			expect(actions[1]).toMatchObject({
				operation: "skip",
				status: "skipped_exists",
				reason: "another selected source already targets this file; import one source at a time",
			});
		}
	});

	test("a destination symlink is skipped by default and rejected with force", async () => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "migrate-instructions-outside-"));
		try {
			await fs.symlink(path.join(outside, "AGENTS.md"), dest.instructionsPath, "file");
			const candidate = result({ instructionCandidates: [instruction("Imported instructions.")] });
			const skipped = await planMigration({ results: [candidate], destinations: dest, force: false });
			expect(skipped.actions[0]).toMatchObject({ operation: "skip", status: "skipped_exists" });
			const forced = await planMigration({ results: [candidate], destinations: dest, force: true });
			expect(forced.actions[0]).toMatchObject({ operation: "fail", status: "failed_invalid_destination" });
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
		}
	});
});

describe("planMigration — diagnostics", () => {
	test("source diagnostics become source actions", async () => {
		const { actions } = await planMigration({
			results: [
				result({
					diagnostics: [{ source: "codex", type: "mcp", status: "failed_invalid_source", message: "bad toml" }],
				}),
			],
			destinations: dest,
			force: false,
		});
		expect(actions[0]).toMatchObject({ type: "source", status: "failed_invalid_source", operation: "fail" });
	});
});

describe("executeActions — instruction destination safety", () => {
	test("does not follow a symlinked project .gjc directory", async () => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "migrate-instructions-executor-outside-"));
		try {
			const agentRoot = path.join(tmp, ".gjc");
			await fs.symlink(outside, agentRoot, "dir");
			const [action] = await executeActions(
				[
					{
						source: "claude-code",
						type: "instruction",
						name: "CLAUDE.md",
						destination: path.join(agentRoot, "AGENTS.md"),
						operation: "create",
						status: "imported",
						instruction: { content: "Imported instructions." },
					},
				],
				{ project: true },
			);
			expect(action).toMatchObject({ operation: "fail", status: "failed_io" });
			expect(
				await fs.access(path.join(outside, "AGENTS.md")).then(
					() => true,
					() => false,
				),
			).toBe(false);
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
		}
	});
});

describe("executeActions — skill destination safety", () => {
	test("does not follow a symlinked ancestor while creating a skill", async () => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "migrate-executor-outside-"));
		try {
			const agentRoot = path.join(tmp, ".gjc");
			await fs.symlink(outside, agentRoot, "dir");
			const [action] = await executeActions([
				{
					source: "claude-code",
					type: "skill",
					name: "alpha",
					effectiveName: "alpha",
					destination: path.join(agentRoot, "skills", "alpha", "SKILL.md"),
					operation: "create",
					status: "imported",
					skill: { content: "---\ndescription: a\n---\nbody" },
				},
			]);

			expect(action).toMatchObject({ operation: "fail", status: "failed_io" });
			expect(
				await fs.access(path.join(outside, "skills", "alpha", "SKILL.md")).then(
					() => true,
					() => false,
				),
			).toBe(false);
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
		}
	});
});

describe("executeActions — mcp destination safety", () => {
	test("does not follow a symlinked .gjc while writing mcp config", async () => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "migrate-executor-mcp-outside-"));
		try {
			const agentRoot = path.join(tmp, ".gjc");
			await fs.symlink(outside, agentRoot, "dir");
			const [action] = await executeActions(
				[
					{
						source: "claude-code",
						type: "mcp",
						name: "alpha",
						destination: path.join(agentRoot, "mcp.json"),
						operation: "create",
						status: "imported",
						mcp: { config: { command: "alpha-bin" }, force: false },
					},
				],
				{ project: true },
			);

			expect(action).toMatchObject({ operation: "fail", status: "failed_io" });
			expect(
				await fs.access(path.join(outside, "mcp.json")).then(
					() => true,
					() => false,
				),
			).toBe(false);
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
		}
	});

	test("still allows an update when .gjc is a real directory", async () => {
		const agentRoot = path.join(tmp, ".gjc");
		await fs.mkdir(agentRoot);
		const destination = path.join(agentRoot, "mcp.json");
		await fs.writeFile(destination, JSON.stringify({ mcpServers: { alpha: { command: "old-bin" } } }), "utf-8");
		const [action] = await executeActions(
			[
				{
					source: "claude-code",
					type: "mcp",
					name: "alpha",
					destination,
					operation: "update",
					status: "updated",
					mcp: { config: { command: "new-bin" }, force: true },
				},
			],
			{ project: true },
		);

		expect(action).toMatchObject({ operation: "update", status: "updated" });
		const written = JSON.parse(await fs.readFile(destination, "utf-8")) as {
			mcpServers: { alpha: { command: string } };
		};
		expect(written.mcpServers.alpha.command).toBe("new-bin");
	});
});
