import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import {
	applyGjcBundleUpdate,
	bundleIdentity,
	type GjcBundleIdentity,
	getGjcBundle,
	installGjcBundle,
	listGjcBundles,
	previewGjcBundleUpdate,
	readRegistry,
	redactSourceLocator,
	setGjcBundleEnabled,
	setGjcBundleSurfaceEnabled,
} from "../src/extensibility/gjc-plugins";

const fixturesRoot = path.join(import.meta.dir, "fixtures", "gjc-plugins");
const sixSurface = path.join(fixturesRoot, "valid-six-surface-bundle");
const tempDirs: string[] = [];
const originalAgentDir = getAgentDir();
let agentDir: string;

beforeEach(async () => {
	agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-lifecycle-agent-"));
	setAgentDir(agentDir);
});

afterEach(async () => {
	setAgentDir(originalAgentDir);
	for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
	await fs.rm(agentDir, { recursive: true, force: true });
});

async function mkProjectCwd(): Promise<string> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-lifecycle-"));
	tempDirs.push(cwd);
	return cwd;
}

async function mkSource(): Promise<string> {
	const source = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-lifecycle-source-"));
	tempDirs.push(source);
	await fs.cp(sixSurface, source, { recursive: true });
	return source;
}

async function rewriteManifest(source: string, version: string, tools: string): Promise<void> {
	const manifestPath = path.join(source, "gajae-plugin.json");
	const original = await fs.readFile(manifestPath, "utf8");
	const normalizedTools = JSON.parse(tools).map((tool: Record<string, unknown>) => ({
		...tool,
		parameters: tool.parameters ?? { type: "object", properties: {} },
	}));
	const next = original
		.replace(/"version": "[^"]+"/, `"version": "${version}"`)
		.replace(/"tools": \[[\s\S]*?\],\n {2}"hooks"/, `"tools": ${JSON.stringify(normalizedTools)},\n  "hooks"`);
	await fs.writeFile(manifestPath, next);
}

async function installFixture(cwd: string, scope: "project" | "user", source = sixSurface): Promise<GjcBundleIdentity> {
	const result = await installGjcBundle({ cwd }, scope, source);
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.error.code);
	return result.value.summary.identity;
}

async function summary(cwd: string, identity: GjcBundleIdentity) {
	const result = await getGjcBundle({ cwd }, identity);
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.error.code);
	return result.value;
}

