import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir } from "@gajae-code/utils";
import {
	applyGjcBundleUpdate,
	bundleIdentity,
	findingsForBundle,
	type GjcBundleIdentity,
	type GjcPluginRegistryEntry,
	type GjcReviewedUpdateToken,
	getGjcBundle,
	installGjcBundle,
	listGjcBundles,
	previewGjcBundleUpdate,
	readRegistry,
	redactSourceLocator,
	registryPathForScope,
	setGjcBundleEnabled,
	setGjcBundleSurfaceEnabled,
	toBundleSummary,
} from "../src/extensibility/gjc-plugins";
import { runGjcBundleTransaction } from "../src/extensibility/gjc-plugins/installer";
import { writeRegistry } from "../src/extensibility/gjc-plugins/registry";

const fixturesRoot = path.join(import.meta.dir, "fixtures", "gjc-plugins");
const sixSurface = path.join(fixturesRoot, "valid-six-surface-bundle");
const originalAgentDir = getAgentDir();
const tempDirs: string[] = [];
let agentDir: string;

beforeEach(async () => {
	agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-lifecycle-redteam-agent-"));
	setAgentDir(agentDir);
});

afterEach(async () => {
	setAgentDir(originalAgentDir);
	for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
	await fs.rm(agentDir, { recursive: true, force: true });
});

async function mkProjectCwd(): Promise<string> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-lifecycle-redteam-project-"));
	tempDirs.push(cwd);
	return cwd;
}

async function mkSource(): Promise<string> {
	const source = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-lifecycle-redteam-source-"));
	tempDirs.push(source);
	await fs.cp(sixSurface, source, { recursive: true });
	return source;
}

async function rewriteManifest(source: string, version: string, tools: string): Promise<void> {
	const manifestPath = path.join(source, "gajae-plugin.json");
	const original = await fs.readFile(manifestPath, "utf8");
	await fs.writeFile(
		manifestPath,
		original
			.replace(/"version": "[^"]+"/, `"version": "${version}"`)
			.replace(/"tools": \[[\s\S]*?\],\n {2}"hooks"/, `"tools": ${tools},\n  "hooks"`),
	);
}
async function writeToolsOnlyManifest(source: string, version: string, tools: string): Promise<void> {
	await fs.writeFile(
		path.join(source, "gajae-plugin.json"),
		`{
  "kind": "gajae-code-plugin",
  "name": "valid-six-surface-bundle",
  "version": "${version}",
  "tools": ${tools}
}
`,
	);
}

