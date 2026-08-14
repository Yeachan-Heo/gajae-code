import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ServerWebSocket } from "bun";
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
const servers: Bun.Server<undefined>[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
	for (const server of servers.splice(0)) server.stop(true);
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

async function endpointRepo(url: string, token: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-sdk-template-test-"));
	roots.push(root);
	const directory = path.join(root, ".gjc", "state", "sdk");
	await fs.mkdir(directory, { recursive: true });
	await Bun.write(
		path.join(directory, "session-1.json"),
		JSON.stringify({ version: 1, sessionId: "session-1", url, token, pid: process.pid, stale: false }),
	);
	return root;
}

function startSdkServer(frames: Array<Record<string, unknown>>): { url: string; token: string } {
	const token = "template-test-secret";
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			if (new URL(request.url).searchParams.get("token") !== token) return new Response("Unauthorized", { status: 401 });
			if (!server.upgrade(request, { data: undefined })) return new Response("Upgrade failed", { status: 400 });
		},
		websocket: {
			open(socket: ServerWebSocket<undefined>) {
				socket.send(JSON.stringify({ type: "hello", connectionId: "template-test" }));
			},
			message(socket: ServerWebSocket<undefined>, raw: string | Buffer) {
				const frame = JSON.parse(String(raw)) as Record<string, unknown>;
				frames.push(frame);
				if (frame.type === "query_request") {
					const failed = frame.query === "session.stats";
					socket.send(
						JSON.stringify(
							failed
								? { type: "query_response", id: frame.id, ok: false, error: { code: "unavailable", message: `failed-${token}` } }
								: { type: "query_response", id: frame.id, ok: true, result: { query: frame.query, data: `prefix-${token}-suffix` } },
						),
					);
				}
				if (frame.type === "control_request")
					socket.send(JSON.stringify({ type: "control_response", id: frame.id, ok: true, result: { accepted: true } }));
			},
		},
	});
	servers.push(server);
	return { url: `ws://127.0.0.1:${server.port}`, token };
}

