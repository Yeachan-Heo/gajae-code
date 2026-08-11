import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { deriveNightlyVersion, NIGHTLY_VERSION_PATTERN, stageNightlyVersion, stageStableVersion } from "./nightly-release";
import { PUBLIC_PACKAGE_DEFINITIONS } from "./release-evidence";

const temporaryRoots: string[] = [];
const sourceSha = "abcdef0123456789abcdef0123456789abcdef01";
const nightlyVersion = "1.2.4-nightly.20260805032109.123456.gabcdef012345";

async function fixture(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-nightly-release-"));
	temporaryRoots.push(root);
	const catalog = Object.fromEntries(
		PUBLIC_PACKAGE_DEFINITIONS
			.filter(definition => definition.name.startsWith("@gajae-code/"))
			.map(definition => [definition.name, "1.2.3"]),
	);
	await Bun.write(path.join(root, "package.json"), `${JSON.stringify({ workspaces: { catalog } }, null, 2)}\n`);
	for (const definition of PUBLIC_PACKAGE_DEFINITIONS) {
		await fs.mkdir(path.join(root, definition.dir), { recursive: true });
		await Bun.write(
			path.join(root, definition.dir, "package.json"),
			`${JSON.stringify({ name: definition.name, version: "1.2.3" }, null, "\t")}\n`,
		);
	}

	const crateNames = ["gjc-sdk", "pi-ast", "pi-iso", "pi-natives", "pi-shell"];
	await Bun.write(path.join(root, "Cargo.toml"), '[workspace]\nmembers = ["crates/*"]\n\n[workspace.package]\nversion = "1.2.3"\n');
	await Bun.write(
		path.join(root, "Cargo.lock"),
		crateNames.map(name => `[[package]]\nname = "${name}"\nversion = "1.2.3"\n`).join("\n"),
	);
	for (const name of crateNames) {
		const crateDir = path.join(root, "crates", name);
		await fs.mkdir(crateDir, { recursive: true });
		await Bun.write(path.join(crateDir, "Cargo.toml"), `[package]\nname = "${name}"\nversion.workspace = true\n`);
	}
	await fs.mkdir(path.join(root, "crates/pi-natives/src"), { recursive: true });
	await Bun.write(path.join(root, "crates/pi-natives/src/lib.rs"), '#[napi(js_name = "__piNativesV1_2_3")]\npub const fn sentinel() {}\n');
	await fs.mkdir(path.join(root, "packages/natives/native"), { recursive: true });
	await Bun.write(path.join(root, "packages/natives/native/index.d.ts"), "export declare function __piNativesV1_2_3(): void\n");
	await Bun.write(path.join(root, "packages/natives/native/index.js"), "export const __piNativesV1_2_3 = native.__piNativesV1_2_3;\n");
	return root;
}

