import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AgentMessage } from "@gajae-code/agent-core";
import { TempDir } from "@gajae-code/utils";
import { $ } from "bun";
import {
	buildContributionPrepWorkerPrompt,
	prepareContributionPrep,
	redactContributionPrepText,
} from "../src/session/contribution-prep";
import { lookupBuiltinSlashCommand } from "../src/slash-commands/builtin-registry";

describe("contribution prep", () => {
	it("redacts secrets, private endpoints, cookies, auth headers, and home paths", () => {
		const text = [
			"Authorization: Bearer sk-testsecret123456789",
			"Cookie: sid=abc123; token=private",
			"OPENAI_API_KEY=sk-providersecret123456789",
			"callback http://127.0.0.1:8787/internal",
			"classic ghp_abcdefghijklmnopqrstuvwxyz123456",
			"oauth gho_abcdefghijklmnopqrstuvwxyz123456",
			"fine github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz1234567890",
			`${process.env.HOME ?? ""}/project/file.ts`,
		].join("\n");

		const redacted = redactContributionPrepText(text, process.cwd());

		expect(redacted).toContain("Authorization: [REDACTED_AUTH_HEADER]");
		expect(redacted).toContain("Cookie: [REDACTED_COOKIE]");
		expect(redacted).toContain("OPENAI_API_KEY=[REDACTED_SECRET]");
		expect(redacted).toContain("[REDACTED_PRIVATE_ENDPOINT]");
		expect(redacted).not.toContain("sk-testsecret123456789");
		expect(redacted).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
		expect(redacted).not.toContain("gho_abcdefghijklmnopqrstuvwxyz123456");
		expect(redacted).not.toContain("github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz1234567890");
		expect(redacted).not.toContain(process.env.HOME ?? "__missing_home__");
	});

	it("writes a manifest with redacted file-pointer artifacts", async () => {
		const tempDir = TempDir.createSync("@gjc-contribution-prep-");
		try {
			await Bun.write(path.join(tempDir.path(), "tracked.txt"), "changed");
			await $`git init`.cwd(tempDir.path()).quiet();
			await $`git add tracked.txt`.cwd(tempDir.path()).quiet();
			await $`git -c user.email=test@example.com -c user.name=Test commit -m initial`.cwd(tempDir.path()).quiet();
			await Bun.write(
				path.join(tempDir.path(), "tracked.txt"),
				"changed ghp_abcdefghijklmnopqrstuvwxyz123456 github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz1234567890\n",
			);
			const messages: AgentMessage[] = [
				{ role: "user", content: "Failure uses Authorization: Bearer ghp_secretsecretsecret", timestamp: 1 },
				{
					role: "assistant",
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-test",
					timestamp: 2,
					content: [{ type: "text", text: "Check http://192.168.0.10:3000/private" }],
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
				},
			];

			const result = await prepareContributionPrep(
				{
					sessionId: "session-123",
					cwd: tempDir.path(),
					messages,
					sessionFile: path.join(tempDir.path(), "session.jsonl"),
				},
				{ artifactRoot: path.join(tempDir.path(), "artifacts"), now: new Date("2026-05-31T00:00:00.000Z") },
			);

			const manifest = JSON.parse(await Bun.file(result.manifestPath).text()) as {
				schema_version: number;
				source_session_id: string;
				artifacts: Array<{ path: string; description: string }>;
				redactions: string[];
				recommended_output: string[];
				worker_prompt_path: string;
			};
			const transcriptPath = manifest.artifacts.find(artifact => artifact.path.endsWith("transcript.md"))?.path;
			expect(manifest.schema_version).toBe(1);
			expect(manifest.source_session_id).toBe("session-123");
			expect(manifest.worker_prompt_path).toBe(result.workerPromptPath);
			expect(manifest.recommended_output).toContain("uncertainty / remaining risks");
			expect(manifest.redactions).toContain("auth_headers");
			expect(manifest.redactions).toContain("private_endpoints");
			expect(transcriptPath).toBeTruthy();
			const transcript = await Bun.file(transcriptPath ?? "").text();
			expect(transcript).toContain("[REDACTED_AUTH_HEADER]");
			expect(transcript).toContain("[REDACTED_PRIVATE_ENDPOINT]");
			const diffPath = manifest.artifacts.find(artifact => artifact.path.endsWith("git-diff.patch"))?.path;
			expect(diffPath).toBeTruthy();
			const gitDiff = await Bun.file(diffPath ?? "").text();
			expect(gitDiff).toContain("[REDACTED_TOKEN]");
			expect(gitDiff).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
			expect(gitDiff).not.toContain("github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz1234567890");
		} finally {
			tempDir.remove();
		}
	});

	it("worker prompt references the manifest instead of inlining transcript", () => {
		const prompt = buildContributionPrepWorkerPrompt("/tmp/context/manifest.json");

		expect(prompt).toContain("Manifest: /tmp/context/manifest.json");
		expect(prompt).toContain("file pointers");
		expect(prompt).toContain("Do not create GitHub issues");
	});

	it("can prepare a worker spawn without mutating source-session identity", async () => {
		const tempDir = TempDir.createSync("@gjc-contribution-prep-spawn-");
		try {
			const spawns: Array<{ args: string[]; cwd: string }> = [];
			const result = await prepareContributionPrep(
				{ sessionId: "source-session", cwd: tempDir.path(), messages: [] },
				{
					artifactRoot: path.join(tempDir.path(), "artifacts"),
					spawnWorker: true,
					spawn: async (args, cwd) => {
						spawns.push({ args, cwd });
					},
				},
			);
			const manifest = JSON.parse(await Bun.file(result.manifestPath).text()) as { source_session_id: string };

			expect(result.spawned).toBe(true);
			expect(spawns).toHaveLength(1);
			expect(spawns[0]?.args).toContain(`@${result.workerPromptPath}`);
			expect(spawns[0]?.args).toContain("--no-skills");
			expect(spawns[0]?.args[0]).toBeTruthy();
			expect(spawns[0]?.cwd).toBe(tempDir.path());
			expect(manifest.source_session_id).toBe("source-session");
		} finally {
			tempDir.remove();
		}
	});

	it("ignores PI_SUBPROCESS_CMD when spawning contribution workers", async () => {
		const tempDir = TempDir.createSync("@gjc-contribution-prep-env-spawn-");
		const previous = process.env.PI_SUBPROCESS_CMD;
		process.env.PI_SUBPROCESS_CMD = "/tmp/evil-gjc";
		try {
			const spawns: Array<{ args: string[]; cwd: string }> = [];
			await prepareContributionPrep(
				{ sessionId: "source-session", cwd: tempDir.path(), messages: [] },
				{
					artifactRoot: path.join(tempDir.path(), "artifacts"),
					spawnWorker: true,
					spawn: async (args, cwd) => {
						spawns.push({ args, cwd });
					},
				},
			);

			expect(spawns).toHaveLength(1);
			expect(spawns[0]?.args[0]).not.toBe("/tmp/evil-gjc");
			expect(spawns[0]?.args).toContain("--no-skills");
		} finally {
			if (previous === undefined) delete process.env.PI_SUBPROCESS_CMD;
			else process.env.PI_SUBPROCESS_CMD = previous;
			tempDir.remove();
		}
	});

	it("resolves worker spawn argv through the GJC command and prompt file", async () => {
		const tempDir = TempDir.createSync("@gjc-contribution-prep-real-spawn-");
		try {
			const child = Bun.spawn({
				cmd: [process.execPath, "--version"],
				stdout: "pipe",
				stderr: "pipe",
			});
			const exitCode = await child.exited;
			expect(exitCode).toBe(0);

			let observed: string[] = [];
			await prepareContributionPrep(
				{ sessionId: "source-session", cwd: tempDir.path(), messages: [] },
				{
					artifactRoot: path.join(tempDir.path(), "artifacts"),
					spawnWorker: true,
					spawn: async args => {
						observed = args;
						const probe = Bun.spawn({
							cmd: [args[0] ?? process.execPath, "--version"],
							stdout: "pipe",
							stderr: "pipe",
						});
						expect(await probe.exited).toBe(0);
					},
				},
			);

			expect(observed).toContain("--no-skills");
			expect(observed.some(arg => arg.startsWith("@") && arg.endsWith("worker-prompt.md"))).toBe(true);
		} finally {
			tempDir.remove();
		}
	});

	it("advertises the issue-approved contribute-pr slash command with legacy alias", () => {
		const command = lookupBuiltinSlashCommand("contribute-pr");
		const legacy = lookupBuiltinSlashCommand("contribution-prep");

		expect(command?.name).toBe("contribute-pr");
		expect(legacy).toBe(command);
	});
});