async function install(cwd: string, scope: "project" | "user", source = sixSurface): Promise<GjcBundleIdentity> {
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

async function injectQuarantine(
	cwd: string,
	identity: GjcBundleIdentity,
	entries: GjcPluginRegistryEntry["quarantine"],
): Promise<void> {
	const registry = await readRegistry(identity.scope, cwd);
	await writeRegistry(
		{
			...registry,
			plugins: registry.plugins.map(entry =>
				entry.name === identity.name ? { ...entry, quarantine: entries } : entry,
			),
		},
		cwd,
	);
}

function changedToken(token: GjcReviewedUpdateToken, changes: Partial<GjcReviewedUpdateToken>): GjcReviewedUpdateToken {
	return { ...token, ...changes };
}

describe("GJC bundle lifecycle adversarial invariants", () => {
	test("keeps same-name user and project bundles byte-isolated through update, toggle, and quarantine", async () => {
		const cwd = await mkProjectCwd();
		const source = await mkSource();
		const project = await install(cwd, "project", source);
		const user = await install(cwd, "user", source);
		const userBefore = JSON.stringify(await summary(cwd, user));

		await fs.writeFile(path.join(source, "tools", "additional.ts"), "export const additional = true;\n");
		await rewriteManifest(source, "2.0.0", '[{ "name": "additional", "path": "tools/additional.ts" }]');
		const preview = await previewGjcBundleUpdate({ cwd }, project);
		expect(preview.ok).toBe(true);
		if (!preview.ok) throw new Error(preview.error.code);
		expect(await applyGjcBundleUpdate({ cwd }, preview.value.token)).toMatchObject({
			ok: true,
			value: { status: "updated" },
		});
		expect(JSON.stringify(await summary(cwd, user))).toBe(userBefore);

		const projectSurface = (await summary(cwd, project)).surfaces[0]?.extensionId;
		expect(projectSurface).toBeDefined();
		if (!projectSurface) throw new Error("missing project surface");
		expect(await setGjcBundleSurfaceEnabled({ cwd }, project, projectSurface, false)).toMatchObject({ ok: true });
		expect(JSON.stringify(await summary(cwd, user))).toBe(userBefore);

		await injectQuarantine(cwd, project, [
			{ surfaceId: projectSurface, code: "runtime_mismatch", message: "simulated", detectedAt: "now" },
		]);
		expect(JSON.stringify(await summary(cwd, user))).toBe(userBefore);
	});

	test("refuses scope/name-swapped, fingerprint-forged, and replayed update tokens without mutation", async () => {
		const cwd = await mkProjectCwd();
		const source = await mkSource();
		const project = await install(cwd, "project", source);
		const user = await install(cwd, "user", source);
		await fs.appendFile(path.join(source, "prompts", "system-appendix.md"), "candidate change\n");
		const preview = await previewGjcBundleUpdate({ cwd }, project);
		expect(preview.ok).toBe(true);
		if (!preview.ok) throw new Error(preview.error.code);

		const projectBefore = JSON.stringify(await summary(cwd, project));
		const userBefore = JSON.stringify(await summary(cwd, user));
		const wrongScope = await applyGjcBundleUpdate({ cwd }, changedToken(preview.value.token, { identity: user }));
		expect(wrongScope).toMatchObject({ ok: false, error: { code: "stale_candidate" } });
		expect(JSON.stringify(await summary(cwd, project))).toBe(projectBefore);
		expect(JSON.stringify(await summary(cwd, user))).toBe(userBefore);

		const wrongName = await applyGjcBundleUpdate(
			{ cwd },
			changedToken(preview.value.token, { identity: bundleIdentity("project", "different-name") }),
		);
		expect(wrongName).toMatchObject({ ok: false, error: { code: "not_installed" } });
		expect(JSON.stringify(await summary(cwd, project))).toBe(projectBefore);

		const forged = await applyGjcBundleUpdate(
			{ cwd },
			changedToken(preview.value.token, { candidateFingerprint: "0".repeat(64) }),
		);
		expect(forged).toMatchObject({ ok: false, error: { code: "stale_candidate" } });
		expect(JSON.stringify(await summary(cwd, project))).toBe(projectBefore);

		expect(await applyGjcBundleUpdate({ cwd }, preview.value.token)).toMatchObject({
			ok: true,
			value: { status: "updated" },
		});
		const afterFirstApply = JSON.stringify(await summary(cwd, project));
		const replay = await applyGjcBundleUpdate({ cwd }, preview.value.token);
		expect(replay).toMatchObject({ ok: false, error: { code: "stale_baseline" } });
		expect(JSON.stringify(await summary(cwd, project))).toBe(afterFirstApply);
	});

	test("the transaction primitive is not publicly reachable, so create-only cannot be bypassed", async () => {
		const cwd = await mkProjectCwd();
		const source = await mkSource();
		const identity = await install(cwd, "project", source);
		await fs.appendFile(path.join(source, "prompts", "system-appendix.md"), "replacing transaction\n");
		const before = await summary(cwd, identity);
		const publicInstall = await installGjcBundle({ cwd }, "project", source);
		expect(publicInstall).toMatchObject({ ok: false, error: { code: "already_installed_use_upgrade" } });
		expect((await summary(cwd, identity)).targetFingerprint).toBe(before.targetFingerprint);

		// The primitive still exists internally and, given a permissive decision,
		// will commit a replacement. That is precisely why it must not be publicly
		// reachable: the policy lives in the caller, not in the primitive.
		const bypass = await runGjcBundleTransaction(source, {
			scope: "project",
			cwd,
			decide: async ({ candidate }) => ({ kind: "commit", entry: candidate }),
		});
		expect(bypass.status).toBe("committed");

		// Barrel and package-export boundaries are what actually close this; see
		// gjc-plugin-public-boundary.test.ts. Assert the barrel here too, so this
		// test fails if the primitive is ever re-exported.
		const barrel: Record<string, unknown> = await import("../src/extensibility/gjc-plugins");
		for (const forbidden of ["runGjcBundleTransaction", "resolveGjcBundleCandidate", "candidateRegistryEntry"]) {
			expect(Object.keys(barrel)).not.toContain(forbidden);
		}
	});

	test("reconciles disjoint and re-added surfaces while deduplicating quarantine", async () => {
		const cwd = await mkProjectCwd();
		const source = await mkSource();
		const identity = await install(cwd, "project", source);
		const original = await summary(cwd, identity);
		const removedId = original.surfaces.find(surface => surface.name === "domain_note")?.extensionId;
		expect(removedId).toBeDefined();
		if (!removedId) throw new Error("missing original tool");
		expect(await setGjcBundleSurfaceEnabled({ cwd }, identity, removedId, false)).toMatchObject({ ok: true });
		await fs.writeFile(path.join(source, "tools", "additional.ts"), "export const additional = true;\n");
		await writeToolsOnlyManifest(source, "2.0.0", '[{ "name": "additional", "path": "tools/additional.ts" }]');
		let preview = await previewGjcBundleUpdate({ cwd }, identity);
		expect(preview.ok).toBe(true);
		if (!preview.ok) throw new Error(preview.error.code);
		expect(await applyGjcBundleUpdate({ cwd }, preview.value.token)).toMatchObject({ ok: true });
		expect((await summary(cwd, identity)).surfaces.some(surface => surface.extensionId === removedId)).toBe(false);

		await writeToolsOnlyManifest(
			source,
			"3.0.0",
			'[{ "name": "domain_note", "path": "tools/domain-note.ts" }, { "name": "additional", "path": "tools/additional.ts" }]',
		);
		preview = await previewGjcBundleUpdate({ cwd }, identity);
		expect(preview.ok).toBe(true);
		if (!preview.ok) throw new Error(preview.error.code);
		expect(await applyGjcBundleUpdate({ cwd }, preview.value.token)).toMatchObject({ ok: true });
		expect((await summary(cwd, identity)).surfaces.find(surface => surface.extensionId === removedId)?.enabled).toBe(
			true,
		);

		await injectQuarantine(cwd, identity, [
			{ surfaceId: removedId, code: "runtime_mismatch", message: "first", detectedAt: "1" },
			{ surfaceId: removedId, code: "runtime_mismatch", message: "duplicate", detectedAt: "2" },
		]);
		await writeToolsOnlyManifest(
			source,
			"4.0.0",
			'[{ "name": "domain_note", "path": "tools/domain-note.ts" }, { "name": "additional", "path": "tools/additional.ts" }]',
		);
		preview = await previewGjcBundleUpdate({ cwd }, identity);
		expect(preview.ok).toBe(true);
		if (!preview.ok) throw new Error(preview.error.code);
		expect(await applyGjcBundleUpdate({ cwd }, preview.value.token)).toMatchObject({ ok: true });
		const registry = await readRegistry("project", cwd);
		// Quarantine is recomputed against the candidate rather than carried
		// forward, so a surface the update fixes must come back clean instead of
		// staying permanently blocked by a stale record.
		expect(registry.plugins[0]?.quarantine ?? []).toEqual([]);
		const reconciled = await summary(cwd, identity);
		expect(reconciled.quarantined).toBe(false);
		expect(reconciled.surfaces.every(surface => !surface.quarantined)).toBe(true);
	});

	test("blocks quarantined enables but always permits de-escalating disables", async () => {
		const cwd = await mkProjectCwd();
		const identity = await install(cwd, "project");
		const surfaceId = (await summary(cwd, identity)).surfaces[0]?.extensionId;
		expect(surfaceId).toBeDefined();
		if (!surfaceId) throw new Error("missing surface");
		await injectQuarantine(cwd, identity, [
			{ surfaceId, code: "runtime_mismatch", message: "bad", detectedAt: "now" },
		]);
		expect(await setGjcBundleEnabled({ cwd }, identity, true)).toMatchObject({
			ok: false,
			error: { code: "quarantined" },
		});
		expect(await setGjcBundleSurfaceEnabled({ cwd }, identity, surfaceId, true)).toMatchObject({
			ok: false,
			error: { code: "quarantined" },
		});
		expect(await setGjcBundleEnabled({ cwd }, identity, false)).toMatchObject({ ok: true, value: { mutated: true } });
		expect(await setGjcBundleSurfaceEnabled({ cwd }, identity, surfaceId, false)).toMatchObject({
			ok: true,
			value: { mutated: true },
		});
	});

	test("rejects forged runtime evidence rather than treating it as a clear current snapshot", () => {
		const project = bundleIdentity("project", "same-name");
		const user = bundleIdentity("user", "same-name");
		expect(findingsForBundle(undefined, project, 7)).toEqual({ status: "unavailable" });
		expect(
			findingsForBundle(
				{ current: () => ({ status: "current", snapshot: { generation: 6, findings: [] } }) },
				project,
				7,
			),
		).toEqual({ status: "unavailable" });
		expect(
			findingsForBundle(
				{
					current: () => ({
						status: "current",
						snapshot: {
							generation: 7,
							findings: [{ identity: user, surfaceId: "tool", code: "runtime_mismatch", message: "forged" }],
						},
					}),
				},
				project,
				7,
			),
		).toEqual({ status: "current", findings: [] });
	});

	test("redacts hostile stored locators from locator output and serialized summaries", async () => {
		const cwd = await mkProjectCwd();
		const identity = await install(cwd, "project");
		const registry = await readRegistry("project", cwd);
		const entry = registry.plugins.find(plugin => plugin.name === identity.name);
		expect(entry).toBeDefined();
		if (!entry) throw new Error("missing entry");
		const hostile = [
			"https://user:tok@h/o/r.git?a=1#f",
			"git@h:o/r.git",
			path.join(os.homedir(), "literal-home", "plugin"),
			"https://user%3Atok@h/o/r.git",
		];
		for (const uri of hostile) {
			const source = {
				...entry.source,
				uri,
				kind: uri.startsWith("https") || uri.startsWith("git@") ? ("git" as const) : ("path" as const),
			};
			const serialized = JSON.stringify(toBundleSummary({ ...entry, source }));
			for (const secret of [
				"user:tok",
				"tok@",
				"?a=1",
				"#f",
				os.homedir(),
				"user%3Atok",
				"pluginRoot",
				"manifestPath",
				"copiedFiles",
			]) {
				expect(serialized).not.toContain(secret);
			}
			expect(redactSourceLocator(source)).not.toContain("tok");
		}
	});

	test("serializes concurrent applies and toggles into a parseable legal state", async () => {
		const cwd = await mkProjectCwd();
		const source = await mkSource();
		const identity = await install(cwd, "project", source);
		await fs.appendFile(path.join(source, "prompts", "system-appendix.md"), "concurrent update\n");
		const preview = await previewGjcBundleUpdate({ cwd }, identity);
		expect(preview.ok).toBe(true);
		if (!preview.ok) throw new Error(preview.error.code);
		const applied = await Promise.all([
			applyGjcBundleUpdate({ cwd }, preview.value.token),
			applyGjcBundleUpdate({ cwd }, preview.value.token),
		]);
		expect(applied.filter(result => result.ok && result.value.status === "updated")).toHaveLength(1);
		expect(applied.filter(result => !result.ok && result.error.code === "stale_baseline")).toHaveLength(1);

		const toggles = await Promise.all([
			setGjcBundleEnabled({ cwd }, identity, false),
			setGjcBundleEnabled({ cwd }, identity, true),
		]);
		expect(toggles.every(result => result.ok)).toBe(true);
		const finalSummary = await summary(cwd, identity);
		expect([true, false]).toContain(finalSummary.enabled);
		const registryText = await fs.readFile(registryPathForScope("project", cwd), "utf8");
		expect(JSON.parse(registryText).plugins).toHaveLength(1);
		expect(
			(await listGjcBundles({ cwd })).find(bundle => bundle.identity.scope === "project")?.targetFingerprint,
		).toBe(finalSummary.targetFingerprint);
	});
});
