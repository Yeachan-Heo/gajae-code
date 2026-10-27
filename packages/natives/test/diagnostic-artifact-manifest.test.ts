import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	recordDiagnosticArtifactDigest,
	verifyDiagnosticArtifactDigest,
} from "../scripts/diagnostic-artifact-manifest";

const tempDirs: string[] = [];
const repoRoot = path.join(import.meta.dir, "../../..");

async function createBuildFixture() {
	const nativeDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-native-manifest-"));
	tempDirs.push(nativeDir);
	const packageJsonPath = path.join(nativeDir, "package.json");
	const manifestPath = path.join(nativeDir, "diagnostic-artifact.json");
	const addonPath = path.join(nativeDir, "pi_natives.linux-x64-modern.node");
	await Bun.write(packageJsonPath, JSON.stringify({ version: "1.0.0" }));
	await Bun.write(
		manifestPath,
		`${JSON.stringify(
			{
				schema: "gjc.diagnostic-artifact",
				version: "1.0.0",
				artifacts: {
					"pi_natives.darwin-arm64.node": "darwin-release-digest",
					"pi_natives.linux-x64-modern.node": "previous-local-digest",
				},
			},
			null,
			2,
		)}\n`,
	);
	await Bun.write(addonPath, "locally built addon bytes");
	return { addonPath, manifestPath, nativeDir, packageJsonPath };
}

