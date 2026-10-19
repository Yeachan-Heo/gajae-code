import * as fs from "node:fs/promises";
import * as path from "node:path";

export type NativeBuildProfile = "local" | "ci" | "dist";

type ArtifactManifest = {
	schema?: string;
	version?: string;
	artifacts?: Record<string, string>;
};

function manifestHasArtifact(
	manifest: ArtifactManifest | undefined,
	version: string,
	addon: string,
	digest: string,
): boolean {
	return (
		manifest?.schema === "gjc.diagnostic-artifact" &&
		manifest.version === version &&
		manifest.artifacts?.[addon] === digest
	);
}

/**
 * Verify an addon against the manifest appropriate to its build profile and return
 * the verified digest for inclusion in a compiled binary's diagnostic trust record.
 * Local addons are admitted only for explicit embedding builds and only when their
 * bytes match the gitignored local manifest.
 */
export async function verifyDiagnosticArtifactDigest(options: {
	addonPath: string;
	nativeDir: string;
	version: string;
	allowLocalBuilds: boolean;
}): Promise<string> {
	const { addonPath, nativeDir, version, allowLocalBuilds } = options;
	const addon = path.basename(addonPath);
	const metadataPath = `${addonPath}.build.json`;
	const metadata = (await Bun.file(metadataPath).exists())
		? ((await Bun.file(metadataPath).json()) as { profile?: string; version?: string })
		: undefined;
	const localBuild = metadata?.profile === "local";
	if (localBuild && !allowLocalBuilds) {
		throw new Error(`${addon} is a local build and is not eligible for trusted verification`);
	}
	if (localBuild && metadata.version !== undefined && metadata.version !== version) {
		throw new Error(
			`${addon} is a local build for @gajae-code/natives@${metadata.version}; rebuild it for @gajae-code/natives@${version} before embedding`,
		);
	}

	const manifestPath = path.join(
		nativeDir,
		localBuild ? "diagnostic-artifact.local.json" : "diagnostic-artifact.json",
	);
	if (!(await Bun.file(manifestPath).exists())) {
		throw new Error(`${addon} has no ${localBuild ? "local" : "trusted"} diagnostic artifact manifest`);
	}
	const manifest = (await Bun.file(manifestPath).json()) as ArtifactManifest;
	if (manifest.schema !== "gjc.diagnostic-artifact" || manifest.version !== version) {
		throw new Error(
			`${addon} has an invalid or stale ${localBuild ? "local" : "trusted"} diagnostic artifact manifest`,
		);
	}
	const expected = manifest.artifacts?.[addon];
	if (typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected)) {
		throw new Error(`${addon} has no usable ${localBuild ? "local" : "trusted"} diagnostic artifact digest`);
	}
	const actual = new Bun.CryptoHasher("sha256").update(await Bun.file(addonPath).bytes()).digest("hex");
	if (actual !== expected) {
		throw new Error(
			`${addon} bytes do not match the ${localBuild ? "local" : "trusted"} digest (${actual} != ${expected})`,
		);
	}
	if (localBuild && metadata.version === undefined) {
		const trustedManifestPath = path.join(nativeDir, "diagnostic-artifact.json");
		const trustedManifest = (await Bun.file(trustedManifestPath).exists())
			? ((await Bun.file(trustedManifestPath).json()) as ArtifactManifest)
			: undefined;
		if (!manifestHasArtifact(trustedManifest, version, addon, actual)) {
			throw new Error(
				`${addon} is an unversioned local build without a matching @gajae-code/natives@${version} trusted record; rebuild it before embedding`,
			);
		}
	}
	return expected;
}

/**
 * Record the digest for the native build. Local builds use a gitignored manifest;
 * CI and distribution builds update the package-owned trusted manifest and emit the
 * provenance sidecars consumed by the release packaging pipeline.
 */
