import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Ownership receipts next to the managed links (#5990): they must survive a reboot that changes the
// volume's st_dev, and a receipt left behind by a hand-removed link must not block relinking.

const tempRoots: string[] = [];
const SMOKE = '#!/bin/sh\nif [ "$1" = "--smoke-test" ]; then echo "smoke-test: ok"; fi\n';

afterEach(async () => {
	for (const root of tempRoots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function makeExecutable(file: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await Bun.write(file, content);
	await fs.chmod(file, 0o755);
}

/** A throwaway checkout with this dev-link script, a smoke-passing source, and an isolated link dir. */
async function fixtureCheckout(): Promise<{ root: string; script: string; targetDir: string }> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-dev-link-receipt-")));
	tempRoots.push(root);
	const script = path.join(root, "scripts", "dev-link.ts");
	await fs.mkdir(path.dirname(script), { recursive: true });
	await Bun.write(script, Bun.file(path.join(import.meta.dir, "dev-link.ts")));
	await Bun.write(path.join(root, "scripts", "worktree-deps.ts"), Bun.file(path.join(import.meta.dir, "worktree-deps.ts")));
	await makeExecutable(path.join(root, "packages", "coding-agent", "src", "cli.ts"), SMOKE);
	return { root, script, targetDir: path.join(root, "managed-bin") };
}

function runLink(fixture: { root: string; script: string; targetDir: string }) {
	const result = Bun.spawnSync([process.execPath, fixture.script], {
		cwd: fixture.root,
		env: { ...process.env, GJC_DEV_LINK_DIR: fixture.targetDir, PATH: fixture.targetDir },
		stderr: "pipe",
		stdout: "pipe",
	});
	return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

/** Rewrites a receipt with a different recorded st_dev and a matching digest, as a pre-reboot receipt reads after the volume id moved. */
async function simulateVolumeIdDrift(receiptFile: string): Promise<void> {
	const { auth: _auth, ...body } = JSON.parse(await fs.readFile(receiptFile, "utf8"));
	body.identity = { ...body.identity, dev: String(Number(body.identity.dev) + 1) };
	const auth = createHash("sha256").update(JSON.stringify(body)).digest("hex");
	await fs.writeFile(receiptFile, `${JSON.stringify({ ...body, auth })}\n`);
}

describe.skipIf(process.platform === "win32")("dev:link ownership receipts (#5990)", () => {
	test("#given our links whose receipts recorded a different st_dev #when relinking #then they are still recognized and replaced", async () => {
		// given
		const fixture = await fixtureCheckout();
		expect(runLink(fixture).exitCode).toBe(0);
		await simulateVolumeIdDrift(path.join(fixture.targetDir, "gjc.gjc-managed.json"));
		await simulateVolumeIdDrift(path.join(fixture.targetDir, "가재씨.gjc-managed.json"));

		// when
		const result = runLink(fixture);

		// then
		expect(result.stderr).not.toContain("Refusing");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(`Linked ${path.join(fixture.targetDir, "gjc")}`);
	});

	test("#given a hand-removed link whose receipt names this checkout #when relinking #then the orphan receipt is replaced", async () => {
		// given
		const fixture = await fixtureCheckout();
		expect(runLink(fixture).exitCode).toBe(0);
		await fs.rm(path.join(fixture.targetDir, "가재씨"));

		// when
		const result = runLink(fixture);

		// then
		expect(result.stderr).not.toContain("Refusing");
		expect(result.exitCode).toBe(0);
		const receipt = JSON.parse(await fs.readFile(path.join(fixture.targetDir, "가재씨.gjc-managed.json"), "utf8"));
		const link = await fs.lstat(path.join(fixture.targetDir, "가재씨"));
		expect(receipt.identity.ino).toBe(String(link.ino));
	});

	test("#given an orphan receipt that names another checkout #when relinking #then it is refused before either link changes", async () => {
		// given
		const fixture = await fixtureCheckout();
		await fs.mkdir(fixture.targetDir, { recursive: true });
		const body = {
			version: 1,
			alias: "가재씨",
			target: path.join(fixture.targetDir, "가재씨"),
			root: "/some/other/checkout",
			source: "/some/other/checkout/packages/coding-agent/src/cli.ts",
			parent: fixture.targetDir,
			identity: { dev: "1", ino: "2" },
		};
		const auth = createHash("sha256").update(JSON.stringify(body)).digest("hex");
		await fs.writeFile(path.join(fixture.targetDir, "가재씨.gjc-managed.json"), `${JSON.stringify({ ...body, auth })}\n`);

		// when
		const result = runLink(fixture);

		// then
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("Refusing");
		expect(await Bun.file(path.join(fixture.targetDir, "gjc")).exists()).toBe(false);
	});

	test("#given our link replaced by a different file at the same path #when relinking #then the receipt no longer vouches for it", async () => {
		// given
		const fixture = await fixtureCheckout();
		expect(runLink(fixture).exitCode).toBe(0);
		const alias = path.join(fixture.targetDir, "가재씨");
		// Move the original aside instead of deleting it: while it stays allocated, the filesystem
		// cannot hand its inode to the replacement, so the replacement is guaranteed a new identity.
		await fs.rename(alias, `${alias}.original`);
		await fs.symlink(path.join(fixture.root, "packages", "coding-agent", "src", "cli.ts"), alias);
		const receipt = JSON.parse(await fs.readFile(`${alias}.gjc-managed.json`, "utf8"));
		expect(receipt.identity.ino).not.toBe(String((await fs.lstat(alias)).ino));

		// when
		const result = runLink(fixture);

		// then
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain(`Refusing to replace foreign or unknown ${alias}`);
	});
});