afterEach(async () => {
	for (const dir of tempDirs.splice(0, tempDirs.length)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("a local native build keeps the tracked manifest unchanged and stores only its local digest", async () => {
	const fixture = await createBuildFixture();
	const originalManifest = await Bun.file(fixture.manifestPath).text();
	await Bun.write(`${fixture.addonPath}.provenance.json`, "stale CI provenance");

	await recordDiagnosticArtifactDigest({ ...fixture, profile: "local" });

	expect(await Bun.file(fixture.manifestPath).text()).toBe(originalManifest);
	const localManifest = (await Bun.file(path.join(fixture.nativeDir, "diagnostic-artifact.local.json")).json()) as {
		schema: string;
		version: string;
		artifacts: Record<string, string>;
	};
	const digest = new Bun.CryptoHasher("sha256").update(await Bun.file(fixture.addonPath).bytes()).digest("hex");
	expect(localManifest).toEqual({
		schema: "gjc.diagnostic-artifact",
		version: "1.0.0",
		artifacts: { "pi_natives.linux-x64-modern.node": digest },
	});
	expect(await Bun.file(`${fixture.addonPath}.provenance.json`).exists()).toBe(false);
});

test.each(["ci", "dist"] as const)("a %s native build updates the trusted manifest and provenance", async profile => {
	const fixture = await createBuildFixture();
	const before = (await Bun.file(fixture.manifestPath).json()) as {
		artifacts: Record<string, string>;
	};
	const digest = new Bun.CryptoHasher("sha256").update(await Bun.file(fixture.addonPath).bytes()).digest("hex");

	await recordDiagnosticArtifactDigest({ ...fixture, profile });

	const manifest = (await Bun.file(fixture.manifestPath).json()) as {
		schema: string;
		version: string;
		artifacts: Record<string, string>;
	};
	expect(manifest).toEqual({
		schema: "gjc.diagnostic-artifact",
		version: "1.0.0",
		artifacts: {
			...before.artifacts,
			"pi_natives.linux-x64-modern.node": digest,
		},
	});
	const provenance = (await Bun.file(`${fixture.addonPath}.provenance.json`).json()) as {
		schema: string;
		version: string;
		artifact: string;
		sha256: string;
	};
	expect(provenance).toEqual({
		schema: "gjc.diagnostic-artifact-provenance",
		version: "1.0.0",
		artifact: "pi_natives.linux-x64-modern.node",
		sha256: digest,
	});
});

test("bootstrapping a new local manifest includes pre-existing local variants on disk", async () => {
	const nativeDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-native-migration-"));
	tempDirs.push(nativeDir);
	const packageJsonPath = path.join(nativeDir, "package.json");
	const modernAddonPath = path.join(nativeDir, "pi_natives.linux-x64-modern.node");
	const baselineAddonPath = path.join(nativeDir, "pi_natives.linux-x64-baseline.node");

	await Bun.write(packageJsonPath, JSON.stringify({ version: "2.0.0" }));
	await Bun.write(modernAddonPath, "modern addon bytes");
	await Bun.write(baselineAddonPath, "baseline addon bytes");
	await Bun.write(`${modernAddonPath}.build.json`, JSON.stringify({ profile: "local", version: "2.0.0" }));
	await Bun.write(`${baselineAddonPath}.build.json`, JSON.stringify({ profile: "local", version: "2.0.0" }));

	// Record the modern addon; the local manifest doesn't exist yet.
	await recordDiagnosticArtifactDigest({
		addonPath: modernAddonPath,
		nativeDir,
		packageJsonPath,
		profile: "local",
	});

	// Verify the local manifest includes both variants.
	const localManifest = (await Bun.file(path.join(nativeDir, "diagnostic-artifact.local.json")).json()) as {
		schema: string;
		version: string;
		artifacts: Record<string, string>;
	};
	const modernDigest = new Bun.CryptoHasher("sha256").update(await Bun.file(modernAddonPath).bytes()).digest("hex");
	const baselineDigest = new Bun.CryptoHasher("sha256")
		.update(await Bun.file(baselineAddonPath).bytes())
		.digest("hex");

	expect(localManifest).toEqual({
		schema: "gjc.diagnostic-artifact",
		version: "2.0.0",
		artifacts: {
			"pi_natives.linux-x64-modern.node": modernDigest,
			"pi_natives.linux-x64-baseline.node": baselineDigest,
		},
	});
});

test("rebuilding a local variant refuses to re-authorize modified peer bytes", async () => {
	const nativeDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-native-peer-digest-"));
	tempDirs.push(nativeDir);
	const packageJsonPath = path.join(nativeDir, "package.json");
	const modernAddonPath = path.join(nativeDir, "pi_natives.linux-x64-modern.node");
	const baselineAddonPath = path.join(nativeDir, "pi_natives.linux-x64-baseline.node");
	const localManifestPath = path.join(nativeDir, "diagnostic-artifact.local.json");

	await Bun.write(packageJsonPath, JSON.stringify({ version: "2.0.0" }));
	await Bun.write(modernAddonPath, "modern addon bytes");
	await Bun.write(baselineAddonPath, "baseline addon bytes");
	await Bun.write(`${modernAddonPath}.build.json`, JSON.stringify({ profile: "local", version: "2.0.0" }));
	await Bun.write(`${baselineAddonPath}.build.json`, JSON.stringify({ profile: "local", version: "2.0.0" }));

	await recordDiagnosticArtifactDigest({
		addonPath: modernAddonPath,
		nativeDir,
		packageJsonPath,
		profile: "local",
	});

	await Bun.write(modernAddonPath, "rebuilt modern addon bytes");
	await recordDiagnosticArtifactDigest({
		addonPath: modernAddonPath,
		nativeDir,
		packageJsonPath,
		profile: "local",
	});
	const rebuiltManifest = (await Bun.file(localManifestPath).json()) as { artifacts: Record<string, string> };
	expect(rebuiltManifest.artifacts["pi_natives.linux-x64-modern.node"]).toBe(
		new Bun.CryptoHasher("sha256").update("rebuilt modern addon bytes").digest("hex"),
	);
	expect(rebuiltManifest.artifacts["pi_natives.linux-x64-baseline.node"]).toBe(
		new Bun.CryptoHasher("sha256").update("baseline addon bytes").digest("hex"),
	);
	const manifestBefore = await Bun.file(localManifestPath).text();

	await Bun.write(baselineAddonPath, "modified baseline addon bytes");
	await expect(
		recordDiagnosticArtifactDigest({
			addonPath: modernAddonPath,
			nativeDir,
			packageJsonPath,
			profile: "local",
		}),
	).rejects.toThrow(
		"pi_natives.linux-x64-baseline.node bytes do not match the existing local diagnostic artifact digest",
	);
	expect(await Bun.file(localManifestPath).text()).toBe(manifestBefore);
});

test("legacy local variants migrate only when the current trusted record proves their version", async () => {
	const nativeDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-native-legacy-migration-"));
	tempDirs.push(nativeDir);
	const packageJsonPath = path.join(nativeDir, "package.json");
	const modernAddonPath = path.join(nativeDir, "pi_natives.linux-x64-modern.node");
	const baselineAddonPath = path.join(nativeDir, "pi_natives.linux-x64-baseline.node");
	const baselineName = path.basename(baselineAddonPath);

	await Bun.write(packageJsonPath, JSON.stringify({ version: "2.0.0" }));
	await Bun.write(modernAddonPath, "modern addon bytes");
	await Bun.write(baselineAddonPath, "legacy baseline addon bytes");
	await Bun.write(`${modernAddonPath}.build.json`, JSON.stringify({ profile: "local", version: "2.0.0" }));
	await Bun.write(`${baselineAddonPath}.build.json`, JSON.stringify({ profile: "local" }));
	const baselineDigest = new Bun.CryptoHasher("sha256")
		.update(await Bun.file(baselineAddonPath).bytes())
		.digest("hex");
	await Bun.write(
		path.join(nativeDir, "diagnostic-artifact.json"),
		JSON.stringify({
			schema: "gjc.diagnostic-artifact",
			version: "2.0.0",
			artifacts: { [baselineName]: baselineDigest },
		}),
	);

	await recordDiagnosticArtifactDigest({
		addonPath: modernAddonPath,
		nativeDir,
		packageJsonPath,
		profile: "local",
	});

	const localManifest = (await Bun.file(path.join(nativeDir, "diagnostic-artifact.local.json")).json()) as {
		artifacts: Record<string, string>;
	};
	expect(localManifest.artifacts[baselineName]).toBe(baselineDigest);
	expect(
		await verifyDiagnosticArtifactDigest({
			addonPath: baselineAddonPath,
			nativeDir,
			version: "2.0.0",
			allowLocalBuilds: true,
		}),
	).toBe(baselineDigest);
});

test("a version bump does not migrate stale local variants into the new manifest", async () => {
	const nativeDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-native-stale-variant-"));
	tempDirs.push(nativeDir);
	const packageJsonPath = path.join(nativeDir, "package.json");
	const modernAddonPath = path.join(nativeDir, "pi_natives.linux-x64-modern.node");
	const baselineAddonPath = path.join(nativeDir, "pi_natives.linux-x64-baseline.node");

	await Bun.write(packageJsonPath, JSON.stringify({ version: "2.0.0" }));
	await Bun.write(modernAddonPath, "modern addon bytes");
	await Bun.write(baselineAddonPath, "baseline addon bytes");
	await Bun.write(`${modernAddonPath}.build.json`, JSON.stringify({ profile: "local", version: "2.0.0" }));
	await Bun.write(`${baselineAddonPath}.build.json`, JSON.stringify({ profile: "local", version: "1.0.0" }));
	const baselineDigest = new Bun.CryptoHasher("sha256")
		.update(await Bun.file(baselineAddonPath).bytes())
		.digest("hex");
	await Bun.write(
		path.join(nativeDir, "diagnostic-artifact.local.json"),
		JSON.stringify({
			schema: "gjc.diagnostic-artifact",
			version: "2.0.0",
			artifacts: { [path.basename(baselineAddonPath)]: baselineDigest },
		}),
	);

	await recordDiagnosticArtifactDigest({
		addonPath: modernAddonPath,
		nativeDir,
		packageJsonPath,
		profile: "local",
	});

	const localManifest = (await Bun.file(path.join(nativeDir, "diagnostic-artifact.local.json")).json()) as {
		artifacts: Record<string, string>;
	};
	expect(Object.keys(localManifest.artifacts)).toEqual(["pi_natives.linux-x64-modern.node"]);
});

test("verification rejects a local addon built for a different package version", async () => {
	const nativeDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-native-stale-build-"));
	tempDirs.push(nativeDir);
	const addonPath = path.join(nativeDir, "pi_natives.linux-x64-modern.node");
	const addonBytes = "stale local addon bytes";
	const digest = new Bun.CryptoHasher("sha256").update(addonBytes).digest("hex");

	await Bun.write(addonPath, addonBytes);
	await Bun.write(`${addonPath}.build.json`, JSON.stringify({ profile: "local", version: "1.0.0" }));
	await Bun.write(
		path.join(nativeDir, "diagnostic-artifact.local.json"),
		JSON.stringify({
			schema: "gjc.diagnostic-artifact",
			version: "2.0.0",
			artifacts: { [path.basename(addonPath)]: digest },
		}),
	);

	await expect(
		verifyDiagnosticArtifactDigest({
			addonPath,
			nativeDir,
			version: "2.0.0",
			allowLocalBuilds: true,
		}),
	).rejects.toThrow("local build for @gajae-code/natives@1.0.0");
});

test("verification rejects an unversioned local addon without a matching trusted record", async () => {
	const nativeDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-native-unversioned-build-"));
	tempDirs.push(nativeDir);
	const addonPath = path.join(nativeDir, "pi_natives.linux-x64-modern.node");
	const addonBytes = "unversioned local addon bytes";
	const digest = new Bun.CryptoHasher("sha256").update(addonBytes).digest("hex");

	await Bun.write(addonPath, addonBytes);
	await Bun.write(`${addonPath}.build.json`, JSON.stringify({ profile: "local" }));
	await Bun.write(
		path.join(nativeDir, "diagnostic-artifact.local.json"),
		JSON.stringify({
			schema: "gjc.diagnostic-artifact",
			version: "2.0.0",
			artifacts: { [path.basename(addonPath)]: digest },
		}),
	);

	await expect(
		verifyDiagnosticArtifactDigest({
			addonPath,
			nativeDir,
			version: "2.0.0",
			allowLocalBuilds: true,
		}),
	).rejects.toThrow("unversioned local build without a matching @gajae-code/natives@2.0.0 trusted record");
});

test("the local artifact manifest is ignored by git", () => {
	const localManifestPath = "packages/natives/native/diagnostic-artifact.local.json";
	const result = Bun.spawnSync(["git", "check-ignore", "--no-index", "--quiet", localManifestPath], {
		cwd: repoRoot,
	});
	expect(result.exitCode).toBe(0);
});
