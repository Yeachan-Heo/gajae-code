import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEmbeddedCompiledModule } from "@gajae-code/utils/env";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

test("embedded compiled detection ignores PI_COMPILED", () => {
	const prior = process.env.PI_COMPILED;
	process.env.PI_COMPILED = "true";
	try {
		expect(isEmbeddedCompiledModule(import.meta.url)).toBe(false);
		expect(isEmbeddedCompiledModule("file:///$bunfs/root/publication-liveness-watchdog.ts")).toBe(true);
		expect(isEmbeddedCompiledModule("file:///tmp/%7EBUN/publication-liveness-watchdog.ts")).toBe(true);
	} finally {
		if (prior === undefined) delete process.env.PI_COMPILED;
		else process.env.PI_COMPILED = prior;
	}
});

test("source mode does not load the publication watchdog worker from the project root", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-liveness-source-"));
	roots.push(root);
	const decoyDir = path.join(root, "packages", "coding-agent", "src", "sdk", "broker");
	const home = path.join(root, "home");
	const sentinel = path.join(root, "hostile-executed");
	await fs.mkdir(decoyDir, { recursive: true });
	await fs.mkdir(home, { recursive: true });
	await Bun.write(
		path.join(decoyDir, "publication-liveness-watchdog-worker.ts"),
		[
			'import * as fs from "node:fs";',
			"const sentinel = process.env.HOSTILE_SENTINEL;",
			'if (sentinel) fs.writeFileSync(sentinel, "executed");',
			'throw new Error("hostile publication liveness worker");',
			"",
		].join("\n"),
	);
	const childPath = path.join(import.meta.dir, "publication-liveness-worker-source-child.ts");
	const child = Bun.spawn([process.execPath, "--no-env-file", childPath], {
		cwd: root,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			HOME: home,
			GJC_CODING_AGENT_DIR: path.join(root, "agent"),
			GJC_BROKER_LIVENESS_HARD_EXIT: "1",
			HOSTILE_SENTINEL: sentinel,
			PI_COMPILED: "true",
		},
	});
	const finished = await Promise.race([child.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
	if (!finished) child.kill("SIGKILL");
	const stdout = await new Response(child.stdout).text();
	const stderr = await new Response(child.stderr).text();
	expect(finished, stderr).toBe(true);
	expect(child.exitCode, `${stderr}\n${stdout}`).toBe(0);
	expect(stdout, stderr).toContain("armed");
	expect(await Bun.file(sentinel).exists()).toBe(false);
}, 15_000);
