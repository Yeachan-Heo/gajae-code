/**
 * `createReportBundle()` is the archive a user attaches to a bug report.
 * Credential shapes in the transcript copies and in unsensitive environment
 * values must be replaced. Ordinary text that the unpatched bundle already
 * copied must still be copied.
 */
import { describe, expect, test, vi } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getEffectiveLogPath, getReportsDir, setAgentDir } from "@gajae-code/utils";
import { safeRm } from "../../../scripts/safe-cleanup";
import { createReportBundle } from "../src/debug/report-bundle";

const API_KEY_SHAPE = "sk-TESTFAKE99";
const GITHUB_TOKEN_SHAPE = "ghp_TESTFAKE01234567";
const PARENT_BASE = "2026-01-01T00-00-00_parent";
const CHILD_NAME = "2026-01-01T00-00-01_child.jsonl";

interface Seed {
	session: string;
	log: string;
	artifact: string;
	subagent: string;
	subagentArtifact: string;
	notes: string;
}

async function entryText(archivePath: string, name: string): Promise<string> {
	const archive = new Bun.Archive(await Bun.file(archivePath).bytes());
	const files = await archive.files();
	const file = files.get(name) ?? files.get(`./${name}`);
	if (!file) throw new Error(`missing archive entry ${name}`);
	return file.text();
}

function restoreVar(name: string, value: string | undefined): void {
	const env: Record<string, string | undefined> = process.env;
	if (value === undefined) delete env[name];
	else env[name] = value;
}

async function withFixture(seed: Seed, assert: (archivePath: string) => Promise<void>): Promise<void> {
	const originalHome = process.env.HOME;
	const originalGjcConfigDir = process.env.GJC_CONFIG_DIR;
	const originalPiConfigDir = process.env.PI_CONFIG_DIR;
	const originalCodingAgentDir = process.env.GJC_CODING_AGENT_DIR;
	const originalLogDir = process.env.GJC_LOG_DIR;
	const originalNotes = process.env.GJC_NOTES;
	const originalColor = process.env.GJC_COLOR;
	const originalEmpty = process.env.GJC_EMPTY;
	const originalAgentDir = getAgentDir();

	const homeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-report-home-"));
	const agentRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-report-agent-"));
	const logRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-report-log-"));
	const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(homeRoot);
	process.env.HOME = homeRoot;
	const configName = `gjc-report-${randomUUID()}`;
	process.env.GJC_CONFIG_DIR = configName;
	process.env.PI_CONFIG_DIR = configName;
	setAgentDir(agentRoot);
	process.env.GJC_LOG_DIR = logRoot;
	process.env.GJC_NOTES = seed.notes;
	process.env.GJC_COLOR = "blue";
	process.env.GJC_EMPTY = "";

	try {
		const exclusiveRoot = path.join(homeRoot, configName);
		const reportsDir = getReportsDir();
		if (!reportsDir.startsWith(`${exclusiveRoot}${path.sep}`)) {
			throw new Error("reports directory escaped the fixture root");
		}
		const logPath = getEffectiveLogPath();
		if (!logPath.startsWith(`${logRoot}${path.sep}`)) {
			throw new Error("log path escaped the fixture log root");
		}

		const sessionDir = path.join(homeRoot, "sessions");
		const sessionFile = path.join(sessionDir, `${PARENT_BASE}.jsonl`);
		const childFile = path.join(sessionDir, CHILD_NAME);
		await fs.mkdir(sessionFile.slice(0, -6), { recursive: true });
		await fs.mkdir(childFile.slice(0, -6), { recursive: true });
		await fs.writeFile(sessionFile, seed.session);
		await fs.writeFile(path.join(sessionFile.slice(0, -6), "note.txt"), seed.artifact);
		const header = JSON.stringify({ parentSession: `${PARENT_BASE}.jsonl` });
		await fs.writeFile(childFile, `${header}\n${seed.subagent}`);
		await fs.writeFile(path.join(childFile.slice(0, -6), "note.txt"), seed.subagentArtifact);
		await fs.mkdir(path.dirname(logPath), { recursive: true });
		await fs.writeFile(logPath, seed.log);

		const result = await createReportBundle({ sessionFile });
		if (!result.path.startsWith(`${reportsDir}${path.sep}`)) {
			throw new Error("report archive escaped the fixture reports directory");
		}
		await assert(result.path);
	} finally {
		restoreVar("GJC_EMPTY", originalEmpty);
		restoreVar("GJC_COLOR", originalColor);
		restoreVar("GJC_NOTES", originalNotes);
		restoreVar("PI_CONFIG_DIR", originalPiConfigDir);
		restoreVar("GJC_CONFIG_DIR", originalGjcConfigDir);
		setAgentDir(originalAgentDir);
		restoreVar("GJC_CODING_AGENT_DIR", originalCodingAgentDir);
		restoreVar("GJC_LOG_DIR", originalLogDir);
		restoreVar("HOME", originalHome);
		homedirSpy.mockRestore();
		await safeRm(agentRoot, { recursive: true, force: true });
		await safeRm(logRoot, { recursive: true, force: true });
		await safeRm(homeRoot, { recursive: true, force: true });
	}
}

