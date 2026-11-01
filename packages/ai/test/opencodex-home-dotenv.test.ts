import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * `fetchOpenCodexModels` reads `runtime-port.json` from `OPENCODEX_HOME`.
 * The project snapshot is fixed at load from `process.cwd()`, so each case is a child.
 */

const PROBE = path.join(import.meta.dir, "fixtures", "opencodex-home-dotenv-probe.ts");
const HOME = "OPENCODEX_HOME";

interface Probe {
	baseUrl: string | null;
	modelId: string | null;
	parentHome: string | null;
	grandchildHome: string;
	inheritedHome: string;
	copiedHome: string;
	nodeHome: string;
	projectSyncHome: string;
	projectAsyncHome: string;
	projectPassedHome: string;
	projectCopiedHome: string;
	projectArrayHome: string;
	secondSyncHome: string;
	secondArrayHome: string;
	secondAsyncHome: string;
	secondAsyncArrayHome: string;
}

const tempDirs: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];

function projectDir(dotenv?: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-opencodex-home-"));
	tempDirs.push(dir);
	if (dotenv !== undefined) fs.writeFileSync(path.join(dir, ".env"), dotenv);
	return dir;
}

function runtimeHome(port: number): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-opencodex-runtime-"));
	tempDirs.push(dir);
	fs.writeFileSync(path.join(dir, "runtime-port.json"), JSON.stringify({ hostname: "127.0.0.1", port }));
	return dir;
}

function listen(): { port: number; hits: string[] } {
	const hits: string[] = [];
	const server: ReturnType<typeof Bun.serve> = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req: Request): Response {
			const pathname = new URL(req.url).pathname;
			hits.push(pathname);
			const bound = server.port ?? 0;
			if (pathname === "/healthz") return Response.json({ ok: true, version: "opencodex", port: bound });
			if (pathname === "/v1/models") return Response.json({ data: [{ id: "local-model" }] });
			return new Response("no", { status: 404 });
		},
	});
	servers.push(server);
	return { port: server.port ?? 0, hits };
}

afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function expectProjectHome(probe: Probe, home: string) {
	expect(probe.projectSyncHome).toBe(home);
	expect(probe.projectAsyncHome).toBe(home);
	expect(probe.projectPassedHome).toBe(home);
	expect(probe.projectCopiedHome).toBe(home);
	expect(probe.projectArrayHome).toBe(home);
}

function spawnEnv(overrides: Record<string, string> = {}): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && key !== HOME) env[key] = value;
	}
	Object.assign(env, overrides);
	return env;
}

async function discover(cwd: string, overrides: Record<string, string> = {}): Promise<Probe> {
	const proc = Bun.spawn([process.execPath, PROBE], {
		cwd,
		env: spawnEnv(overrides),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr}`);
	return JSON.parse(stdout.trim()) as Probe;
}

describe("OpenCodex home provenance", () => {
	test("ignores a project dotenv OpenCodex home", async () => {
		const { port, hits } = listen();
		const home = runtimeHome(port);
		const probe = await discover(projectDir(`${HOME}=${home}\n`));
		expect(hits).toEqual([]);
		expect(probe.baseUrl ?? "").not.toContain(`:${port}`);
		expect(probe.parentHome).toBeNull();
		expect(probe.grandchildHome).toBe("");
		expect(probe.inheritedHome).toBe("");
		expect(probe.copiedHome).toBe("");
		expect(probe.nodeHome).toBe("");
		expectProjectHome(probe, "");
	});

	test("still uses an inherited OpenCodex home when the project dotenv names another directory", async () => {
		const { port, hits } = listen();
		const trusted = runtimeHome(port);
		const other = runtimeHome(port + 1);
		const probe = await discover(projectDir(`${HOME}=${other}\n`), { [HOME]: trusted });
		expect(hits).toContain("/healthz");
		expect(probe.baseUrl).toBe(`http://127.0.0.1:${port}/v1`);
		expect(probe.modelId).toBe("opencodex/local-model");
		expect(probe.parentHome).toBe(trusted);
		expect(probe.grandchildHome).toBe(trusted);
		expect(probe.inheritedHome).toBe(trusted);
		expect(probe.copiedHome).toBe(trusted);
		expect(probe.nodeHome).toBe(trusted);
		expectProjectHome(probe, trusted);
	});

	test("still uses an inherited OpenCodex home when the project has no dotenv entry", async () => {
		const { port, hits } = listen();
		const trusted = runtimeHome(port);
		const probe = await discover(projectDir(), { [HOME]: trusted });
		expect(hits).toContain("/healthz");
		expect(probe.baseUrl).toBe(`http://127.0.0.1:${port}/v1`);
		expect(probe.parentHome).toBe(trusted);
		expect(probe.grandchildHome).toBe(trusted);
		expect(probe.inheritedHome).toBe(trusted);
		expect(probe.copiedHome).toBe(trusted);
		expect(probe.nodeHome).toBe(trusted);
		expectProjectHome(probe, trusted);
	});

	test("ignores an OpenCodex home that repeats the project dotenv", async () => {
		const { port, hits } = listen();
		const home = runtimeHome(port);
		const probe = await discover(projectDir(`${HOME}=${home}\n`), { [HOME]: home });
		expect(hits).toEqual([]);
		expect(probe.baseUrl ?? "").not.toContain(`:${port}`);
		expect(probe.parentHome).toBeNull();
		expect(probe.inheritedHome).toBe("");
		expect(probe.copiedHome).toBe("");
		expect(probe.grandchildHome).toBe("");
		expect(probe.nodeHome).toBe("");
		expectProjectHome(probe, "");
	});

	test("ignores a shell OpenCodex home when the project dotenv expands a variable", async () => {
		const { port, hits } = listen();
		const trusted = runtimeHome(port);
		const planted = `${String.fromCharCode(36)}{OPENCODEX_HOME_PLANTED}`;
		const probe = await discover(projectDir(`${HOME}=${planted}\n`), { [HOME]: trusted });
		expect(hits).toEqual([]);
		expect(probe.baseUrl ?? "").not.toContain(`:${port}`);
		expect(probe.parentHome).toBeNull();
		expect(probe.inheritedHome).toBe("");
		expect(probe.copiedHome).toBe("");
		expect(probe.grandchildHome).toBe("");
		expect(probe.nodeHome).toBe("");
		expectProjectHome(probe, "");
	});

	test("ignores two successive rejected OpenCodex homes in a later Bun child", async () => {
		const planted = `${String.fromCharCode(36)}{OPENCODEX_HOME_PLANTED}`;
		const first = "/rejected-one";
		const second = "/rejected-two";
		const probe = await discover(projectDir(`${HOME}=${planted}\n`), {
			[HOME]: first,
			OPENCODEX_HOME_SECOND: second,
		});
		expect(probe.parentHome).toBeNull();
		for (const home of [
			probe.secondSyncHome,
			probe.secondArrayHome,
			probe.secondAsyncHome,
			probe.secondAsyncArrayHome,
		]) {
			expect(home).toBe("");
			expect(home).not.toBe(first);
			expect(home).not.toBe(second);
		}
	});
});
