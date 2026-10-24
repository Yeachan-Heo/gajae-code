import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import fc from "fast-check";
import { confineSandboxProfile, sandboxedShellCommand } from "../src/tools/confine-sandbox";
import {
	directoryEscapesWorkspace,
	openFileInsideWorkspace,
	pathEscapesWorkspace,
	readFileInsideWorkspace,
	realpathEscapesWorkspace,
} from "../src/tools/workspace-confine";

describe("--confine path boundary", () => {
	it("accepts the root and a descendant, and rejects a parent", () => {
		const root = path.join(os.tmpdir(), "confine-root");
		expect(pathEscapesWorkspace(root, root)).toBe(false);
		expect(pathEscapesWorkspace(root, path.join(root, "src", "file.ts"))).toBe(false);
		expect(pathEscapesWorkspace(root, path.resolve(root, "..", "secret"))).toBe(true);
		expect(pathEscapesWorkspace(root, path.resolve(root, ".."))).toBe(true);
	});

	it("accepts a root containing spaces and rejects its parent", () => {
		const root = path.join(os.tmpdir(), "My Project");
		expect(pathEscapesWorkspace(root, path.join(root, "src"))).toBe(false);
		expect(pathEscapesWorkspace(root, path.resolve(root, ".."))).toBe(true);
		expect(confineSandboxProfile(root)).toContain("My Project");
	});

	it("accepts a Korean directory name in the sandbox profile", () => {
		const root = path.join(os.tmpdir(), "프로젝트");
		expect(confineSandboxProfile(root)).toContain("프로젝트");
	});

	it("rejects a dangling symlink whose target is outside the root", async () => {
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "confine-dangling-"));
		const root = path.join(parent, "repo");
		const outside = path.join(parent, "outside-missing.txt");
		const linked = path.join(root, "link");
		await fs.mkdir(root);
		await fs.symlink(outside, linked);
		await expect(realpathEscapesWorkspace(root, linked)).resolves.toBe(true);
		await fs.rm(parent, { recursive: true, force: true });
	});
	it("admits the root and descendants, and rejects parents and sibling prefixes", () => {
		const root = path.join(os.tmpdir(), "confine-root");
		const cases = ["", "a", "a/b", "a/b/c", ".hidden", "name with space"];
		for (const relative of cases) {
			expect(pathEscapesWorkspace(root, relative ? path.join(root, relative) : root)).toBe(false);
		}
		expect(pathEscapesWorkspace(root, path.resolve(root, ".."))).toBe(true);
		expect(pathEscapesWorkspace(root, path.resolve(root, "..", "secret"))).toBe(true);
		expect(pathEscapesWorkspace(root, `${root}-sibling`)).toBe(true);
		expect(pathEscapesWorkspace(root, `${root}-sibling/file`)).toBe(true);
	});

	it("generates containment cases for descendants, dot segments, parents, and sibling prefixes", () => {
		const segment = fc
			.stringMatching(/^[A-Za-z0-9가-힣 ._-]{1,12}$/)
			.filter(value => value !== "." && value !== "..");
		fc.assert(
			fc.property(
				fc.array(segment, { minLength: 1, maxLength: 3 }),
				fc.array(segment, { maxLength: 3 }),
				(rootParts, relativeParts) => {
					const root = path.join(os.tmpdir(), ...rootParts);
					const descendant = path.resolve(root, ...relativeParts);
					expect(pathEscapesWorkspace(root, descendant)).toBe(false);
					expect(pathEscapesWorkspace(root, path.resolve(root, ".."))).toBe(true);
					expect(pathEscapesWorkspace(root, `${root}-sibling`)).toBe(true);
				},
			),
		);
	});
	it("follows the real directory when checking a shell cwd", async () => {
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "confine-cwd-"));
		const root = path.join(parent, "repo");
		const outside = path.join(parent, "outside");
		const linked = path.join(root, "link");
		await fs.mkdir(root);
		await fs.mkdir(outside);
		await fs.symlink(outside, linked);
		await expect(directoryEscapesWorkspace(root, root)).resolves.toBe(false);
		await expect(directoryEscapesWorkspace(root, outside)).resolves.toBe(true);
		await expect(directoryEscapesWorkspace(root, linked)).resolves.toBe(true);
		await fs.rm(parent, { recursive: true, force: true });
	});
	it("rejects an in-root symlink and a new file below it when they resolve outside", async () => {
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "confine-realpath-"));
		const root = path.join(parent, "repo");
		const outside = path.join(parent, "outside");
		const linked = path.join(root, "link");
		await fs.mkdir(root);
		await fs.mkdir(outside);
		await fs.writeFile(path.join(outside, "secret.txt"), "hidden");
		await fs.symlink(outside, linked);
		await expect(realpathEscapesWorkspace(root, path.join(linked, "secret.txt"))).resolves.toBe(true);
		await expect(realpathEscapesWorkspace(root, path.join(linked, "new.txt"))).resolves.toBe(true);
		await expect(realpathEscapesWorkspace(root, path.join(root, "visible.txt"))).resolves.toBe(false);
		await fs.rm(parent, { recursive: true, force: true });
	});
	it("denies a parent path, a dotdot path, and a symlink from inside the sandboxed process", async () => {
		if (process.platform !== "darwin") return;
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "confine-sandbox-"));
		const root = path.join(parent, "repo");
		const outside = path.join(os.homedir(), `.gjc-confine-secret-${process.pid}`);
		await fs.mkdir(root);
		await fs.writeFile(outside, "hidden");
		try {
			await fs.writeFile(path.join(root, "visible.txt"), "visible");
			await fs.symlink(outside, path.join(root, "link"));
			const command = sandboxedShellCommand(
				[
					`cat ${JSON.stringify(path.join(root, "visible.txt"))}`,
					`cat ${JSON.stringify(outside)}`,
					`cat ${JSON.stringify(path.join(root, "link"))}`,
				].join("; "),
				root,
			);
			const proc = Bun.spawn(["/bin/sh", "-c", command], { cwd: root, stdout: "pipe", stderr: "pipe" });
			const [stdout, stderr] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			expect(stdout).toContain("visible");
			expect(stdout).not.toContain("hidden");
			expect(stderr).toContain("Operation not permitted");
		} finally {
			await fs.rm(outside, { force: true });
			await fs.rm(parent, { recursive: true, force: true });
		}
	});
	it("denies a sibling under the same temp prefix from inside the sandboxed process", async () => {
		if (process.platform !== "darwin") return;
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "confine-sibling-"));
		const root = path.join(parent, "repo");
		const sibling = path.join(parent, "secret.txt");
		await fs.mkdir(root);
		await fs.writeFile(sibling, "hidden");
		await fs.writeFile(path.join(root, "visible.txt"), "visible");
		try {
			const command = sandboxedShellCommand(
				`cat ${JSON.stringify(path.join(root, "visible.txt"))}; cat ${JSON.stringify(sibling)}`,
				root,
			);
			const proc = Bun.spawn(["/bin/sh", "-c", command], { cwd: root, stdout: "pipe", stderr: "pipe" });
			const [stdout, stderr] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			expect(stdout).toContain("visible");
			expect(stdout).not.toContain("hidden");
			expect(stderr).toContain("Operation not permitted");
		} finally {
			await fs.rm(parent, { recursive: true, force: true });
		}
	});
	it("denies a relative parent write when the root is under the system temp directory", async () => {
		if (process.platform !== "darwin") return;
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "confine-tmp-parent-"));
		const root = path.join(parent, "repo");
		const secret = path.join(parent, "secret.txt");
		await fs.mkdir(root);
		await fs.writeFile(secret, "hidden");
		try {
			const command = sandboxedShellCommand(
				`echo OVERWRITE > ${JSON.stringify(path.join("..", "secret.txt"))}`,
				root,
			);
			const proc = Bun.spawn(["/bin/sh", "-c", command], { cwd: root, stdout: "pipe", stderr: "pipe" });
			await proc.exited;
			expect(await fs.readFile(secret, "utf8")).toBe("hidden");
		} finally {
			await fs.rm(parent, { recursive: true, force: true });
		}
	});
	it("pins the Seatbelt launcher to the trusted absolute executable", () => {
		if (process.platform !== "darwin") return;
		expect(sandboxedShellCommand("printf ok", os.tmpdir())).toContain("/usr/bin/sandbox-exec");
	});
	it("opens a file inside the root and rejects a swapped in-root symlink", async () => {
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "confine-open-"));
		const root = path.join(parent, "repo");
		const outside = path.join(parent, "outside.txt");
		const linked = path.join(root, "link");
		await fs.mkdir(root);
		await fs.writeFile(path.join(root, "visible.txt"), "visible");
		await fs.writeFile(outside, "hidden");
		await fs.symlink(outside, linked);
		const visible = await openFileInsideWorkspace(root, path.join(root, "visible.txt"));
		expect(await visible.readFile("utf8")).toBe("visible");
		await visible.close();
		await expect(openFileInsideWorkspace(root, linked)).rejects.toThrow(/outside/);
		await expect(readFileInsideWorkspace(root, linked)).rejects.toThrow(/outside/);
		expect(await readFileInsideWorkspace(root, path.join(root, "visible.txt"))).toEqual(Buffer.from("visible"));
		await fs.rm(parent, { recursive: true, force: true });
	});
});
