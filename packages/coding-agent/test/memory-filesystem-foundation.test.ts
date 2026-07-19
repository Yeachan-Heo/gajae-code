import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	enrollFilesystemMemoryProjectIdentity,
	getFilesystemMemoryDataDir,
	getFilesystemMemoryRegistryPath,
	registryKeyForCommonDir,
	resolveFilesystemMemoryProjectIdentity,
	sanitizeFilesystemMemoryRemoteDisplay,
} from "../src/memory-filesystem/identity";
import {
	authorizeSafeFilesystemMemoryCreatePath,
	listSafeFilesystemMemoryDirectory,
	readSafeFilesystemMemoryFile,
} from "../src/memory-filesystem/safe-path";
import { formatFilesystemMemoryUri, parseFilesystemMemoryUri } from "../src/memory-filesystem/uri";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "filesystem-memory-foundation-"));
	temporaryRoots.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("filesystem memory URI and identity foundation", () => {
	it("accepts only canonical logical URI segments and rejects traversal or malformed encodings", () => {
		expect(parseFilesystemMemoryUri("project:///notes/Design%20Doc.md")).toMatchObject({
			code: "ok",
			value: { canonical: "project:///notes/Design%20Doc.md" },
		});
		for (const value of [
			"project:///../secret.md",
			"project:///%2e%2e/secret.md",
			"project:///a%2Fb.md",
			"project:///bad%",
			"project:///space here.md",
			"file:///notes.md",
		]) {
			expect(parseFilesystemMemoryUri(value).code).toBe("invalid_uri");
		}
		expect(formatFilesystemMemoryUri("session", ["."]).code).toBe("invalid_uri");
	});

	it("keeps the enrolled UUID private and derives registry/data locations from the supplied agent directory", () => {
		const commonDir = "/private/repositories/project/.git";
		const enrolled = enrollFilesystemMemoryProjectIdentity(
			{ version: 1, repositories: {} },
			commonDir,
			"https://user:token@example.test/org/repo.git?secret=1#x",
			"2026-01-01T00:00:00.000Z",
		);
		const key = registryKeyForCommonDir(commonDir);
		expect(enrolled.repositories[key]).toMatchObject({ commonDir, enrolledAt: "2026-01-01T00:00:00.000Z" });
		expect(enrolled.repositories[key]?.projectId).toMatch(/^[0-9a-f-]{36}$/);
		expect(enrolled.repositories[key]?.remoteDisplay).toBe("https://example.test/org/repo.git");
		expect(
			enrollFilesystemMemoryProjectIdentity(enrolled, commonDir, null, "later").repositories[key]?.projectId,
		).toBe(enrolled.repositories[key]?.projectId);
		expect(getFilesystemMemoryDataDir("/tmp/agent")).toBe("/tmp/agent/memory-filesystem");
		expect(getFilesystemMemoryRegistryPath("/tmp/agent")).toBe(
			"/tmp/agent/memory-filesystem/identity-registry.v1.json",
		);
		expect(sanitizeFilesystemMemoryRemoteDisplay("git@github.com:org/repo.git?token=x")).toBe(
			"github.com:org/repo.git",
		);
	});

	it("uses the active worktree for repository-shared memory while preserving one private identity", async () => {
		const root = await temporaryRoot();
		const primary = path.join(root, "primary");
		const linked = path.join(root, "linked");
		const git = async (...args: string[]): Promise<string> => {
			const child = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
			if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text());
			return (await new Response(child.stdout).text()).trim();
		};
		await git("init", primary);
		await git("-C", primary, "config", "user.email", "test@example.test");
		await git("-C", primary, "config", "user.name", "Test");
		await fs.writeFile(path.join(primary, "README.md"), "fixture\n");
		await git("-C", primary, "add", "README.md");
		await git("-C", primary, "commit", "-m", "fixture");
		await git("-C", primary, "worktree", "add", "-b", "linked", linked);
		const commonDir = await fs.realpath(
			path.resolve(primary, await git("-C", primary, "rev-parse", "--git-common-dir")),
		);
		const registry = enrollFilesystemMemoryProjectIdentity(
			{ version: 1, repositories: {} },
			commonDir,
			null,
			"2026-01-01T00:00:00.000Z",
		);
		const agentDir = path.join(root, "agent");
		const [first, second] = await Promise.all([
			resolveFilesystemMemoryProjectIdentity({ cwd: primary, registry, agentDir }),
			resolveFilesystemMemoryProjectIdentity({ cwd: linked, registry, agentDir }),
		]);
		expect(first.code).toBe("ok");
		expect(second.code).toBe("ok");
		if (first.code !== "ok" || second.code !== "ok") throw new Error("expected enrolled worktrees");
		expect(first.value.projectId).toBe(second.value.projectId);
		expect(first.value.privateRoot).toBe(second.value.privateRoot);
		expect(first.value.sharedRoot).toBe(path.join(primary, ".gjc", "memory"));
		expect(second.value.sharedRoot).toBe(path.join(linked, ".gjc", "memory"));
		const registryKey = registryKeyForCommonDir(commonDir);
		const malformed = {
			version: 1 as const,
			repositories: {
				...registry.repositories,
				[registryKey]: { ...registry.repositories[registryKey]!, projectId: "../../escape" },
			},
		};
		expect((await resolveFilesystemMemoryProjectIdentity({ cwd: primary, registry: malformed, agentDir })).code).toBe(
			"identity_unavailable",
		);
	});

	it("fails closed for symlink paths, including a supplied root symlink, and paths escaping the supplied memory root", async () => {
		const root = await temporaryRoot();
		const outside = path.join(root, "outside.md");
		await fs.writeFile(outside, "outside");
		await fs.symlink(outside, path.join(root, "linked.md"));
		const linkedRoot = path.join(root, "linked-root");
		await fs.symlink(root, linkedRoot);
		const realParent = path.join(root, "real-parent");
		await fs.mkdir(path.join(realParent, "memory"), { recursive: true });
		await fs.writeFile(path.join(realParent, "memory", "inside.md"), "inside");
		const linkedParent = path.join(root, "linked-parent");
		await fs.symlink(realParent, linkedParent);
		expect((await readSafeFilesystemMemoryFile(root, ["linked.md"])).code).toBe("symlink_denied");
		expect((await readSafeFilesystemMemoryFile(linkedRoot, ["outside.md"])).code).toBe("symlink_denied");
		expect((await readSafeFilesystemMemoryFile(path.join(linkedParent, "memory"), ["inside.md"])).code).toBe(
			"symlink_denied",
		);
		expect((await readSafeFilesystemMemoryFile(root, ["..", "outside.md"])).code).toBe("invalid_path");
		expect((await authorizeSafeFilesystemMemoryCreatePath(root, ["..", "escape.md"])).code).toBe("invalid_path");
	});

	it("lists sorted bounded child metadata without following symlink roots, components, or children", async () => {
		const root = await temporaryRoot();
		const nested = path.join(root, "nested");
		await fs.mkdir(nested);
		await fs.writeFile(path.join(root, "z.md"), "z");
		await fs.writeFile(path.join(root, "a.md"), "a");
		await fs.symlink(path.join(root, "a.md"), path.join(root, "linked.md"));
		await fs.symlink(nested, path.join(root, "linked-directory"));
		const linkedRoot = path.join(root, "linked-root");
		await fs.symlink(root, linkedRoot);

		expect(await listSafeFilesystemMemoryDirectory(linkedRoot, [], 8)).toMatchObject({ code: "symlink_denied" });
		expect(await listSafeFilesystemMemoryDirectory(root, ["linked-directory"], 8)).toMatchObject({
			code: "symlink_denied",
		});
		expect(await listSafeFilesystemMemoryDirectory(root, [], 2)).toMatchObject({
			code: "ok",
			value: {
				entries: [
					{ name: "a.md", type: "file" },
					{ name: "linked-directory", type: "symlink" },
				],
				truncated: true,
			},
		});
	});

	it("requires a stable directory target before enumerating its direct children", async () => {
		const root = await temporaryRoot();
		await fs.writeFile(path.join(root, "file.md"), "file");
		expect(await listSafeFilesystemMemoryDirectory(root, ["file.md"], 8)).toMatchObject({
			code: "invalid_path",
		});
		expect(await listSafeFilesystemMemoryDirectory(root, [], 0)).toMatchObject({
			code: "ok",
			value: { entries: [], truncated: true },
		});
	});

	it("reads a regular contained file and rejects oversized descriptors without leaking a physical path", async () => {
		const root = await temporaryRoot();
		await fs.writeFile(path.join(root, "safe.md"), "safe");
		const read = await readSafeFilesystemMemoryFile(root, ["safe.md"], 4);
		expect(read).toMatchObject({ code: "ok", value: { bytes: new Uint8Array(Buffer.from("safe")) } });
		expect((await readSafeFilesystemMemoryFile(root, ["safe.md"], 3)).code).toBe("too_large");
	});
});
