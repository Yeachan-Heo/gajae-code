import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	BUNDLE_FORMAT_VERSION,
	BUNDLE_MANIFEST_NAME,
	bundleContentFiles,
	checkSdkSkillFiles,
	findUnexpectedSdkSkillFiles,
	renderSdkSkillFiles,
	validateBundleManifest,
	validateInstalledBundle,
	validatePromptAllowlistConsistency,
} from "./generate-gjc-sdk-skills";

const repoRoot = path.join(import.meta.dir, "..");
const roots: string[] = [];

const CORE_QUERIES = [
	"session.metadata",
	"context.get",
	"goal.list/get",
	"todo.list",
	"workflow.gates.list",
	"session.stats",
] as const;

type CliCall = {
	args: string[];
	cwd: string;
};

type CliFixture = {
	repo: string;
	binDir: string;
	callsPath: string;
	secret: string;
};

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function materialize(): Promise<{ files: Map<string, string>; root: string }> {
	const files = renderSdkSkillFiles();
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-sdk-skills-test-"));
	roots.push(root);
	for (const [rel, content] of files) {
		const target = path.join(root, rel);
		await fs.mkdir(path.dirname(target), { recursive: true });
		await Bun.write(target, content);
	}
	return { files, root };
}

async function cliFixture(): Promise<CliFixture> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-sdk-template-cli-test-"));
	roots.push(root);
	const repo = path.join(root, "repo");
	const binDir = path.join(root, "bin");
	const callsPath = path.join(root, "calls.json");
	const secret = "template-cli-secret";
	await fs.mkdir(repo, { recursive: true });
	await fs.mkdir(binDir, { recursive: true });
	const executable = path.join(binDir, "gjc");
	await Bun.write(
		executable,
		`#!/usr/bin/env bun
const callsPath = Bun.env.GJC_TEMPLATE_CALLS;
const secret = Bun.env.GJC_TEMPLATE_SECRET;
if (!callsPath || !secret) process.exit(2);
const calls = (await Bun.file(callsPath).exists()) ? await Bun.file(callsPath).json() : [];
if (!Array.isArray(calls)) process.exit(2);
const args = process.argv.slice(2);
calls.push({ args, cwd: process.cwd() });
await Bun.write(callsPath, JSON.stringify(calls));
const queryIndex = args.indexOf("--query");
const query = queryIndex === -1 ? undefined : args[queryIndex + 1];
if (query === "session.stats") {
	process.stderr.write("private=" + secret + "\\n");
	process.exitCode = 1;
} else {
	process.stdout.write(JSON.stringify({ ok: true, result: { query: query ?? "control", token: secret } }) + "\\n");
}
`,
	);
	await fs.chmod(executable, 0o755);
	return { repo, binDir, callsPath, secret };
}

async function cliCalls(fixture: CliFixture): Promise<CliCall[]> {
	if (!(await Bun.file(fixture.callsPath).exists())) return [];
	return (await Bun.file(fixture.callsPath).json()) as CliCall[];
}

async function runTypeScriptTemplate(
	fixture: CliFixture,
	args: string[],
	approval: "none" | "deny" | "accept" | { reply: string } = "none",
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const child = Bun.spawn(["bun", path.join(repoRoot, "sdk-skills", "gjc-sdk-author", "templates", "direct-sdk.ts"), ...args], {
		env: {
			...process.env,
			PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
			GJC_TEMPLATE_CALLS: fixture.callsPath,
			GJC_TEMPLATE_SECRET: fixture.secret,
		},
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (approval !== "accept") {
		if (approval === "deny") child.stdin.write("DENY\n");
		if (typeof approval === "object") child.stdin.write(`${approval.reply}\n`);
		child.stdin.end();
	}
	const stderrPromise = (async () => {
		const reader = child.stderr.getReader();
		const decoder = new TextDecoder();
		let stderr = "";
		let answered = false;
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			stderr += decoder.decode(value, { stream: true });
			if (approval === "accept" && !answered) {
				const challenge = stderr.match(/Approval required: (APPROVE [^\n]+)/)?.[1];
				if (challenge) {
					child.stdin.write(`${challenge}\n`);
					child.stdin.end();
					answered = true;
				}
			}
		}
		return stderr + decoder.decode();
	})();
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		stderrPromise,
	]);
	return { exitCode, stdout, stderr };
}