export async function recordDiagnosticArtifactDigest(options: {
	addonPath: string;
	nativeDir: string;
	packageJsonPath: string;
	profile: NativeBuildProfile;
}): Promise<void> {
	const { addonPath, nativeDir, packageJsonPath, profile } = options;
	const addon = path.basename(addonPath);
	const localBuild = profile === "local";
	const manifestPath = path.join(
		nativeDir,
		localBuild ? "diagnostic-artifact.local.json" : "diagnostic-artifact.json",
	);
	const digest = new Bun.CryptoHasher("sha256").update(await Bun.file(addonPath).bytes()).digest("hex");
	const existing = (await Bun.file(manifestPath).exists())
		? ((await Bun.file(manifestPath).json()) as ArtifactManifest)
		: {};
	const { version } = (await Bun.file(packageJsonPath).json()) as { version: string };
	const artifacts = !localBuild && existing.version === version ? { ...(existing.artifacts ?? {}) } : {};
	const currentLocalManifest =
		localBuild && existing.schema === "gjc.diagnostic-artifact" && existing.version === version;
	if (
		currentLocalManifest &&
		(typeof existing.artifacts !== "object" || existing.artifacts === null || Array.isArray(existing.artifacts))
	) {
		throw new Error(
			"current local diagnostic artifact manifest has an invalid artifacts map; refusing to rebuild variants",
		);
	}
	const currentLocalArtifacts = currentLocalManifest ? (existing.artifacts as Record<string, string>) : undefined;
	// Rebuild the local manifest from current-version addons so stale entries from earlier manifests
	// cannot survive a package bump. Never re-hash a peer variant already committed by a current
	// local manifest; legacy sidecars without a version need an exact current-version digest proof.
	if (localBuild) {
		const trustedManifestPath = path.join(nativeDir, "diagnostic-artifact.json");
		const trustedManifest = (await Bun.file(trustedManifestPath).exists())
			? ((await Bun.file(trustedManifestPath).json()) as ArtifactManifest)
			: undefined;
		const entries = await fs.readdir(nativeDir);
		for (const entry of entries) {
			if (!entry.endsWith(".node")) continue;
			const variantPath = path.join(nativeDir, entry);
			const sidecarPath = `${variantPath}.build.json`;
			const sidecar = (await Bun.file(sidecarPath).exists())
				? ((await Bun.file(sidecarPath).json()) as { profile?: string; version?: string })
				: undefined;
			if (sidecar?.profile !== "local") continue;
			const variantDigest = new Bun.CryptoHasher("sha256").update(await Bun.file(variantPath).bytes()).digest("hex");
			const recordedDigest = currentLocalArtifacts?.[entry];
			if (entry !== addon && recordedDigest !== undefined && recordedDigest !== variantDigest) {
				throw new Error(
					`${entry} bytes do not match the existing local diagnostic artifact digest; rebuild it before rebuilding another variant`,
				);
			}
			const currentVersion =
				sidecar.version === version ||
				(sidecar.version === undefined &&
					(recordedDigest === variantDigest ||
						manifestHasArtifact(trustedManifest, version, entry, variantDigest)));
			if (currentVersion && entry !== addon) {
				artifacts[entry] = variantDigest;
			}
		}
	}
	artifacts[addon] = digest;
	await Bun.write(
		manifestPath,
		`${JSON.stringify({ schema: "gjc.diagnostic-artifact", version, artifacts }, null, 2)}\n`,
	);

	if (localBuild) {
		// A prior CI build may have left provenance beside this same addon filename.
		await fs.rm(`${addonPath}.provenance.json`, { force: true });
	} else {
		// Release addons travel to other checkouts as bare `.node` uploads, so the digest
		// travels beside each artifact and `scripts/verify-diagnostic-artifact-provenance.ts`
		// rebuilds the trusted record there from these sidecars.
		await Bun.write(
			`${addonPath}.provenance.json`,
			`${JSON.stringify(
				{
					schema: "gjc.diagnostic-artifact-provenance",
					version,
					artifact: path.basename(addonPath),
					sha256: digest,
				},
				null,
				2,
			)}\n`,
		);
	}

	console.log(
		`Recorded ${localBuild ? "local " : "trusted "}diagnostic artifact digest for ${path.basename(addonPath)}`,
	);
}
