import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import {
	applyGjcBundleUpdate,
	bundleIdentity,
	installGjcBundle,
	previewGjcBundleUpdate,
} from "../src/extensibility/gjc-plugins";
import { compileGjcPluginBundle } from "../src/extensibility/gjc-plugins/compiler";
import { isGjcPluginSourceShape } from "../src/extensibility/gjc-plugins/installer";
import { isLocalDirectorySourceForTest, storedSourceLocatorForTest } from "../src/extensibility/gjc-plugins/lifecycle";
import { GjcPluginLoadError } from "../src/extensibility/gjc-plugins/types";

/**
 * A refused install must be observable as a pure read. The transaction used to
 * create the scope root and sweep orphan directories before consulting the
 * policy decision, so an `already_installed_use_upgrade` refusal still mutated
 * the filesystem.
 */

const fixturesRoot = path.join(import.meta.dir, "fixtures", "gjc-plugins");
const sixSurface = path.join(fixturesRoot, "valid-six-surface-bundle");
const tempDirs: string[] = [];
const originalAgentDir = getAgentDir();
let agentDir: string;

beforeEach(async () => {
	agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-refusal-agent-"));
	setAgentDir(agentDir);
});

afterEach(async () => {
	setAgentDir(originalAgentDir);
	for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
	await fs.rm(agentDir, { recursive: true, force: true });
});

async function mkProjectCwd(): Promise<string> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-refusal-"));
	tempDirs.push(cwd);
	return cwd;
}

/**
 * Byte- and metadata-sensitive snapshot. A plain entry listing cannot
 * distinguish a missing root from an empty one, acquiring a scope lock mutates
 * the root's mtime without changing the entry list, and a same-size rewrite
 * would be invisible without hashing file contents.
 */
async function treeOf(root: string): Promise<string> {
	try {
		const stat = await fs.stat(root);
		const entries = await fs.readdir(root, { withFileTypes: true, recursive: true });
		const rows = await Promise.all(
			entries.map(async entry => {
				const full = path.join(entry.parentPath ?? root, entry.name);
				const child = await fs.lstat(full);
				const kind = child.isDirectory() ? "d" : child.isSymbolicLink() ? "l" : "f";
				const digest = child.isFile()
					? createHash("sha256")
							.update(await fs.readFile(full))
							.digest("hex")
					: "";
				return `${path.relative(root, full)}:${kind}:${child.size}:${child.mtimeMs}:${digest}`;
			}),
		);
		return `present:${stat.mtimeMs}:${rows.sort().join("|")}`;
	} catch {
		return "absent";
	}
}