async function runTypeScriptTemplate(
	args: string[],
	approval: "none" | "deny" | "accept" | { reply: string } = "none",
	onChallenge?: () => void | Promise<void>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const child = Bun.spawn(["bun", path.join(repoRoot, "sdk-skills", "gjc-sdk-author", "templates", "direct-sdk.ts"), ...args], {
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
					await onChallenge?.();
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
		expect(defaultSkills).toEqual(["deep-interview", "ralplan", "team", "ultragoal"]);

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
			validateBundleManifest(JSON.stringify({ bundle: "gjc-sdk-skills", formatVersion: BUNDLE_FORMAT_VERSION, files: ["gjc-sdk-bash/SKILL.md"] }), contentFiles),
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

		// A legacy unversioned install (the original five-file layout) must be
		// rejected with a migration hint instead of being read ambiguously.
		const legacy = await materialize();
		await fs.rm(path.join(legacy.root, BUNDLE_MANIFEST_NAME));
		expect(await validateInstalledBundle(legacy.root)).toContain("regenerate with `bun run generate-sdk-skills`");
		expect(await checkSdkSkillFiles(legacy.files, legacy.root, false)).toBe(1);

		// A future incompatible layout must fail closed on the version field.
		const future = await materialize();
		await Bun.write(
			path.join(future.root, BUNDLE_MANIFEST_NAME),
			JSON.stringify({ bundle: "gjc-sdk-skills", formatVersion: 2, files: contentFiles }, null, 2) + "\n",
		);
		expect(await validateInstalledBundle(future.root)).toContain("unsupported");
		expect(await checkSdkSkillFiles(future.files, future.root, false)).toBe(1);

		// Regeneration upgrades an installed bundle in place to the versioned format.
		const upgrade = await materialize();
		await fs.rm(path.join(upgrade.root, BUNDLE_MANIFEST_NAME));
		for (const [rel, content] of files) {
			await Bun.write(path.join(upgrade.root, rel), content);
		}
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

	it("keeps direct-client templates fail-closed and credential-safe", () => {
		const files = renderSdkSkillFiles();
		const typescript = files.get("gjc-sdk-author/templates/direct-sdk.ts") ?? "";
		const python = files.get("gjc-sdk-author/templates/direct-sdk.py") ?? "";
		for (const source of [typescript, python]) {
			expect(source).toContain("human_approval_required");
			expect(source).toContain("[REDACTED]");
			expect(source).toContain("APPROVE");
			expect(source).toContain("Type the exact challenge");
			expect(source).not.toContain("--approval");
			expect(source).not.toContain('"--token"');
			expect(source).not.toContain("mcp-serve");
			expect(source).not.toContain("coordinator-mcp");
		}
		expect(typescript).toContain("ALLOWED_CONTROLS.has");
		expect(python).toContain("operation not in ALLOWED_CONTROLS");
		// the Python approval challenge must stay off stdout so a successful
		// control's stdout parses directly as JSON
		expect(python).toContain("file=sys.stderr");
		expect(python).toContain("sys.stdin.readline()");
	});

	it("executes the TypeScript inspection recipe without exposing credentials", async () => {
		const frames: Array<Record<string, unknown>> = [];
		const sdk = startSdkServer(frames);
		const repo = await endpointRepo(sdk.url, sdk.token);
		const result = await runTypeScriptTemplate(["--repo", repo, "--session-id", "session-1", "--mode", "inspect"]);
		expect(result.exitCode, result.stderr).toBe(0);
		expect(frames.map(frame => frame.query)).toEqual([
			"session.metadata",
			"context.get",
			"goal.list/get",
			"todo.list",
			"workflow.gates.list",
			"session.stats",
		]);
		expect(result.stdout).toContain('"status": "confirmed"');
		expect(result.stdout).not.toContain(sdk.token);
		expect(result.stdout).toContain('"status": "unavailable"');
		expect(result.stdout).toContain("[REDACTED]");
	});

	it("sends no control until approval matches the exact operation, session, and input", async () => {
		const frames: Array<Record<string, unknown>> = [];
		const sdk = startSdkServer(frames);
		const repo = await endpointRepo(sdk.url, sdk.token);
		const args = [
			"--repo",
			repo,
			"--session-id",
			"session-1",
			"--mode",
			"control",
			"--operation",
			"turn.prompt",
			"--input",
			'{"prompt":"hello"}',
		];
		const denied = await runTypeScriptTemplate(args, "deny");
		expect(denied.exitCode).toBe(1);
		expect(frames).toEqual([]);
		expect(denied.stderr).not.toContain(sdk.token);

		const approved = await runTypeScriptTemplate(args, "accept");
		expect(approved.exitCode, approved.stderr).toBe(0);
		expect(frames).toHaveLength(1);
		expect(frames[0]).toMatchObject({ type: "control_request", operation: "turn.prompt", input: { prompt: "hello" } });
		expect(approved.stdout).not.toContain(sdk.token);
		const acceptedChallenge = approved.stderr.match(/Approval required: (APPROVE [^\n]+)/)?.[1];
		expect(acceptedChallenge).toBeDefined();
		const replayed = await runTypeScriptTemplate(args, { reply: acceptedChallenge! });
		expect(replayed.exitCode).toBe(1);
		expect(frames).toHaveLength(1);
	}, 15_000);

	it("rejects unsupported arguments before discovery", async () => {
		const result = await runTypeScriptTemplate(["--repo", "/missing", "--token", "must-not-print"]);
		expect(result.exitCode).toBe(1);
		expect(result.stdout + result.stderr).not.toContain("must-not-print");
	});

	it("fails closed for ambiguous and non-regular discovery records", async () => {
		const frames: Array<Record<string, unknown>> = [];
		const sdk = startSdkServer(frames);
		const repo = await endpointRepo(sdk.url, sdk.token);
		const directory = path.join(repo, ".gjc", "state", "sdk");
		await Bun.write(
			path.join(directory, "session-2.json"),
			JSON.stringify({ version: 1, sessionId: "session-2", url: sdk.url, token: sdk.token, pid: process.pid, stale: false }),
		);
		const ambiguous = await runTypeScriptTemplate(["--repo", repo, "--mode", "inspect"]);
		expect(ambiguous.exitCode).toBe(1);
		expect(frames).toEqual([]);

		await fs.mkdir(path.join(directory, "bad.json"));
		const invalid = await runTypeScriptTemplate(["--repo", repo, "--session-id", "session-1", "--mode", "inspect"]);
		expect(invalid.exitCode).toBe(1);
		expect(frames).toEqual([]);

		await fs.rm(path.join(directory, "bad.json"), { recursive: true });
		const first = path.join(directory, "session-1.json");
		const firstRecord = JSON.parse(await Bun.file(first).text()) as Record<string, unknown>;
		await Bun.write(first, JSON.stringify({ ...firstRecord, sessionId: "different-session" }));
		const mismatched = await runTypeScriptTemplate(["--repo", repo, "--session-id", "session-1", "--mode", "inspect"]);
		expect(mismatched.exitCode).toBe(1);
		expect(frames).toEqual([]);
	}, 15_000);

	it("sends no control when discovery changes during approval", async () => {
		const frames: Array<Record<string, unknown>> = [];
		const sdk = startSdkServer(frames);
		const repo = await endpointRepo(sdk.url, sdk.token);
		const endpointPath = path.join(repo, ".gjc", "state", "sdk", "session-1.json");
		const result = await runTypeScriptTemplate(
			[
				"--repo",
				repo,
				"--session-id",
				"session-1",
				"--mode",
				"control",
				"--operation",
				"turn.prompt",
				"--input",
				'{"prompt":"hello"}',
			],
			"accept",
			async () => {
				const record = JSON.parse(await Bun.file(endpointPath).text()) as Record<string, unknown>;
				await Bun.write(endpointPath, JSON.stringify({ ...record, token: "replacement-token" }));
			},
		);
		expect(result.exitCode).toBe(1);
		expect(frames).toEqual([]);
	});
});
