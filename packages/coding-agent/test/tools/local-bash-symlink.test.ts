import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expandInternalUrls } from "../../src/tools/bash-skill-urls";

describe("expandInternalUrls local://", () => {
	it("does not expand a symlink that leaves the session local root", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "local-bash-"));
		const artifacts = path.join(root, "artifacts");
		const localRoot = path.join(artifacts, "local");
		await mkdir(localRoot, { recursive: true });
		const secret = path.join(root, "secret.txt");
		await writeFile(secret, "secret");
		await symlink(secret, path.join(localRoot, "leak.txt"));
		await expect(
			expandInternalUrls("cat local://leak.txt", {
				skills: [],
				localOptions: {
					getArtifactsDir: () => artifacts,
					getSessionId: () => "session",
				},
			}),
		).rejects.toThrow(/escapes the session local root/);
		await rm(root, { recursive: true, force: true });
	});

	it("rejects a dangling symlink and a new file under a symlinked directory", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "local-bash-"));
		const artifacts = path.join(root, "artifacts");
		const localRoot = path.join(artifacts, "local");
		const outside = path.join(root, "outside");
		await mkdir(localRoot, { recursive: true });
		await mkdir(outside, { recursive: true });
		await symlink(path.join(outside, "new.txt"), path.join(localRoot, "dangling.txt"));
		await symlink(outside, path.join(localRoot, "dirlink"));
		const options = {
			skills: [],
			localOptions: {
				getArtifactsDir: () => artifacts,
				getSessionId: () => "session",
			},
			ensureLocalParentDirs: true,
		};
		await expect(expandInternalUrls("cat local://dangling.txt", options)).rejects.toThrow(
			/escapes the session local root/,
		);
		await expect(expandInternalUrls("cat local://dirlink/new.txt", options)).rejects.toThrow(
			/escapes the session local root/,
		);
		await expect(Bun.file(path.join(outside, "new.txt")).exists()).resolves.toBe(false);
		await rm(root, { recursive: true, force: true });
	});

	it("allows a new file when the local root is reached through a symlinked ancestor", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "local-bash-"));
		const real = path.join(root, "real");
		const link = path.join(root, "link");
		await mkdir(path.join(real, "artifacts", "local"), { recursive: true });
		await symlink(real, link);
		const expanded = await expandInternalUrls("cat local://out.txt", {
			skills: [],
			localOptions: {
				getArtifactsDir: () => path.join(link, "artifacts"),
				getSessionId: () => "session",
			},
		});
		expect(expanded).toContain(`${path.sep}real${path.sep}`);
		expect(expanded).toContain(`${path.sep}out.txt`);
		await rm(root, { recursive: true, force: true });
	});
});
