import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Snowflake } from "@gajae-code/utils";
import * as git from "../../src/utils/git";

const tempDirs: string[] = [];
const plantedLinks: string[] = [];

function canSymlink(): boolean {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-git-patch-link-probe-"));
	const target = path.join(dir, "target");
	const link = path.join(dir, "link");
	fs.writeFileSync(target, "x");
	try {
		fs.symlinkSync(target, link);
		return fs.lstatSync(link).isSymbolicLink();
	} catch {
		return false;
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

const symlinkOk = canSymlink();

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	for (const link of plantedLinks.splice(0)) {
		try {
			if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
		} catch {
			// The writer may already have removed the planted link.
		}
	}
});

function makeDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-git-patch-temp-"));
	tempDirs.push(dir);
	return dir;
}

async function gitCmd(cwd: string, args: string[]): Promise<void> {
	const child = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe" });
	const code = await child.exited;
	if (code !== 0) {
		const stderr = await new Response(child.stderr).text();
		throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
	}
}

async function initRepo(dir: string): Promise<void> {
	await gitCmd(dir, ["init", "-q", "-b", "main"]);
	await gitCmd(dir, ["config", "user.email", "a@b"]);
	await gitCmd(dir, ["config", "user.name", "t"]);
	fs.writeFileSync(path.join(dir, "hello.txt"), "hello\n");
	await gitCmd(dir, ["add", "hello.txt"]);
	await gitCmd(dir, ["commit", "-qm", "init"]);
}

const helloPatch = `diff --git a/hello.txt b/hello.txt
--- a/hello.txt
+++ b/hello.txt
@@ -1 +1 @@
-hello
+hello world
`;

describe("git patch temp file", () => {
	it("still treats blank patch text as a no-op", async () => {
		const dir = makeDir();
		expect(await git.patch.canApplyText(dir, " \n\t")).toBe(true);
		await git.patch.applyText(dir, " \n");
	});

	it("still applies a patch when no temp symlink is planted", async () => {
		const dir = makeDir();
		await initRepo(dir);
		expect(await git.patch.canApplyText(dir, helloPatch)).toBe(true);
		await git.patch.applyText(dir, helloPatch);
		expect(fs.readFileSync(path.join(dir, "hello.txt"), "utf8")).toBe("hello world\n");
	});

	if (!symlinkOk) {
		it.skip("does not follow a preexisting symlink at the predictable temp name", () => {});
	}
	if (symlinkOk)
		it("does not follow a preexisting symlink at the predictable temp name", async () => {
			const dir = makeDir();
			const victim = path.join(dir, "victim");
			fs.writeFileSync(victim, "SAFE");
			const now = Date.now;
			const fixed = 1_700_000_000_000;
			Date.now = () => fixed;
			try {
				const observed = Snowflake.next();
				const nextSeq = (Snowflake.getSequence(observed) + 1) & Snowflake.MAX_SEQUENCE;
				const id = Snowflake.formatParts(fixed - Snowflake.EPOCH_TIMESTAMP, nextSeq);
				const linkPath = path.join(os.tmpdir(), `gjc-git-patch-${id}.patch`);
				plantedLinks.push(linkPath);
				try {
					fs.unlinkSync(linkPath);
				} catch {
					// No prior file at the predicted name.
				}
				fs.symlinkSync(victim, linkPath);
				const applied = await git.patch.canApplyText(dir, "PATCH-CONTENT-VIA-SYMLINK\n");
				expect(applied).toBe(false);
				expect(fs.readFileSync(victim, "utf8")).toBe("SAFE");
				expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
			} finally {
				Date.now = now;
			}
		});
});
