import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { commands } from "../src/cli";
import { doctorFilesystemMemory } from "../src/memory-filesystem/doctor";
import {
	enrollFilesystemMemoryProjectIdentity,
	getFilesystemMemoryRegistryPath,
} from "../src/memory-filesystem/identity";
import {
	checkpointFilesystemMemory,
	getFilesystemMemoryRoots,
	initializeFilesystemMemory,
	resumeFilesystemMemory,
} from "../src/memory-filesystem/lifecycle";

const rootsToRemove: string[] = [];
async function fixture(): Promise<{ root: string; agentDir: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "filesystem-memory-cli-"));
	rootsToRemove.push(root);
	const agentDir = path.join(root, "agent");
	await fs.mkdir(agentDir);
	return { root, agentDir };
}
afterEach(async () => {
	await Promise.all(rootsToRemove.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function runCli(
	arguments_: string[],
	stdin?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
	const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "../src/cli.ts"), ...arguments_], {
		cwd: import.meta.dir,
		stdin: stdin ? new Blob([stdin]) : "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		stdout: await new Response(child.stdout).text(),
		stderr: await new Response(child.stderr).text(),
		exitCode: await child.exited,
	};
}

async function enrolledProject(root: string, agentDir: string): Promise<{ cwd: string; projectId: string }> {
	const cwd = path.join(root, "repository");
	const git = async (...args: string[]): Promise<string> => {
		const child = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
		if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text());
		return (await new Response(child.stdout).text()).trim();
	};
	await git("init", cwd);
	await git("-C", cwd, "config", "user.email", "test@example.test");
	await git("-C", cwd, "config", "user.name", "Test");
	await fs.writeFile(path.join(cwd, "README.md"), "fixture\n");
	await git("-C", cwd, "add", "README.md");
	await git("-C", cwd, "commit", "-m", "fixture");
	const commonDir = await fs.realpath(path.resolve(cwd, await git("-C", cwd, "rev-parse", "--git-common-dir")));
	const registry = enrollFilesystemMemoryProjectIdentity(
		{ version: 1, repositories: {} },
		commonDir,
		null,
		"2026-01-01T00:00:00.000Z",
	);
	await fs.mkdir(path.dirname(getFilesystemMemoryRegistryPath(agentDir)), { recursive: true });
	await fs.writeFile(getFilesystemMemoryRegistryPath(agentDir), JSON.stringify(registry));
	const projectId = Object.values(registry.repositories)[0]?.projectId;
	if (!projectId) throw new Error("expected enrolled project ID");
	return { cwd, projectId };
}