afterAll(async () => {
	await Promise.all(temporaryRoots.map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("nightly release versioning", () => {
	test("derives the next patch with immutable UTC, run, and source identity", () => {
		const version = deriveNightlyVersion(
			["1.2.3", "1.2.8", "1.2.7"],
			new Date("2026-08-05T03:21:09.999Z"),
			"123456",
			sourceSha,
		);

		expect(version).toBe("1.2.9-nightly.20260805032109.123456.gabcdef012345");
		expect(NIGHTLY_VERSION_PATTERN.test(version)).toBe(true);
	});

	test("rejects mixed stable lines and malformed run identity", () => {
		expect(() => deriveNightlyVersion(["1.2.3", "1.3.0"], new Date(), "1", sourceSha)).toThrow("major/minor");
		expect(() => deriveNightlyVersion(["1.2.3"], new Date(), "01", sourceSha)).toThrow("Run id");
		expect(() => deriveNightlyVersion(["1.2.3"], new Date(), "1", "A".repeat(40))).toThrow("lowercase hexadecimal");
	});

	test("stages every public package, catalog edge, Cargo version, lock entry, and native sentinel", async () => {
		const root = await fixture();
		const changed = await stageNightlyVersion(root, nightlyVersion, sourceSha);

		expect(changed).toContain("package.json");
		expect(changed).toContain("Cargo.toml");
		expect(changed).toContain("Cargo.lock");
		expect(changed).toContain("crates/pi-natives/src/lib.rs");
		for (const definition of PUBLIC_PACKAGE_DEFINITIONS) {
			const manifest = await Bun.file(path.join(root, definition.dir, "package.json")).json() as { version: string };
			expect(manifest.version).toBe(nightlyVersion);
		}
		const rootManifest = await Bun.file(path.join(root, "package.json")).json() as { workspaces: { catalog: Record<string, string> } };
		for (const definition of PUBLIC_PACKAGE_DEFINITIONS.filter(candidate => candidate.name.startsWith("@gajae-code/"))) {
			expect(rootManifest.workspaces.catalog[definition.name]).toBe(nightlyVersion);
		}
		expect(await Bun.file(path.join(root, "Cargo.toml")).text()).toContain(`version = "${nightlyVersion}"`);
		expect((await Bun.file(path.join(root, "Cargo.lock")).text()).match(new RegExp(nightlyVersion.replaceAll(".", "\\."), "gu"))).toHaveLength(5);
		const sentinel = "__piNativesV1_2_4_nightly_20260805032109_123456_gabcdef012345";
		for (const relativePath of ["crates/pi-natives/src/lib.rs", "packages/natives/native/index.d.ts", "packages/natives/native/index.js"]) {
			expect(await Bun.file(path.join(root, relativePath)).text()).toContain(sentinel);
		}
	});

	test("rejects a source/version mismatch before mutating files", async () => {
		const root = await fixture();
		const before = await Bun.file(path.join(root, "packages/ai/package.json")).text();
		await expect(stageNightlyVersion(root, nightlyVersion, "0".repeat(40))).rejects.toThrow("source suffix");
		expect(await Bun.file(path.join(root, "packages/ai/package.json")).text()).toBe(before);
	});
	test("derives the next minor (patch reset to 0) with bumpKind=minor", () => {
		const version = deriveNightlyVersion(
			["0.12.21"],
			new Date("2026-08-05T03:21:09.999Z"),
			"123456",
			sourceSha,
			"minor",
		);

		expect(version).toBe("0.13.0-nightly.20260805032109.123456.gabcdef012345");
		expect(NIGHTLY_VERSION_PATTERN.test(version)).toBe(true);
	});

	test("minor derive ignores the highest patch (patch resets to 0 across mixed patches)", () => {
		const version = deriveNightlyVersion(
			["1.2.3", "1.2.8"],
			new Date("2026-08-05T03:21:09.999Z"),
			"123456",
			sourceSha,
			"minor",
		);

		expect(version).toBe("1.3.0-nightly.20260805032109.123456.gabcdef012345");
	});

	test("omitting bumpKind equals explicit patch (back-compat default)", () => {
		const explicitPatch = deriveNightlyVersion(["1.2.3"], new Date("2026-08-05T03:21:09.999Z"), "123456", sourceSha, "patch");
		const defaultBump = deriveNightlyVersion(["1.2.3"], new Date("2026-08-05T03:21:09.999Z"), "123456", sourceSha);

		expect(defaultBump).toBe(explicitPatch);
		expect(defaultBump).toBe("1.2.4-nightly.20260805032109.123456.gabcdef012345");
	});

	test("rejects invalid bumpKind values", () => {
		expect(() => deriveNightlyVersion(["1.2.3"], new Date(), "1", sourceSha, "major" as never)).toThrow("bump kind");
		expect(() => deriveNightlyVersion(["1.2.3"], new Date(), "1", sourceSha, "preview" as never)).toThrow("bump kind");
	});

	test("stageStableVersion stages every public package, catalog edge, Cargo version, lock entry, and native sentinel", async () => {
		const root = await fixture();
		const stableVersion = "1.3.0";
		const changed = await stageStableVersion(root, stableVersion, sourceSha);

		expect(changed).toContain("package.json");
		expect(changed).toContain("Cargo.toml");
		expect(changed).toContain("Cargo.lock");
		expect(changed).toContain("crates/pi-natives/src/lib.rs");
		for (const definition of PUBLIC_PACKAGE_DEFINITIONS) {
			const manifest = await Bun.file(path.join(root, definition.dir, "package.json")).json() as { version: string };
			expect(manifest.version).toBe(stableVersion);
		}
		const rootManifest = await Bun.file(path.join(root, "package.json")).json() as { workspaces: { catalog: Record<string, string> } };
		for (const definition of PUBLIC_PACKAGE_DEFINITIONS.filter(candidate => candidate.name.startsWith("@gajae-code/"))) {
			expect(rootManifest.workspaces.catalog[definition.name]).toBe(stableVersion);
		}
		expect(await Bun.file(path.join(root, "Cargo.toml")).text()).toContain(`version = "${stableVersion}"`);
		expect((await Bun.file(path.join(root, "Cargo.lock")).text()).match(new RegExp(stableVersion.replaceAll(".", "\\."), "gu"))).toHaveLength(5);
		const sentinel = "__piNativesV1_3_0";
		for (const relativePath of ["crates/pi-natives/src/lib.rs", "packages/natives/native/index.d.ts", "packages/natives/native/index.js"]) {
			expect(await Bun.file(path.join(root, relativePath)).text()).toContain(sentinel);
		}
	});

	test("stageStableVersion rejects a non-monotonic (downgrade or same) target before mutating files", async () => {
		const root = await fixture();
		const before = await Bun.file(path.join(root, "packages/ai/package.json")).text();
		await expect(stageStableVersion(root, "1.2.3", sourceSha)).rejects.toThrow("not strictly before");
		await expect(stageStableVersion(root, "1.0.0", sourceSha)).rejects.toThrow("not strictly before");
		expect(await Bun.file(path.join(root, "packages/ai/package.json")).text()).toBe(before);
	});

	test("stageStableVersion rejects nightly-suffixed targets (validates stableVersionPattern, not the nightly suffix assert)", async () => {
		const root = await fixture();
		const nightlySuffixed = "1.3.0-nightly.20260805032109.123456.gabcdef012345";
		await expect(stageStableVersion(root, nightlySuffixed, sourceSha)).rejects.toThrow("Invalid stable version");
	});

	test("stage-stable CLI mode rejects --bump-kind (mode-boundary isolation)", async () => {
		const { exitCode, stderr } = Bun.spawnSync(["bun", "scripts/nightly-release.ts", "stage-stable", "--version", "1.3.0", "--source-sha", sourceSha, "--bump-kind", "minor"], {
			cwd: path.join(import.meta.dir, ".."),
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(exitCode).toBe(1);
		expect(stderr.toString()).toContain("Expected exactly");
	});

	test("stage CLI mode rejects --bump-kind (mode-boundary isolation)", async () => {
		const { exitCode, stderr } = Bun.spawnSync(["bun", "scripts/nightly-release.ts", "stage", "--version", nightlyVersion, "--source-sha", sourceSha, "--bump-kind", "minor"], {
			cwd: path.join(import.meta.dir, ".."),
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(exitCode).toBe(1);
		expect(stderr.toString()).toContain("Expected exactly");
	});
});