describe("generated external GJC SDK skills", () => {
	it("renders the exact namespaced six-file versioned contract", () => {
		const files = renderSdkSkillFiles();
		expect([...files.keys()].sort()).toEqual(
			[
				BUNDLE_MANIFEST_NAME,
				"gjc-sdk-discover/SKILL.md",
				"gjc-sdk-operate/SKILL.md",
				"gjc-sdk-author/SKILL.md",
				"gjc-sdk-author/templates/direct-sdk.ts",
				"gjc-sdk-author/templates/direct-sdk.py",
			].sort(),
		);
		const manifest = JSON.parse(files.get(BUNDLE_MANIFEST_NAME) ?? "{}") as {
			bundle?: unknown;
			formatVersion?: unknown;
			files?: unknown;
		};
		expect(manifest.bundle).toBe("gjc-sdk-skills");
		expect(manifest.formatVersion).toBe(BUNDLE_FORMAT_VERSION);
		expect(manifest.files).toEqual(bundleContentFiles(files));
		expect(files.get("gjc-sdk-discover/SKILL.md")).toContain("name: gjc-sdk-discover");
		expect(files.get("gjc-sdk-operate/SKILL.md")).toContain("name: gjc-sdk-operate");
		expect(files.get("gjc-sdk-author/SKILL.md")).toContain("name: gjc-sdk-author");
	});

	it("renders deterministically and keeps the prompt allowlist in sync", () => {
		const first = renderSdkSkillFiles();
		const second = renderSdkSkillFiles();
		expect([...first.entries()]).toEqual([...second.entries()]);
		expect(validatePromptAllowlistConsistency()).toBeNull();
	});

	it("keeps the four default workflow skills closed and adds no extra skills", async () => {
		const files = renderSdkSkillFiles();
		const skills = [...files.keys()].filter(key => key.endsWith("/SKILL.md")).sort();
		expect(skills).toEqual(["gjc-sdk-author/SKILL.md", "gjc-sdk-discover/SKILL.md", "gjc-sdk-operate/SKILL.md"]);
		for (const key of files.keys()) {
			expect(key.startsWith("packages/coding-agent/")).toBe(false);
			expect(key.startsWith(".gjc/")).toBe(false);
			const topLevel = key.split("/")[0];
			if (topLevel !== BUNDLE_MANIFEST_NAME) {
				expect(["gjc-sdk-author", "gjc-sdk-discover", "gjc-sdk-operate"]).toContain(topLevel);
			}
		}
		const defaultsRoot = path.join(repoRoot, "packages", "coding-agent", "src", "defaults", "gjc", "skills");
		const defaultSkills = (await fs.readdir(defaultsRoot, { withFileTypes: true }))
			.filter(entry => entry.isDirectory())
			.map(entry => entry.name)
			.sort();
		expect(defaultSkills).toEqual(["autoresearch", "deep-interview", "ralplan", "ultragoal"]);

		const extra = await materialize();
		await fs.mkdir(path.join(extra.root, "gjc-sdk-bash"));
		await Bun.write(path.join(extra.root, "gjc-sdk-bash", "SKILL.md"), "---\nname: gjc-sdk-bash\n---\n");
		expect(await findUnexpectedSdkSkillFiles(extra.files, extra.root)).toEqual([path.join("gjc-sdk-bash", "SKILL.md")]);
		expect(await checkSdkSkillFiles(extra.files, extra.root, false)).toBe(1);
	});

	it("fails closed on missing, malformed, and unsupported manifest versions", async () => {
		const files = renderSdkSkillFiles();
		const contentFiles = bundleContentFiles(files);
		const manifest = files.get(BUNDLE_MANIFEST_NAME) ?? "";

		expect(validateBundleManifest(manifest, contentFiles)).toBeNull();
		expect(validateBundleManifest(null, contentFiles)).toContain("no format version");
		expect(validateBundleManifest("not json", contentFiles)).toContain("unparseable JSON");
		expect(
			validateBundleManifest(JSON.stringify({ bundle: "gjc-sdk-skills", formatVersion: 999, files: contentFiles }), contentFiles),
		).toContain("unsupported");
		expect(
			validateBundleManifest(
				JSON.stringify({ bundle: "gjc-sdk-skills", formatVersion: BUNDLE_FORMAT_VERSION, files: ["gjc-sdk-bash/SKILL.md"] }),
				contentFiles,
			),
		).toContain("file list does not match");
		expect(
			validateBundleManifest(JSON.stringify({ bundle: "other-bundle", formatVersion: BUNDLE_FORMAT_VERSION, files: contentFiles }), contentFiles),
		).toContain("bundle name mismatch");

		const missingManifest = await materialize();
		await fs.rm(path.join(missingManifest.root, BUNDLE_MANIFEST_NAME));
		expect(await checkSdkSkillFiles(missingManifest.files, missingManifest.root, false)).toBe(1);
	});

	it("upgrades installed v1 bundles and fails closed on legacy or future layouts", async () => {
		const files = renderSdkSkillFiles();
		const contentFiles = bundleContentFiles(files);

		const installed = await materialize();
		expect(await validateInstalledBundle(installed.root)).toBeNull();
		expect(await checkSdkSkillFiles(installed.files, installed.root, false)).toBe(0);

		const legacy = await materialize();
		await fs.rm(path.join(legacy.root, BUNDLE_MANIFEST_NAME));
		expect(await validateInstalledBundle(legacy.root)).toContain("regenerate with `bun run generate-sdk-skills`");
		expect(await checkSdkSkillFiles(legacy.files, legacy.root, false)).toBe(1);

		const future = await materialize();
		await Bun.write(
			path.join(future.root, BUNDLE_MANIFEST_NAME),
			JSON.stringify({ bundle: "gjc-sdk-skills", formatVersion: 2, files: contentFiles }, null, 2) + "\n",
		);
		expect(await validateInstalledBundle(future.root)).toContain("unsupported");
		expect(await checkSdkSkillFiles(future.files, future.root, false)).toBe(1);

		const upgrade = await materialize();
		await fs.rm(path.join(upgrade.root, BUNDLE_MANIFEST_NAME));
		for (const [rel, content] of files) await Bun.write(path.join(upgrade.root, rel), content);
		expect(await validateInstalledBundle(upgrade.root)).toBeNull();
	});

	it("matches the committed bundle byte-for-byte", async () => {
		const files = renderSdkSkillFiles();
		expect(await checkSdkSkillFiles(files)).toBe(0);
	});

	it("passes the generator drift check as a subprocess", async () => {
		const child = Bun.spawn(["bun", path.join(repoRoot, "scripts", "generate-gjc-sdk-skills.ts"), "--check"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("SDK skill bundle is in sync");
		expect(stderr).toBe("");
	});

	it("rejects missing, drifted, and unexpected generated files", async () => {
		const missing = await materialize();
		await fs.rm(path.join(missing.root, "gjc-sdk-discover", "SKILL.md"));
		expect(await checkSdkSkillFiles(missing.files, missing.root, false)).toBe(1);

		const drifted = await materialize();
		await Bun.write(path.join(drifted.root, "gjc-sdk-operate", "SKILL.md"), `${drifted.files.get(path.join("gjc-sdk-operate", "SKILL.md")) ?? ""}drift\n`);
		expect(await checkSdkSkillFiles(drifted.files, drifted.root, false)).toBe(1);

		const symlinked = await materialize();
		const target = path.join(symlinked.root, "gjc-sdk-operate", "SKILL.md");
		const contents = await Bun.file(target).text();
		await fs.rm(target);
		const backing = path.join(symlinked.root, "same-bytes.md");
		await Bun.write(backing, contents);
		await fs.symlink(backing, target);
		expect(await checkSdkSkillFiles(symlinked.files, symlinked.root, false)).toBe(1);

		const linkedManifest = await materialize();
		const manifestPath = path.join(linkedManifest.root, BUNDLE_MANIFEST_NAME);
		const manifestContents = await Bun.file(manifestPath).text();
		await fs.rm(manifestPath);
		const manifestBacking = path.join(linkedManifest.root, "same-manifest-bytes.json");
		await Bun.write(manifestBacking, manifestContents);
		await fs.symlink(manifestBacking, manifestPath);
		expect(await validateInstalledBundle(linkedManifest.root)).toContain("no format version");
		expect(await checkSdkSkillFiles(linkedManifest.files, linkedManifest.root, false)).toBe(1);

		if (process.platform !== "win32") {
			const fifo = await materialize();
			const fifoPath = path.join(fifo.root, "gjc-sdk-discover", "SKILL.md");
			await fs.rm(fifoPath);
			const created = Bun.spawnSync(["mkfifo", fifoPath]);
			expect(created.exitCode).toBe(0);
			expect(await checkSdkSkillFiles(fifo.files, fifo.root, false)).toBe(1);
		}

		const unexpected = await materialize();
		const stale = path.join(unexpected.root, "gjc-sdk-author", "stale.md");
		await Bun.write(stale, "stale\n");
		expect(await findUnexpectedSdkSkillFiles(unexpected.files, unexpected.root)).toEqual([
			path.join("gjc-sdk-author", "stale.md"),
		]);
		expect(await checkSdkSkillFiles(unexpected.files, unexpected.root, false)).toBe(1);
	});

	it("keeps broker-bound templates and guidance fail-closed and outside endpoint authority", () => {
		const files = renderSdkSkillFiles();
		const typescript = files.get("gjc-sdk-author/templates/direct-sdk.ts") ?? "";
		const python = files.get("gjc-sdk-author/templates/direct-sdk.py") ?? "";
		const discover = files.get("gjc-sdk-discover/SKILL.md") ?? "";
		const operate = files.get("gjc-sdk-operate/SKILL.md") ?? "";
		const author = files.get("gjc-sdk-author/SKILL.md") ?? "";
		for (const source of [typescript, python]) {
			expect(source).toContain("human_approval_required");
			expect(source).toContain("[REDACTED]");
			expect(source).toContain("APPROVE");
			expect(source).toContain("Type the exact challenge");
			expect(source).not.toContain("--approval");
			expect(source).not.toContain('"--token"');
			expect(source).not.toContain(".gjc/state/sdk");
			expect(source).not.toContain("listSdkSessionEndpoints");
			expect(source).not.toContain("read_session_endpoint");
			expect(source).not.toContain("select_live_endpoint");
			expect(source).not.toContain("SdkClient");
			expect(source).not.toContain("connect_ws");
			expect(source).not.toContain("WebSocket");
			expect(source).not.toContain("mcp-serve");
			expect(source).not.toContain("coordinator-mcp");
		}
		expect(typescript).toContain('Bun.spawn(["gjc", "sdk", "session"');
		expect(python).toContain('["gjc", "sdk", "session", *arguments]');
		expect(typescript).toContain("ALLOWED_CONTROLS.has");
		expect(python).toContain("operation not in ALLOWED_CONTROLS");
		expect(python).toContain("file=sys.stderr");
		expect(python).toContain("sys.stdin.readline()");
		expect(discover).toContain("gjc sdk session list");
		expect(operate).toContain("gjc sdk session raw");
		expect(author).toContain("gjc sdk session");
		for (const source of [discover, operate, author]) {
			expect(source).not.toContain("Read the local SDK discovery records");
			expect(source).not.toContain("listSdkSessionEndpoints");
			expect(source).not.toContain("read_session_endpoint");
			expect(source).not.toContain("select_live_endpoint");
			expect(source).not.toContain("SdkClient.connect");
			expect(source).not.toContain("connect_ws");
		}
	});

	it("executes the TypeScript inspection recipe through the broker-bound CLI without credentials", async () => {
		const fixture = await cliFixture();
		const result = await runTypeScriptTemplate(fixture, [
			"--repo",
			fixture.repo,
			"--session-id",
			"session-1",
			"--mode",
			"inspect",
		]);
		expect(result.exitCode, result.stderr).toBe(0);
		const calls = await cliCalls(fixture);
		expect(calls).toHaveLength(CORE_QUERIES.length);
		expect(calls.map(call => call.args)).toEqual(
			CORE_QUERIES.map(query => ["sdk", "session", "raw", "query", "session-1", "--query", query]),
		);
		expect(calls.every(call => call.cwd === fixture.repo)).toBe(true);
		expect(result.stdout).toContain('"status": "confirmed"');
		expect(result.stdout).toContain('"status": "unavailable"');
		expect(result.stdout).toContain("[REDACTED]");
		expect(result.stdout + result.stderr).not.toContain(fixture.secret);
	});

	it("sends no control until approval matches the exact operation, session, and input", async () => {
		const fixture = await cliFixture();
		const args = [
			"--repo",
			fixture.repo,
			"--session-id",
			"session-1",
			"--mode",
			"control",
			"--operation",
			"turn.prompt",
			"--input",
			'{"prompt":"hello"}',
		];
		const denied = await runTypeScriptTemplate(fixture, args, "deny");
		expect(denied.exitCode).toBe(1);
		expect(await cliCalls(fixture)).toEqual([]);
		expect(denied.stderr).not.toContain(fixture.secret);

		const approved = await runTypeScriptTemplate(fixture, args, "accept");
		expect(approved.exitCode, approved.stderr).toBe(0);
		const calls = await cliCalls(fixture);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.args).toEqual([
			"sdk",
			"session",
			"raw",
			"control",
			"session-1",
			"--op",
			"turn.prompt",
			"--json-input",
			'{"prompt":"hello"}',
			"--confirm",
		]);
		expect(approved.stdout + approved.stderr).not.toContain(fixture.secret);
		const acceptedChallenge = approved.stderr.match(/Approval required: (APPROVE [^\n]+)/)?.[1];
		expect(acceptedChallenge).toBeDefined();
		const replayed = await runTypeScriptTemplate(fixture, args, { reply: acceptedChallenge! });
		expect(replayed.exitCode).toBe(1);
		expect(await cliCalls(fixture)).toHaveLength(1);
	}, 15_000);

	it("requires an explicit session ID and rejects secret-shaped input before invoking the CLI", async () => {
		const fixture = await cliFixture();
		const stateDirectory = path.join(fixture.repo, ".gjc", "state", "sdk");
		await fs.mkdir(stateDirectory, { recursive: true });
		await Bun.write(path.join(stateDirectory, "session-1.json"), '{"token":"must-not-read"}\n');

		const missingSession = await runTypeScriptTemplate(fixture, ["--repo", fixture.repo, "--mode", "inspect"]);
		expect(missingSession.exitCode).toBe(1);
		const secretInput = await runTypeScriptTemplate(fixture, [
			"--repo",
			fixture.repo,
			"--session-id",
			"session-1",
			"--mode",
			"control",
			"--operation",
			"turn.prompt",
			"--input",
			'{"token":"must-not-print"}',
		]);
		expect(secretInput.exitCode).toBe(1);
		expect(secretInput.stdout + secretInput.stderr).not.toContain("must-not-print");
		expect(await cliCalls(fixture)).toEqual([]);
	});

	it("binds workflow gate answers to the explicit session before broker dispatch", async () => {
		const fixture = await cliFixture();
		const result = await runTypeScriptTemplate(
			fixture,
			[
				"--repo",
				fixture.repo,
				"--session-id",
				"session-1",
				"--mode",
				"control",
				"--operation",
				"workflow.gate_answer",
				"--input",
				'{"id":"gate-1","response":"approve"}',
			],
			"accept",
		);
		expect(result.exitCode, result.stderr).toBe(0);
		const calls = await cliCalls(fixture);
		const inputIndex = calls[0]?.args.indexOf("--json-input") ?? -1;
		expect(inputIndex).toBeGreaterThanOrEqual(0);
		expect(JSON.parse(calls[0]?.args[inputIndex + 1] ?? "{}")).toEqual({
			id: "gate-1",
			response: "approve",
			expectedSessionId: "session-1",
		});
	});
});