describe("filesystem memory CLI lifecycle and protocol", () => {
	it("registers one independent memory command advertising all ten protocol actions", async () => {
		expect(commands.filter(command => command.name === "memory")).toHaveLength(1);
		const result = await runCli(["memory", "capabilities", "--format", "json"]);
		expect(result.stderr).toBe("");
		expect(result.exitCode).toBe(0);
		const payload = JSON.parse(result.stdout) as {
			code: string;
			value: { commands: string[]; formats: string[]; deferrals: string[] };
		};
		expect(payload.code).toBe("ok");
		expect(payload.value.commands).toEqual([
			"init",
			"scopes",
			"resolve",
			"get",
			"search",
			"recall",
			"checkpoint",
			"resume",
			"doctor",
			"capabilities",
		]);
		expect(payload.value.formats).toEqual(["text", "json", "jsonl"]);
		expect(payload.value.deferrals).toContain("runtime memory backend integration");
	});

	it("rejects non-Markdown get URIs and non-MAP resolve URIs before scope access", async () => {
		const getResult = await runCli(["memory", "get", "session:///session/task.checkpoint.json", "--format", "json"]);
		expect(JSON.parse(getResult.stdout)).toMatchObject({ code: "invalid_path" });
		const resolveResult = await runCli(["memory", "resolve", "project:///MEMORY.md", "route", "--format", "json"]);
		expect(JSON.parse(resolveResult.stdout)).toMatchObject({ code: "invalid_path" });
	});

	it("initializes only explicitly selected global scope, is idempotent, and does not change runtime memory settings", async () => {
		const { agentDir } = await fixture();
		const global = path.join(agentDir, "memory-filesystem", "global");
		await fs.mkdir(global, { recursive: true });
		await fs.writeFile(path.join(global, "MEMORY.md"), "existing partial state\n");
		const initial = await initializeFilesystemMemory(["global"], process.cwd(), agentDir);
		expect(initial).toMatchObject({
			code: "ok",
			value: { roots: { global: path.join(agentDir, "memory-filesystem", "global") } },
		});
		const marker = path.join(agentDir, "memory-filesystem", "global", "initialization.v1.json");
		const first = await fs.readFile(marker, "utf8");
		expect(await initializeFilesystemMemory(["global"], process.cwd(), agentDir)).toMatchObject({ code: "ok" });
		expect(await fs.readFile(marker, "utf8")).toBe(first);
		expect(await fs.readFile(path.join(agentDir, "memory-filesystem", "global", "MEMORY.md"), "utf8")).toBe(
			"existing partial state\n",
		);
		expect(await fs.stat(path.join(agentDir, "memory-filesystem", "global", "memory.yaml"))).toBeDefined();
	});

	it("rejects symlinked registry and pre-existing scope artifacts", async () => {
		const { root, agentDir } = await fixture();
		const data = path.join(agentDir, "memory-filesystem");
		await fs.mkdir(data);
		const outsideRegistry = path.join(root, "outside-registry.json");
		await fs.writeFile(outsideRegistry, '{"version":1,"repositories":{}}');
		await fs.symlink(outsideRegistry, path.join(data, "identity-registry.v1.json"));
		expect((await getFilesystemMemoryRoots(process.cwd(), agentDir)).code).toBe("symlink_denied");
		await fs.rm(path.join(data, "identity-registry.v1.json"));
		await fs.writeFile(path.join(data, "identity-registry.v1.json"), '{"version":1}');
		expect((await getFilesystemMemoryRoots(process.cwd(), agentDir)).code).toBe("invalid_path");
		await fs.rm(path.join(data, "identity-registry.v1.json"));
		const global = path.join(data, "global");
		await fs.mkdir(global);
		const outsideMemory = path.join(root, "outside-memory.md");
		await fs.writeFile(outsideMemory, "outside");
		await fs.symlink(outsideMemory, path.join(global, "MEMORY.md"));
		expect((await initializeFilesystemMemory(["global"], process.cwd(), agentDir)).code).toBe("symlink_denied");
	});

	it("rejects repository-shared initialization through a symlinked .gjc ancestor", async () => {
		const { root, agentDir } = await fixture();
		const { cwd } = await enrolledProject(root, agentDir);
		const outside = path.join(root, "outside-project-state");
		await fs.mkdir(outside);
		await fs.symlink(outside, path.join(cwd, ".gjc"));
		expect((await initializeFilesystemMemory(["project"], cwd, agentDir)).code).toBe("symlink_denied");
		expect(await fs.readdir(outside)).toEqual([]);
	});

	it("keeps global-only initialization healthy without project enrollment", async () => {
		const { root, agentDir } = await fixture();
		expect((await initializeFilesystemMemory(["global"], root, agentDir)).code).toBe("ok");
		const roots = await getFilesystemMemoryRoots(root, agentDir);
		expect(roots.code).toBe("ok");
		if (roots.code !== "ok") throw new Error("expected global-only roots");
		expect(roots.value.availability).toEqual([
			{ scope: "global", available: true, reason: null },
			{ scope: "project", available: false, reason: "not_initialized" },
			{ scope: "project-local", available: false, reason: "not_initialized" },
			{ scope: "session", available: false, reason: "not_initialized" },
		]);
		expect(await doctorFilesystemMemory(roots.value.roots, roots.value.availability)).toEqual({
			healthy: true,
			findings: [],
		});
	});
	it("detects checkpoint digest conflicts and resumes equal-time checkpoints by descending session ID", async () => {
		const { root, agentDir } = await fixture();
		const { cwd, projectId } = await enrolledProject(root, agentDir);
		expect(
			(
				await checkpointFilesystemMemory(
					{ taskId: "before-init", sessionId: "session-a", content: "state" },
					cwd,
					agentDir,
				)
			).code,
		).toBe("not_initialized");
		expect((await initializeFilesystemMemory(["session"], cwd, agentDir)).code).toBe("ok");
		const partialRoots = await getFilesystemMemoryRoots(cwd, agentDir);
		expect(partialRoots.code).toBe("ok");
		if (partialRoots.code !== "ok") throw new Error("expected partial roots");
		expect(partialRoots.value.availability).toContainEqual({
			scope: "global",
			available: false,
			reason: "not_initialized",
		});
		expect(await doctorFilesystemMemory(partialRoots.value.roots, partialRoots.value.availability)).toEqual({
			healthy: true,
			findings: [],
		});
		const registry = await fs.readFile(getFilesystemMemoryRegistryPath(agentDir));
		await fs.rm(getFilesystemMemoryRegistryPath(agentDir));
		const lostIdentityRoots = await getFilesystemMemoryRoots(cwd, agentDir);
		expect(lostIdentityRoots).toEqual({
			code: "identity_drift",
			message: "Filesystem memory identity registry is missing for existing project data.",
		});
		await fs.writeFile(getFilesystemMemoryRegistryPath(agentDir), registry);
		const parsedRegistry = JSON.parse(registry.toString()) as { version: 1; repositories: Record<string, unknown> };
		await fs.writeFile(
			getFilesystemMemoryRegistryPath(agentDir),
			JSON.stringify({ ...parsedRegistry, repositories: {} }),
		);
		expect(await getFilesystemMemoryRoots(cwd, agentDir)).toEqual({
			code: "identity_drift",
			message: "Filesystem memory project data is orphaned from the identity registry.",
		});
		await fs.writeFile(getFilesystemMemoryRegistryPath(agentDir), registry);
		const first = await checkpointFilesystemMemory(
			{ taskId: "task", sessionId: "session-a", content: "first" },
			cwd,
			agentDir,
		);
		expect(first.code).toBe("ok");
		if (first.code !== "ok") throw new Error("expected checkpoint");
		expect(
			(
				await checkpointFilesystemMemory(
					{ taskId: "task", sessionId: "session-a", content: "replacement" },
					cwd,
					agentDir,
				)
			).code,
		).toBe("topology_changed");
		const concurrent = await Promise.all([
			checkpointFilesystemMemory({ taskId: "race", sessionId: "session-race", content: "one" }, cwd, agentDir),
			checkpointFilesystemMemory({ taskId: "race", sessionId: "session-race", content: "two" }, cwd, agentDir),
		]);
		expect(concurrent.filter(result => result.code === "ok")).toHaveLength(1);
		expect(concurrent.some(result => result.code === "topology_changed")).toBe(true);
		const sessionsRoot = path.join(agentDir, "memory-filesystem", "projects", projectId, "sessions");
		const outsideSession = path.join(root, "outside-session");
		await fs.mkdir(outsideSession);
		await fs.symlink(outsideSession, path.join(sessionsRoot, "session-link"));
		expect(
			(
				await checkpointFilesystemMemory(
					{ taskId: "linked", sessionId: "session-link", content: "must-not-write-outside" },
					cwd,
					agentDir,
				)
			).code,
		).toBe("symlink_denied");
		const sessions = sessionsRoot;
		for (const session of ["session-a", "session-b"]) {
			await fs.mkdir(path.join(sessions, session), { recursive: true });
			await fs.writeFile(
				path.join(sessions, session, "task.checkpoint.json"),
				JSON.stringify({
					version: 1,
					taskId: "task",
					createdAt: "2026-01-01T00:00:00.000Z",
					content: session,
					expectedDigest: null,
				}),
			);
		}
		const resumed = await resumeFilesystemMemory("task", cwd, agentDir);
		expect(resumed).toMatchObject({
			code: "ok",
			value: { uri: "session:///session-b/task.checkpoint.json", verificationRequired: true },
		});
	});

	it("fails closed when a checkpoint candidate becomes a symlink", async () => {
		const { root, agentDir } = await fixture();
		const { cwd, projectId } = await enrolledProject(root, agentDir);
		expect((await initializeFilesystemMemory(["session"], cwd, agentDir)).code).toBe("ok");
		const sessions = path.join(agentDir, "memory-filesystem", "projects", projectId, "sessions");
		const session = path.join(sessions, "session-a");
		await fs.mkdir(session);
		const outside = path.join(root, "outside-checkpoint.json");
		await fs.writeFile(
			outside,
			JSON.stringify({
				version: 1,
				taskId: "linked",
				createdAt: "2026-01-01T00:00:00.000Z",
				content: "outside",
				expectedDigest: null,
			}),
		);
		await fs.symlink(outside, path.join(session, "linked.checkpoint.json"));
		expect((await resumeFilesystemMemory("linked", cwd, agentDir)).code).toBe("symlink_denied");
	});

	it("keeps JSONL stdout record-pure and emits an outcome for malformed checkpoint input", async () => {
		const result = await runCli(
			["memory", "checkpoint", "--format", "jsonl"],
			'{"taskId":"valid","sessionId":"session","content":"state"}\nnot-json\n',
		);
		expect(result.stderr).toBe("");
		const records = result.stdout
			.trim()
			.split("\n")
			.map(line => JSON.parse(line) as { code: string });
		expect(records).toHaveLength(2);
		expect(records[1]?.code).toBe("invalid_path");
		expect(result.exitCode).toBe(2);
	});

	it("rejects a symlinked existing checkpoint during replacement", async () => {
		const { root, agentDir } = await fixture();
		const { cwd, projectId } = await enrolledProject(root, agentDir);
		expect((await initializeFilesystemMemory(["session"], cwd, agentDir)).code).toBe("ok");
		const session = path.join(agentDir, "memory-filesystem", "projects", projectId, "sessions", "session-a");
		await fs.mkdir(session);
		const outside = path.join(root, "outside-existing-checkpoint.json");
		await fs.writeFile(outside, "outside");
		await fs.symlink(outside, path.join(session, "task.checkpoint.json"));
		expect(
			(
				await checkpointFilesystemMemory(
					{ taskId: "task", sessionId: "session-a", content: "replacement" },
					cwd,
					agentDir,
				)
			).code,
		).toBe("symlink_denied");
	});

	it("exposes only initialized scopes and applies user and repository policy narrowing", async () => {
		const { root, agentDir } = await fixture();
		const { cwd } = await enrolledProject(root, agentDir);
		expect((await initializeFilesystemMemory(["global", "project"], cwd, agentDir)).code).toBe("ok");
		const initialized = await getFilesystemMemoryRoots(cwd, agentDir);
		expect(initialized).toMatchObject({
			code: "ok",
			value: { roots: { global: expect.any(String), project: expect.any(String) } },
		});
		if (initialized.code !== "ok") throw new Error("expected initialized roots");
		expect(initialized.value.roots.session).toBeUndefined();
		await fs.writeFile(
			path.join(agentDir, "memory-filesystem", "policy.v1.json"),
			JSON.stringify({ version: 1, allowedScopes: ["global"] }),
		);
		const userDenied = await getFilesystemMemoryRoots(cwd, agentDir);
		expect(userDenied).toMatchObject({ code: "ok", value: { roots: { global: expect.any(String) } } });
		if (userDenied.code !== "ok") throw new Error("expected roots");
		expect(userDenied.value.roots.project).toBeUndefined();
		expect(userDenied.value.availability).toContainEqual({
			scope: "project",
			available: false,
			reason: "policy_denied",
		});
		await fs.writeFile(
			path.join(agentDir, "memory-filesystem", "policy.v1.json"),
			JSON.stringify({ version: 1, allowedScopes: ["global", "project"] }),
		);
		await fs.writeFile(
			path.join(cwd, ".gjc", "memory", "policy.v1.json"),
			JSON.stringify({ version: 1, allowedScopes: ["global"] }),
		);
		const repositoryDenied = await getFilesystemMemoryRoots(cwd, agentDir);
		expect(repositoryDenied).toMatchObject({ code: "ok", value: { roots: { global: expect.any(String) } } });
		if (repositoryDenied.code !== "ok") throw new Error("expected roots");
		expect(repositoryDenied.value.roots.project).toBeUndefined();
		expect(repositoryDenied.value.availability).toContainEqual({
			scope: "project",
			available: false,
			reason: "policy_denied",
		});
	});

	it("fails closed for future policy and initialization marker versions", async () => {
		const { agentDir } = await fixture();
		expect((await initializeFilesystemMemory(["global"], process.cwd(), agentDir)).code).toBe("ok");
		await fs.writeFile(
			path.join(agentDir, "memory-filesystem", "policy.v1.json"),
			'{"version":2,"allowedScopes":["global"]}\n',
		);
		const futurePolicy = await getFilesystemMemoryRoots(process.cwd(), agentDir);
		expect(futurePolicy).toMatchObject({ code: "ok", value: { roots: {} } });
		if (futurePolicy.code !== "ok") throw new Error("expected availability");
		expect(futurePolicy.value.availability).toContainEqual({
			scope: "global",
			available: false,
			reason: "unknown_version",
		});
		await fs.writeFile(
			path.join(agentDir, "memory-filesystem", "policy.v1.json"),
			'{"version":1,"allowedScopes":["global"]}\n',
		);
		await fs.writeFile(
			path.join(agentDir, "memory-filesystem", "global", "initialization.v1.json"),
			'{"version":2,"scopes":["global"]}\n',
		);
		expect((await getFilesystemMemoryRoots(process.cwd(), agentDir)).code).toBe("unknown_version");
	});

	it("fails closed rather than silently accepting a future initialization marker", async () => {
		const { agentDir } = await fixture();
		const global = path.join(agentDir, "memory-filesystem", "global");
		await fs.mkdir(global, { recursive: true });
		await fs.writeFile(path.join(global, "initialization.v1.json"), '{"version":2,"scopes":["global"]}\n');
		expect((await initializeFilesystemMemory(["global"], process.cwd(), agentDir)).code).toBe("unknown_version");
	});
});