describe("GJC bundle refusal purity", () => {
	test("a refused install does not create the scope root", async () => {
		const cwd = await mkProjectCwd();
		const scopeRoot = path.join(cwd, ".gjc", "gjc-plugins");

		const first = await installGjcBundle({ cwd }, "project", sixSurface);
		expect(first.ok).toBe(true);
		const before = await treeOf(scopeRoot);

		const refused = await installGjcBundle({ cwd }, "project", sixSurface);
		expect(refused).toMatchObject({ ok: false, error: { code: "already_installed_use_upgrade" } });

		expect(await treeOf(scopeRoot)).toEqual(before);
	});

	test("a refused install into an untouched scope leaves no directory behind", async () => {
		const cwd = await mkProjectCwd();
		// Install into project, then refuse a second project install. The user
		// scope was never a target, so its root must not have been created.
		expect((await installGjcBundle({ cwd }, "project", sixSurface)).ok).toBe(true);
		const userRoot = path.join(agentDir, "gjc-plugins");
		const beforeUser = await treeOf(userRoot);

		const refused = await installGjcBundle({ cwd }, "project", sixSurface);
		expect(refused.ok).toBe(false);

		expect(await treeOf(userRoot)).toEqual(beforeUser);
	});

	test("a refused install leaves the untargeted opposite scope byte-identical", async () => {
		const cwd = await mkProjectCwd();
		const userRoot = path.join(agentDir, "gjc-plugins");
		expect((await installGjcBundle({ cwd }, "project", sixSurface)).ok).toBe(true);
		// A committing install legitimately locks both scopes, because the
		// collision decision spans them; that lock creates the opposite-scope
		// root. What a REFUSAL must not do is change it, since the refusal is
		// decided before any lock is acquired.
		const beforeUser = await treeOf(userRoot);

		const refused = await installGjcBundle({ cwd }, "project", sixSurface);
		expect(refused).toMatchObject({ ok: false, error: { code: "already_installed_use_upgrade" } });

		expect(await treeOf(userRoot)).toBe(beforeUser);
	});

	test("a refused install does not depend on the source being resolvable", async () => {
		const cwd = await mkProjectCwd();
		expect((await installGjcBundle({ cwd }, "project", sixSurface)).ok).toBe(true);
		const scopeRoot = path.join(cwd, ".gjc", "gjc-plugins");
		const before = await treeOf(scopeRoot);

		// A copy that declares the same name but is otherwise broken must still be
		// refused with the create-only error, not a compile/resolve failure.
		const broken = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-refusal-broken-"));
		tempDirs.push(broken);
		await fs.writeFile(
			path.join(broken, "gajae-plugin.json"),
			JSON.stringify({ name: "valid-six-surface-bundle", version: "9.9.9" }),
		);

		const refused = await installGjcBundle({ cwd }, "project", broken);
		expect(refused).toMatchObject({ ok: false, error: { code: "already_installed_use_upgrade" } });
		expect(await treeOf(scopeRoot)).toBe(before);
	});

	test("a vanished source cannot be identified, so it resolves rather than refusing", async () => {
		const cwd = await mkProjectCwd();
		// Install from a COPY, then delete it. Identity can only come from the
		// declared manifest name; a stored-locator match is NOT sound, because one
		// locator can back different content or a differently named bundle. With
		// the source gone the name is unreadable, so this correctly falls through
		// to resolution and reports source failure instead of a create-only
		// refusal derived from an assumption.
		const copy = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-refusal-gone-"));
		tempDirs.push(copy);
		await fs.cp(sixSurface, copy, { recursive: true });
		expect((await installGjcBundle({ cwd }, "project", copy)).ok).toBe(true);
		const scopeRoot = path.join(cwd, ".gjc", "gjc-plugins");
		const before = await treeOf(scopeRoot);

		await fs.rm(copy, { recursive: true, force: true });

		// Assert the SPECIFIC contract, not merely that something threw: the
		// failure must be the typed source error, and it must name the missing
		// source rather than silently succeeding or refusing on a guess.
		await expect(installGjcBundle({ cwd }, "project", copy)).rejects.toMatchObject({
			code: "missing_file",
		});
		// The installed target must be untouched.
		expect(await treeOf(scopeRoot)).toBe(before);
	});

	test("an unreachable remote locator matching no installed entry is not silently refused", async () => {
		const cwd = await mkProjectCwd();
		expect((await installGjcBundle({ cwd }, "project", sixSurface)).ok).toBe(true);
		// A remote locator that names no installed bundle must NOT be swallowed by
		// the preflight; it has to reach resolution and fail there instead.
		// It must reach resolution and fail there, as a GjcPluginLoadError, rather
		// than being absorbed by the preflight as an already-installed refusal.
		const attempt = installGjcBundle({ cwd }, "project", "https://example.invalid/nobody/nothing.git");
		await expect(attempt).rejects.toBeInstanceOf(GjcPluginLoadError);
	});

	test("a locator shared with another scope never blocks an install", async () => {
		const cwd = await mkProjectCwd();
		const copy = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-refusal-reuse-"));
		tempDirs.push(copy);
		await fs.cp(sixSurface, copy, { recursive: true });
		expect((await installGjcBundle({ cwd }, "project", copy)).ok).toBe(true);

		// Same locator, but the target scope has no such entry: the locator match
		// is scoped, so a user-scope install must NOT be refused by the project
		// entry that happens to share the source.
		const userInstall = await installGjcBundle({ cwd }, "user", copy);
		expect(userInstall.ok).toBe(true);
	});

	test("source classification never disagrees with the installer predicates", () => {
		// The installer decides remote-vs-local with these exact predicates. If the
		// refusal preflight ever classifies something as a local DIRECTORY that the
		// installer treats as git or a tarball, the preflight reads a manifest that
		// does not belong to that source, which is the shadowing hole this guards.
		const looksLikeGit = (s: string): boolean =>
			/^(https?|ssh|git):\/\//i.test(s) || /^git@/.test(s) || s.startsWith("git:");
		const isTarball = (s: string): boolean => /\.(tgz|tar\.gz|tar)$/i.test(s);

		// Bidirectional: every locator asserts an exact expectation, so a case can
		// never silently assert nothing. A remote-looking locator must never be
		// read as a local directory, and a genuine local path always must be.
		const expectedLocal: Record<string, boolean> = {
			"git:host/path": false,
			"git@h:o/r.git": false,
			"https://h/o/r.git": false,
			"ssh://g@h/o/r": false,
			"file:///tmp/b": false,
			"https://h/o/pkg.tgz": false,
			"host:8080/path": false,
			"user@host:path/repo": false,
			// Local archives are extracted, not read in place, so they are NOT
			// local directories for the preflight's purposes.
			"/tmp/pkg.tgz": false,
			"./local.tar.gz": false,
			"/tmp/plain.tar": false,
			"C:\\Users\\me\\b": true,
			"./rel": true,
			"../esc": true,
			"/abs/path": true,
			"weird:name": true,
			"/tmp/a:b": true,
		};
		for (const [locator, isLocal] of Object.entries(expectedLocal)) {
			expect({ locator, local: isLocalDirectorySourceForTest(locator) }).toEqual({ locator, local: isLocal });
			// A locator the installer resolves remotely must never be classified
			// as a local directory, or the preflight would read the wrong manifest.
			if (looksLikeGit(locator) || isTarball(locator)) {
				expect({ locator, local: isLocalDirectorySourceForTest(locator) }).toEqual({ locator, local: false });
			}
		}
	});

	test("a vanished stored source yields typed source_unavailable, never a throw", async () => {
		// Upstream review B2: with the stored source deleted, upgrade threw an
		// uncaught GjcPluginLoadError whose message embedded the absolute source
		// path. It must be a typed refusal with no locator in the message.
		const cwd = await mkProjectCwd();
		const copy = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-b2-src-"));
		tempDirs.push(copy);
		await fs.cp(sixSurface, copy, { recursive: true });
		expect((await installGjcBundle({ cwd }, "project", copy)).ok).toBe(true);
		const identity = bundleIdentity("project", "valid-six-surface-bundle");

		await fs.rm(copy, { recursive: true, force: true });

		const preview = await previewGjcBundleUpdate({ cwd }, identity);
		expect(preview).toMatchObject({ ok: false, error: { code: "source_unavailable" } });
		if (preview.ok) throw new Error("expected refusal");
		expect(preview.error.message).not.toContain(copy);
		expect(preview.error.message).not.toContain("/Users/");
		expect(preview.error.message).not.toContain(os.tmpdir());

		// Apply must fail the same way rather than throwing, using a token whose
		// shape is valid but whose source no longer resolves.
		const applied = await applyGjcBundleUpdate(
			{ cwd },
			{
				identity,
				agentDir,
				candidateFingerprint: "0".repeat(64),
				baselineFingerprint: "0".repeat(64),
				decisionContextFingerprint: "0".repeat(64),
				reviewedAt: new Date().toISOString(),
			},
		);
		expect(applied).toMatchObject({ ok: false, error: { code: "source_unavailable" } });
		if (applied.ok) throw new Error("expected refusal");
		expect(applied.error.message).not.toContain(copy);
	});

	test("a reachable malformed stored source yields invalid_target for preview and apply", async () => {
		const cwd = await mkProjectCwd();
		const copy = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-malformed-source-"));
		tempDirs.push(copy);
		await fs.cp(sixSurface, copy, { recursive: true });
		expect((await installGjcBundle({ cwd }, "project", copy)).ok).toBe(true);
		const identity = bundleIdentity("project", "valid-six-surface-bundle");
		await fs.rm(path.join(copy, "gajae-plugin.json"));

		const preview = await previewGjcBundleUpdate({ cwd }, identity);
		expect(preview).toMatchObject({ ok: false, error: { code: "invalid_target" } });
		const applied = await applyGjcBundleUpdate(
			{ cwd },
			{
				identity,
				agentDir,
				candidateFingerprint: "0".repeat(64),
				baselineFingerprint: "0".repeat(64),
				decisionContextFingerprint: "0".repeat(64),
				reviewedAt: new Date().toISOString(),
			},
		);
		expect(applied).toMatchObject({ ok: false, error: { code: "invalid_target" } });
	});

	test("source-shape routing never steals npm or marketplace specs", () => {
		// The CLI routes on source SHAPE before resolving, so a deleted GJC source
		// still reaches the lifecycle's typed refusal. That routing must not claim
		// anything npm or marketplace owns, or scoped installs of ordinary
		// packages would break.
		// npm package names may contain dots, so an archive SUFFIX alone must not
		// claim a spec: `foo.tgz` and `@scope/foo.tar.gz` are legal npm names.
		for (const npmSpec of [
			"@gajae-code/exa",
			"pkg@1.2.3",
			"pkg@latest",
			"bare-npm-name",
			"name@official",
			"foo.tgz",
			"@scope/foo.tar.gz",
			"my.pkg.tar",
		]) {
			expect(isGjcPluginSourceShape(npmSpec)).toBe(false);
		}
		for (const gjcSpec of [
			"./local-bundle",
			"/abs/bundle",
			"../rel",
			"~/home-bundle",
			"https://h/o/r.git",
			"git@h:o/r.git",
			"/tmp/pkg.tgz",
			"./b.tar.gz",
			"https://h/p.tgz",
			".\\bundle",
			"..\\esc",
			"C:\\x\\y",
			"\\\\srv\\share",
		]) {
			expect(isGjcPluginSourceShape(gjcSpec)).toBe(true);
		}
	});

	test("a git ref is preserved when rebuilding the stored locator", () => {
		expect(storedSourceLocatorForTest({ kind: "git", uri: "https://h/o/r.git", ref: "v2", resolvedAt: "t" })).toBe(
			"https://h/o/r.git#v2",
		);
		// Without a ref, or for non-git kinds, the URI is used verbatim.
		expect(storedSourceLocatorForTest({ kind: "git", uri: "https://h/o/r.git", resolvedAt: "t" })).toBe(
			"https://h/o/r.git",
		);
		expect(storedSourceLocatorForTest({ kind: "path", uri: "/tmp/b", ref: "ignored", resolvedAt: "t" })).toBe(
			"/tmp/b",
		);
	});

	test("hostile manifest bundle names are rejected before they can be stored or printed", async () => {
		// The bundle name is echoed by the CLI, rendered in Settings, and used to
		// derive a directory segment. Constraining it at the parse boundary means
		// no display site can ever receive control sequences, path separators,
		// whitespace, or credential-looking text.
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-hostile-name-"));
		tempDirs.push(dir);
		for (const hostile of [
			"evil\u001b[31mANSI",
			"../../escape",
			"tok=s3cr3t",
			"with space",
			"a".repeat(200),
			"/abs/path",
			"",
		]) {
			await fs.writeFile(
				path.join(dir, "gajae-plugin.json"),
				JSON.stringify({ kind: "gajae-code-plugin", name: hostile, version: "1.0.0" }),
			);
			await expect(compileGjcPluginBundle(dir)).rejects.toBeInstanceOf(GjcPluginLoadError);
		}

		// The bundle name is not the only manifest-controlled string that reaches
		// an output surface: surface names become extension IDs (`tool:<name>`)
		// and the version is rendered beside the bundle everywhere it appears.
		await fs.mkdir(path.join(dir, "tools"), { recursive: true });
		await fs.writeFile(path.join(dir, "tools", "t.ts"), "export default {}\n");
		const hostileText = "evil\u001b[31mANSI tok=s3cr3t";
		await fs.writeFile(
			path.join(dir, "gajae-plugin.json"),
			JSON.stringify({
				kind: "gajae-code-plugin",
				name: "ok-bundle",
				version: "1.0.0",
				tools: [{ name: hostileText, path: "tools/t.ts", description: "d" }],
			}),
		);
		await expect(compileGjcPluginBundle(dir)).rejects.toBeInstanceOf(GjcPluginLoadError);
		await fs.writeFile(
			path.join(dir, "gajae-plugin.json"),
			JSON.stringify({ kind: "gajae-code-plugin", name: "ok-bundle", version: hostileText }),
		);
		await expect(compileGjcPluginBundle(dir)).rejects.toBeInstanceOf(GjcPluginLoadError);

		// A hook's event and target form part of its surface ID, and a tool
		// description is displayed, so both must reject control sequences even
		// though the description is otherwise free-form prose.
		await fs.mkdir(path.join(dir, "hooks"), { recursive: true });
		await fs.writeFile(path.join(dir, "hooks", "h.ts"), "export default {}\n");
		for (const hook of [
			{ name: "h", event: hostileText, target: "read", phase: "before", path: "hooks/h.ts" },
			{ name: "h", event: "tool_call", target: hostileText, phase: "before", path: "hooks/h.ts" },
		]) {
			await fs.writeFile(
				path.join(dir, "gajae-plugin.json"),
				JSON.stringify({ kind: "gajae-code-plugin", name: "ok-bundle", version: "1.0.0", hooks: [hook] }),
			);
			await expect(compileGjcPluginBundle(dir)).rejects.toBeInstanceOf(GjcPluginLoadError);
		}
		await fs.writeFile(
			path.join(dir, "gajae-plugin.json"),
			JSON.stringify({
				kind: "gajae-code-plugin",
				name: "ok-bundle",
				version: "1.0.0",
				tools: [{ name: "t", path: "tools/t.ts", description: "bad\u001b[31mANSI" }],
			}),
		);
		await expect(compileGjcPluginBundle(dir)).rejects.toBeInstanceOf(GjcPluginLoadError);

		// A legitimate name still compiles, so the constraint is not vacuous.
		await fs.writeFile(
			path.join(dir, "gajae-plugin.json"),
			JSON.stringify({
				kind: "gajae-code-plugin",
				name: "ordinary-bundle_1.0",
				version: "1.0.0-beta.1",
				tools: [
					{
						name: "good_tool",
						path: "tools/t.ts",
						description: "Ordinary prose, punctuation: fine!",
						parameters: { type: "object", properties: {} },
					},
				],
				hooks: [{ name: "audit-read", event: "tool_call", target: "read", phase: "before", path: "hooks/h.ts" }],
			}),
		);
		await expect(compileGjcPluginBundle(dir)).resolves.toMatchObject({
			name: "ordinary-bundle_1.0",
			version: "1.0.0-beta.1",
		});
	});

	test("a git spawn failure is a typed, sanitized source failure", async () => {
		// git missing from PATH surfaces as a raw system error on the child
		// process. It must become a typed load error carrying no errno, no path,
		// and no remote URL, so the lifecycle can report source_unavailable.
		const cwd = await mkProjectCwd();
		const originalPath = process.env.PATH;
		process.env.PATH = "/nonexistent";
		try {
			const attempt = installGjcBundle({ cwd }, "project", "https://example.invalid/owner/repo.git");
			await expect(attempt).rejects.toBeInstanceOf(GjcPluginLoadError);
			await expect(attempt).rejects.toMatchObject({ code: "missing_file" });
			await attempt.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				expect(message).not.toContain("example.invalid");
				expect(message).not.toContain("ENOENT");
				expect(message).not.toContain(cwd);
			});
		} finally {
			process.env.PATH = originalPath;
		}
	});

	test("C1 controls are rejected in prose and stripped from rendered appendices", async () => {
		// U+009B is a single-byte CSI: it introduces an escape sequence with no
		// preceding ESC, so a validator that rejects only C0 leaves the same
		// injection open. Carriage return can also rewrite a rendered line.
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-c1-"));
		tempDirs.push(dir);
		await fs.mkdir(path.join(dir, "subskills", "design"), { recursive: true });
		await fs.writeFile(
			path.join(dir, "gajae-plugin.json"),
			JSON.stringify({
				kind: "gajae-code-plugin",
				name: "ok-bundle",
				version: "1.0.0",
				subskills: ["subskills/design/SKILL.md"],
			}),
		);
		const writeSkill = (description: string) =>
			fs.writeFile(
				path.join(dir, "subskills", "design", "SKILL.md"),
				`---\nname: design\nbinds_to: ralplan\nphase: planner\nactivation_arg: design\ndescription: "${description}"\n---\nbody\n`,
			);

		await writeSkill("bad\u009b31m desc");
		await expect(compileGjcPluginBundle(dir)).rejects.toBeInstanceOf(GjcPluginLoadError);

		// Ordinary non-ASCII prose must still compile: the rule targets control
		// blocks, not everything outside ASCII.
		await writeSkill("Ordinary prose with Unicode - café, 日本語");
		await expect(compileGjcPluginBundle(dir)).resolves.toMatchObject({ name: "ok-bundle" });
	});
});
