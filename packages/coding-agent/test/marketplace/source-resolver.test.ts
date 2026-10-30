import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { MarketplacePluginEntry } from "@gajae-code/coding-agent/extensibility/plugins/marketplace";
import { resolvePluginSource } from "@gajae-code/coding-agent/extensibility/plugins/marketplace";

// Fixture: a cloned marketplace with a single plugin at ./plugins/hello-plugin
const FIXTURE_DIR = path.resolve(import.meta.dir, "fixtures/valid-marketplace");

// Helper — build a minimal MarketplacePluginEntry with the given source
function makeEntry(source: MarketplacePluginEntry["source"]): MarketplacePluginEntry {
	return { name: "hello-plugin", source };
}

describe("resolvePluginSource", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-src-res-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("resolves relative source to absolute plugin directory", async () => {
		const entry = makeEntry("./plugins/hello-plugin");
		const resolved = await resolvePluginSource(entry, {
			marketplaceClonePath: FIXTURE_DIR,
			tmpDir,
		});
		expect(resolved.dir).toBe(path.resolve(FIXTURE_DIR, "plugins/hello-plugin"));
		expect(resolved.tempCloneRoot).toBeUndefined();
	});

	it("throws when source string would escape marketplace root", async () => {
		// "../../escape" does not start with "./" — hits the non-relative guard
		const entry = makeEntry("../../escape");
		await expect(resolvePluginSource(entry, { marketplaceClonePath: FIXTURE_DIR, tmpDir })).rejects.toThrow();
	});

	it("throws when relative source would escape via path traversal (./../../escape)", async () => {
		// Starts with "./" but resolves outside marketplace root
		const entry = makeEntry("./../../escape");
		await expect(resolvePluginSource(entry, { marketplaceClonePath: FIXTURE_DIR, tmpDir })).rejects.toThrow(
			/outside marketplace root/,
		);
	});

	it("throws when marketplaceClonePath is missing for relative source", async () => {
		const entry = makeEntry("./plugins/hello-plugin");
		await expect(resolvePluginSource(entry, { tmpDir })).rejects.toThrow(/marketplaceClonePath/);
	});

	it("prepends catalogMetadata.pluginRoot to the relative source path", async () => {
		// pluginRoot "plugins" + source "./hello-plugin" → ./plugins/hello-plugin
		const entry = makeEntry("./hello-plugin");
		const resolved = await resolvePluginSource(entry, {
			marketplaceClonePath: FIXTURE_DIR,
			catalogMetadata: { pluginRoot: "plugins" },
			tmpDir,
		});
		expect(resolved.dir).toBe(path.resolve(FIXTURE_DIR, "plugins/hello-plugin"));
		expect(resolved.tempCloneRoot).toBeUndefined();
	});

	// Network-dependent: object sources attempt real git clones
	it.skip("resolves github object source via git clone", async () => {
		const entry = makeEntry({ source: "github", repo: "nonexistent-owner/nonexistent-repo" });
		await expect(resolvePluginSource(entry, { marketplaceClonePath: FIXTURE_DIR, tmpDir })).rejects.toThrow(
			/git clone failed/,
		);
	});

	it.skip("resolves url object source via git clone", async () => {
		const entry = makeEntry({ source: "url", url: "https://example.com/nonexistent.git" });
		await expect(resolvePluginSource(entry, { marketplaceClonePath: FIXTURE_DIR, tmpDir })).rejects.toThrow(
			/git clone failed/,
		);
	});

	it("rejects a relative source whose directory is a symlink out of the marketplace root", async () => {
		// A catalog controls the tree it ships; a lexical containment check passes for
		// "./plugins/escaped" while the kernel resolves it to an unrelated directory.
		const marketplace = path.join(tmpDir, "marketplace");
		const outside = path.join(tmpDir, "outside", "secret-plugin");
		fs.mkdirSync(path.join(marketplace, "plugins"), { recursive: true });
		fs.mkdirSync(outside, { recursive: true });
		fs.symlinkSync(outside, path.join(marketplace, "plugins", "escaped"), "dir");

		const entry = makeEntry("./plugins/escaped");
		await expect(resolvePluginSource(entry, { marketplaceClonePath: marketplace, tmpDir })).rejects.toThrow(
			/outside marketplace root/,
		);
	});

	it("rejects a symlinked source reached through catalogMetadata.pluginRoot", async () => {
		const marketplace = path.join(tmpDir, "marketplace-root");
		const outside = path.join(tmpDir, "outside-root", "secret-plugin");
		fs.mkdirSync(path.join(marketplace, "plugins"), { recursive: true });
		fs.mkdirSync(outside, { recursive: true });
		fs.symlinkSync(outside, path.join(marketplace, "plugins", "escaped"), "dir");

		const entry = makeEntry("./escaped");
		await expect(
			resolvePluginSource(entry, {
				marketplaceClonePath: marketplace,
				catalogMetadata: { pluginRoot: "plugins" },
				tmpDir,
			}),
		).rejects.toThrow(/outside marketplace root/);
	});

	it("rejects a symlink that escapes the root but cannot be canonicalized at check time", async () => {
		// TOCTOU-shaped case: the link target does not exist when containment is
		// decided, so realpath fails and a lexical fallback would admit the path.
		// The target can be materialized before the directory probe follows the link.
		const marketplace = path.join(tmpDir, "marketplace-dangling");
		const outside = path.join(tmpDir, "outside-dangling", "secret-plugin");
		fs.mkdirSync(path.join(marketplace, "plugins"), { recursive: true });
		fs.symlinkSync(outside, path.join(marketplace, "plugins", "escaped"), "dir");

		const entry = makeEntry("./plugins/escaped");
		await expect(resolvePluginSource(entry, { marketplaceClonePath: marketplace, tmpDir })).rejects.toThrow(
			/outside marketplace root/,
		);
	});

	it("accepts a symlink that stays inside the marketplace root", async () => {
		const marketplace = path.join(tmpDir, "marketplace-inner");
		fs.mkdirSync(path.join(marketplace, "real", "hello-plugin"), { recursive: true });
		fs.mkdirSync(path.join(marketplace, "plugins"), { recursive: true });
		fs.symlinkSync(
			path.join(marketplace, "real", "hello-plugin"),
			path.join(marketplace, "plugins", "linked"),
			"dir",
		);

		const entry = makeEntry("./plugins/linked");
		const resolved = await resolvePluginSource(entry, { marketplaceClonePath: marketplace, tmpDir });
		expect(resolved.dir).toBe(path.resolve(marketplace, "plugins/linked"));
	});

	describe("hostile catalog-controlled git arguments", () => {
		// Every case below must be refused before git is invoked; a resolution that
		// reached git.clone would report a clone/network failure instead.
		it.each([
			["option-looking url", "--upload-pack=touch /tmp/pwned"],
			["short option url", "-u"],
			["config-injecting url", "--config=core.sshCommand=touch"],
			["ext remote helper", "ext::sh -c touch% /tmp/pwned"],
			["transport helper", "transport::whatever"],
			["bare relative path", "../../etc"],
			["empty", ""],
		])("rejects a url source with a %s", async (_label, url) => {
			const entry = makeEntry({ source: "url", url });
			await expect(resolvePluginSource(entry, { tmpDir })).rejects.toThrow(/Plugin source URL must be/);
		});

		it.each([
			["option-looking repo", "--upload-pack=touch"],
			["traversal repo", "../../etc/passwd"],
			["repo with a space", "owner/repo extra"],
			["repo without an owner", "repo"],
		])("rejects a github source with a %s", async (_label, repo) => {
			const entry = makeEntry({ source: "github", repo });
			await expect(resolvePluginSource(entry, { tmpDir })).rejects.toThrow(/must be "owner\/repo"/);
		});

		it("rejects a git-subdir shorthand url that looks like an option", async () => {
			const entry = makeEntry({ source: "git-subdir", url: "--upload-pack=touch", path: "plugins/foo" });
			await expect(resolvePluginSource(entry, { tmpDir })).rejects.toThrow(/must be "owner\/repo"/);
		});

		it("rejects a git-subdir explicit url with an unsupported scheme", async () => {
			const entry = makeEntry({ source: "git-subdir", url: "ftp://evil.example/repo.git", path: "plugins/foo" });
			await expect(resolvePluginSource(entry, { tmpDir })).rejects.toThrow(/Plugin source URL must be/);
		});

		it("rejects a git-subdir remote-helper url that carries no scheme separator", async () => {
			// "ext::sh -c ..." has no "://", so it takes the owner/repo shorthand branch
			// and must be refused there rather than being pasted into a GitHub URL.
			const entry = makeEntry({ source: "git-subdir", url: "ext::sh -c touch% /tmp/pwned", path: "plugins/foo" });
			await expect(resolvePluginSource(entry, { tmpDir })).rejects.toThrow(/must be "owner\/repo"/);
		});

		it.each([
			["option-looking subdir", "--output=/tmp/pwned"],
			["absolute subdir", "/etc"],
		])("rejects a git-subdir source with an %s before cloning", async (_label, subdir) => {
			const entry = makeEntry({ source: "git-subdir", url: "owner/repo", path: subdir });
			await expect(resolvePluginSource(entry, { tmpDir })).rejects.toThrow(/must be a relative path/);
		});
	});

	it("throws when resolved directory does not exist", async () => {
		const entry = makeEntry("./plugins/nonexistent-plugin");
		await expect(resolvePluginSource(entry, { marketplaceClonePath: FIXTURE_DIR, tmpDir })).rejects.toThrow(
			/does not exist/,
		);
	});
});
