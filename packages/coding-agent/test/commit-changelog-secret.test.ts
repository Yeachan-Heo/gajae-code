import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, AssistantMessage, Model } from "@gajae-code/ai/core";
import * as aiCore from "@gajae-code/ai/core";

const SECRET = "sk-ant-GJCCANARY-changelog-0123456789abcdef";
const GOOGLE_KEY = `AIza${"S".repeat(35)}`;
const PLAIN_ENTRY = "document the config loader";

const model = { id: "test", api: "openai-responses", provider: "openai" } as Model<Api>;
const tempDirs: string[] = [];
let completeSimpleSpy: { mockRestore(): void } | undefined;

function assistantMessage(entries: Record<string, string[]>): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "changelog-test",
				name: "create_changelog_entries",
				arguments: { entries },
			},
		],
		api: "openai-responses",
		provider: "openai",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 0,
	};
}

function scriptCompleteSimple(entries: Record<string, string[]>): void {
	completeSimpleSpy = vi.spyOn(aiCore, "completeSimple").mockImplementation(async () => assistantMessage(entries));
}

async function runGit(cwd: string, args: string[]): Promise<void> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`git ${args.join(" ")} exited ${exitCode}: ${stderr}`);
	}
}

async function initRepo(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-changelog-secret-"));
	tempDirs.push(dir);
	await runGit(dir, ["init"]);
	await fs.mkdir(path.join(dir, "src"));
	await fs.writeFile(
		path.join(dir, "CHANGELOG.md"),
		["# Changelog", "", "## [Unreleased]", "", "### Added", "", "- existing safe entry", ""].join("\n"),
	);
	await fs.writeFile(path.join(dir, "src", "config.ts"), `export const key = "${SECRET}";\n`);
	await runGit(dir, ["add", "--", "src/config.ts"]);
	return dir;
}

async function stagedChangelog(cwd: string): Promise<string> {
	const proc = Bun.spawn(["git", "show", ":CHANGELOG.md"], { cwd, stdout: "pipe", stderr: "pipe" });
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`git show :CHANGELOG.md exited ${exitCode}: ${stderr}`);
	}
	return new Response(proc.stdout).text();
}

async function runFlow(cwd: string): Promise<string> {
	const { runChangelogFlow } = await import("../src/commit/changelog/index");
	const updated = await runChangelogFlow({
		cwd,
		model,
		apiKey: "test",
		stagedFiles: ["src/config.ts"],
		dryRun: false,
	});
	expect(updated).toEqual([path.join(cwd, "CHANGELOG.md")]);
	return fs.readFile(path.join(cwd, "CHANGELOG.md"), "utf8");
}

afterEach(async () => {
	completeSimpleSpy?.mockRestore();
	completeSimpleSpy = undefined;
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("runChangelogFlow changelog persistence", () => {
	it("writes a plain generated entry and keeps the existing line", async () => {
		scriptCompleteSimple({ Added: [PLAIN_ENTRY] });
		const changelog = await runFlow(await initRepo());

		expect(changelog).toContain(`- ${PLAIN_ENTRY}`);
		expect(changelog).toContain("- existing safe entry");
		expect(changelog).not.toContain("[REDACTED_TOKEN]");
	});

	it("does not persist a model-echoed token into CHANGELOG.md", async () => {
		scriptCompleteSimple({ Added: [`document key ${SECRET}`] });
		const changelog = await runFlow(await initRepo());

		expect(changelog).not.toContain(SECRET);
		expect(changelog).toContain("- document key [REDACTED_TOKEN]");
		expect(changelog).toContain("- existing safe entry");
	});

	it("does not persist a bare Google API key into CHANGELOG.md", async () => {
		scriptCompleteSimple({ Added: [`document loader ${GOOGLE_KEY}`] });
		const cwd = await initRepo();
		const changelog = await runFlow(cwd);
		const staged = await stagedChangelog(cwd);

		expect(changelog).not.toContain(GOOGLE_KEY);
		expect(staged).not.toContain(GOOGLE_KEY);
		expect(changelog).toContain("- document loader [REDACTED_TOKEN]");
		expect(staged).toContain("- document loader [REDACTED_TOKEN]");
		expect(changelog).toContain("- existing safe entry");
	});
});