describe.serial("createReportBundle", () => {
	test("redacts credential shapes from session, logs, artifacts, subagents, and env values", async () => {
		const leak = `value-held ${API_KEY_SHAPE} ${GITHUB_TOKEN_SHAPE}`;
		await withFixture(
			{
				session: `${leak}\n`,
				log: `${leak}\n`,
				artifact: `${leak}\n`,
				subagent: `${leak}\n`,
				subagentArtifact: `${leak}\n`,
				notes: leak,
			},
			async archivePath => {
				const names = [
					"session.jsonl",
					"logs.txt",
					"artifacts/note.txt",
					`subagents/${CHILD_NAME}`,
					`subagents/${CHILD_NAME.slice(0, -6)}/note.txt`,
					"env.json",
				];
				for (const name of names) {
					const text = await entryText(archivePath, name);
					expect(text.includes(API_KEY_SHAPE)).toBe(false);
					expect(text.includes(GITHUB_TOKEN_SHAPE)).toBe(false);
				}
				const session = await entryText(archivePath, "session.jsonl");
				expect(session).toContain("«redacted-api-key»");
				expect(session).toContain("«redacted-github-token»");
				const env = await entryText(archivePath, "env.json");
				expect(env).toContain("«redacted-github-token»");
				expect(env).toContain('"GJC_NOTES"');
				expect(env).toContain('"GJC_COLOR": "blue"');
			},
		);
	});

	test("keeps ordinary session, log, artifact, and env text", async () => {
		await withFixture(
			{
				session: "ordinary session line\npath /var/log/app.log\nalready «redacted-api-key»\n",
				log: "ordinary log line\n",
				artifact: "ordinary artifact note\n",
				subagent: "ordinary subagent note\n",
				subagentArtifact: "ordinary subagent artifact\n",
				notes: "ordinary-note",
			},
			async archivePath => {
				const session = await entryText(archivePath, "session.jsonl");
				expect(session).toContain("ordinary session line");
				expect(session).toContain("path /var/log/app.log");
				expect(session).toContain("already «redacted-api-key»");
				expect(await entryText(archivePath, "logs.txt")).toContain("ordinary log line");
				expect(await entryText(archivePath, "artifacts/note.txt")).toContain("ordinary artifact note");
				expect(await entryText(archivePath, `subagents/${CHILD_NAME}`)).toContain("ordinary subagent note");
				expect(await entryText(archivePath, `subagents/${CHILD_NAME.slice(0, -6)}/note.txt`)).toContain(
					"ordinary subagent artifact",
				);
				const env = await entryText(archivePath, "env.json");
				expect(env).toContain('"GJC_NOTES": "ordinary-note"');
				expect(env).toContain('"GJC_COLOR": "blue"');
				expect(env).toContain('"GJC_EMPTY": ""');
			},
		);
	});
});