describe("GJC bundle lifecycle", () => {
	test("installs a fresh bundle with an enabled, unquarantined six-surface summary", async () => {
		const cwd = await mkProjectCwd();
		const result = await installGjcBundle({ cwd }, "project", sixSurface);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.error.code);
		expect(result.value.status).toBe("installed");
		expect(result.value.summary.identity).toEqual(bundleIdentity("project", "valid-six-surface-bundle"));
		expect(result.value.summary.surfaces).toHaveLength(6);
		expect(result.value.summary.surfaces.every(surface => surface.enabled)).toBe(true);
		expect(result.value.summary.quarantined).toBe(false);
	});

	test("refuses reinstall without mutating the installed target", async () => {
		const cwd = await mkProjectCwd();
		const identity = await installFixture(cwd, "project");
		const before = await summary(cwd, identity);
		const refused = await installGjcBundle({ cwd }, "project", sixSurface);
		expect(refused).toMatchObject({ ok: false, error: { code: "already_installed_use_upgrade" } });
		if (refused.ok) throw new Error("expected install refusal");
		expect(refused.error.recovery).toContain("upgrade");
		expect((await summary(cwd, identity)).targetFingerprint).toBe(before.targetFingerprint);
	});

	test("keeps same-name bundles in separate scopes independent", async () => {
		const cwd = await mkProjectCwd();
		const project = await installFixture(cwd, "project");
		const user = await installFixture(cwd, "user");
		const userBefore = await summary(cwd, user);
		expect((await listGjcBundles({ cwd })).map(item => item.identity)).toEqual([user, project]);
		const disabled = await setGjcBundleEnabled({ cwd }, project, false);
		expect(disabled).toMatchObject({ ok: true, value: { mutated: true, summary: { enabled: false } } });
		expect(await summary(cwd, user)).toEqual(userBefore);
	});

	test("previews unchanged source with an identity-bound unchanged token", async () => {
		const cwd = await mkProjectCwd();
		const identity = await installFixture(cwd, "project");
		const preview = await previewGjcBundleUpdate({ cwd }, identity);
		expect(preview.ok).toBe(true);
		if (!preview.ok) throw new Error(preview.error.code);
		expect(preview.value).toMatchObject({ identity, changed: false, addedSurfaceIds: [], removedSurfaceIds: [] });
		expect(preview.value.token.identity).toEqual(identity);
	});

	test("previews and applies changed source content with surface deltas", async () => {
		const cwd = await mkProjectCwd();
		const source = await mkSource();
		const identity = await installFixture(cwd, "project", source);
		const previous = await summary(cwd, identity);
		await fs.writeFile(path.join(source, "tools", "additional.ts"), "export const additional = true;\n");
		await rewriteManifest(
			source,
			"1.1.0",
			'[{ "name": "additional", "path": "tools/additional.ts", "description": "Additional tool" }]',
		);
		const preview = await previewGjcBundleUpdate({ cwd }, identity);
		expect(preview.ok).toBe(true);
		if (!preview.ok) throw new Error(preview.error.code);
		expect(preview.value.changed).toBe(true);
		expect(preview.value.addedSurfaceIds).toHaveLength(1);
		expect(preview.value.removedSurfaceIds).toHaveLength(1);
		const applied = await applyGjcBundleUpdate({ cwd }, preview.value.token);
		expect(applied).toMatchObject({ ok: true, value: { status: "updated" } });
		const updated = await summary(cwd, identity);
		expect(updated.version).toBe(preview.value.candidateVersion);
		expect(updated.manifestHash).toBe(preview.value.candidateManifestHash);
		expect(updated.targetFingerprint).not.toBe(previous.targetFingerprint);
	});

	test("rejects a candidate that changed after preview without mutation", async () => {
		const cwd = await mkProjectCwd();
		const source = await mkSource();
		const identity = await installFixture(cwd, "project", source);
		const preview = await previewGjcBundleUpdate({ cwd }, identity);
		expect(preview.ok).toBe(true);
		if (!preview.ok) throw new Error(preview.error.code);
		const before = await summary(cwd, identity);
		await fs.appendFile(path.join(source, "prompts", "system-appendix.md"), "changed after review\n");
		const applied = await applyGjcBundleUpdate({ cwd }, preview.value.token);
		expect(applied).toMatchObject({ ok: false, error: { code: "stale_candidate" } });
		expect((await summary(cwd, identity)).targetFingerprint).toBe(before.targetFingerprint);
	});

	test("rejects a preview when a bundle toggle changes the installed baseline", async () => {
		const cwd = await mkProjectCwd();
		const identity = await installFixture(cwd, "project");
		const preview = await previewGjcBundleUpdate({ cwd }, identity);
		expect(preview.ok).toBe(true);
		if (!preview.ok) throw new Error(preview.error.code);
		const before = await summary(cwd, identity);
		expect(await setGjcBundleEnabled({ cwd }, identity, false)).toMatchObject({ ok: true, value: { mutated: true } });
		const applied = await applyGjcBundleUpdate({ cwd }, preview.value.token);
		expect(applied).toMatchObject({ ok: false, error: { code: "stale_baseline" } });
		// targetFingerprint covers installed content only; enablement intent is a
		// separate axis, so a toggle leaves the content fingerprint untouched while
		// still invalidating the reviewed baseline.
		const after = await summary(cwd, identity);
		expect(after.targetFingerprint).toBe(before.targetFingerprint);
		expect(after.enabled).toBe(false);
		expect(before.enabled).toBe(true);
	});
	test("rejects a preview when a surface toggle changes the installed baseline", async () => {
		const cwd = await mkProjectCwd();
		const identity = await installFixture(cwd, "project");
		const preview = await previewGjcBundleUpdate({ cwd }, identity);
		expect(preview.ok).toBe(true);
		if (!preview.ok) throw new Error(preview.error.code);
		const surfaceId = (await summary(cwd, identity)).surfaces[0]?.extensionId;
		expect(surfaceId).toBeDefined();
		if (!surfaceId) throw new Error("missing surface");
		expect(await setGjcBundleSurfaceEnabled({ cwd }, identity, surfaceId, false)).toMatchObject({
			ok: true,
			value: { mutated: true },
		});
		expect(await applyGjcBundleUpdate({ cwd }, preview.value.token)).toMatchObject({
			ok: false,
			error: { code: "stale_baseline" },
		});
	});

	test("carries surviving disabled surfaces through updates and drops removed IDs", async () => {
		const cwd = await mkProjectCwd();
		const source = await mkSource();
		const identity = await installFixture(cwd, "project", source);
		const original = await summary(cwd, identity);
		const domainNote = original.surfaces.find(surface => surface.name === "domain_note");
		expect(domainNote).toBeDefined();
		if (!domainNote) throw new Error("missing domain_note surface");
		expect(await setGjcBundleSurfaceEnabled({ cwd }, identity, domainNote.extensionId, false)).toMatchObject({
			ok: true,
			value: { mutated: true },
		});
		await fs.writeFile(path.join(source, "tools", "additional.ts"), "export const additional = true;\n");
		await rewriteManifest(
			source,
			"1.1.0",
			'[{ "name": "domain_note", "path": "tools/domain-note.ts", "description": "Write a domain-scoped note" }, { "name": "additional", "path": "tools/additional.ts", "description": "Additional tool" }]',
		);
		const first = await previewGjcBundleUpdate({ cwd }, identity);
		expect(first.ok).toBe(true);
		if (!first.ok) throw new Error(first.error.code);
		expect(await applyGjcBundleUpdate({ cwd }, first.value.token)).toMatchObject({
			ok: true,
			value: { status: "updated" },
		});
		const withAdditional = await summary(cwd, identity);
		expect(withAdditional.surfaces.find(surface => surface.extensionId === domainNote.extensionId)?.enabled).toBe(
			false,
		);
		const additional = withAdditional.surfaces.find(surface => surface.name === "additional");
		expect(additional?.enabled).toBe(true);
		await rewriteManifest(
			source,
			"1.2.0",
			'[{ "name": "additional", "path": "tools/additional.ts", "description": "Additional tool" }]',
		);
		const second = await previewGjcBundleUpdate({ cwd }, identity);
		expect(second.ok).toBe(true);
		if (!second.ok) throw new Error(second.error.code);
		expect(await applyGjcBundleUpdate({ cwd }, second.value.token)).toMatchObject({
			ok: true,
			value: { status: "updated" },
		});
		expect(
			(await summary(cwd, identity)).surfaces.find(surface => surface.extensionId === domainNote.extensionId),
		).toBeUndefined();
	});

	test("makes repeated bundle and surface toggle requests no-ops and rejects unknown surfaces", async () => {
		const cwd = await mkProjectCwd();
		const identity = await installFixture(cwd, "project");
		const before = JSON.stringify(await readRegistry("project", cwd));
		expect(await setGjcBundleEnabled({ cwd }, identity, true)).toMatchObject({ ok: true, value: { mutated: false } });
		expect(JSON.stringify(await readRegistry("project", cwd))).toBe(before);
		expect(await setGjcBundleSurfaceEnabled({ cwd }, identity, "missing-surface", false)).toMatchObject({
			ok: false,
			error: { code: "surface_unknown" },
		});
		const surfaceId = (await summary(cwd, identity)).surfaces[0]?.extensionId;
		expect(surfaceId).toBeDefined();
		if (!surfaceId) throw new Error("missing surface");
		expect(await setGjcBundleSurfaceEnabled({ cwd }, identity, surfaceId, true)).toMatchObject({
			ok: true,
			value: { mutated: false },
		});
		expect(JSON.stringify(await readRegistry("project", cwd))).toBe(before);
	});

	test("reports exact-scope missing bundles and redacts source locators", async () => {
		const cwd = await mkProjectCwd();
		const userIdentity = await installFixture(cwd, "user");
		const projectIdentity = bundleIdentity("project", userIdentity.name);
		expect(await getGjcBundle({ cwd }, projectIdentity)).toMatchObject({
			ok: false,
			error: { code: "not_installed" },
		});
		expect(await previewGjcBundleUpdate({ cwd }, projectIdentity)).toMatchObject({
			ok: false,
			error: { code: "not_installed" },
		});
		const redacted = redactSourceLocator({
			kind: "git",
			uri: "https://user:token@example.com/owner/repo.git?x=1#frag",
			resolvedAt: "now",
		});
		expect(redacted).toContain("example.com/owner/repo");
		expect(redacted).not.toContain("token");
		expect(redacted).not.toContain("user:");
		expect(redacted).not.toContain("?x=1");
		expect(redacted).not.toContain("#frag");
	});
});
