import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { confineSandboxProfile, sandboxedShellCommand } from "../src/tools/confine-sandbox";

describe("--confine shell sandbox", () => {
	it("quotes a root containing spaces in the sandbox profile", () => {
		expect(confineSandboxProfile(path.join(os.tmpdir(), "My Project"))).toContain("My Project");
	});
	it("accepts a Korean directory name in the sandbox profile", () => {
		const root = path.join(os.tmpdir(), "프로젝트");
		expect(confineSandboxProfile(root)).toContain("프로젝트");
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
});
