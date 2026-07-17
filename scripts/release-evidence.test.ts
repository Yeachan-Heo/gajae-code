import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import {
	PUBLIC_PACKAGE_DEFINITIONS,
	RELEASE_TARBALL_LIMITS,
	assertStableFinalization,
	assertMonotonicLatestVersion,

	canonicalizePackageTarball,
	canonicalJsonBytes,

	classifyRegistryObservation,
	createExpectedEvidence,
	createFinalEvidence,
	expectedEvidenceSha256,
	createGoldenReleaseEvidence,

	inspectPackageTarball,
	packageEvidenceFromTarball,
	parseReleaseEvidenceCli,
	goldenReleaseEvidenceBytes,
	goldenReleaseEvidenceSha256,

	readExpectedEvidenceFile,
	sha512Sri,
	sha256,
	validateExpectedEvidence,
	validateExpectedTarball,
	verifyFinalEvidence,
	writeImmutableEvidence,
	type PackageEvidenceRecord,
	type ExpectedReleaseEvidence,
	type RegistryPackageObservation,
	type TarballLimits,
} from "./release-evidence";
import {
	downloadNpmRegistryTarball,
	publishRetainedPackage,
	assertReleaseSerializationGuard,
	parseReleasePublishCli,
	reobserveExpectedEvidencePackages,

	readRetainedTarball,
	retainTarball,
	validateNpmRegistryTarballUrl,
} from "./ci-release-publish";


function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
	const encoded = value.toString(8).padStart(length - 1, "0");
	header.write(encoded, offset, length - 1, "ascii");
	header[offset + length - 1] = 0;
}

function tarHeader(memberPath: string, data: Buffer, mode = 0o644): Buffer {
	const header = Buffer.alloc(512);
	header.write(memberPath, 0, "utf8");
	writeOctal(header, 100, 8, mode);
	writeOctal(header, 108, 8, 27);
	writeOctal(header, 116, 8, 42);
	writeOctal(header, 124, 12, data.length);
	writeOctal(header, 136, 12, 1_700_000_000);
	header.fill(0x20, 148, 156);
	header[156] = "0".charCodeAt(0);
	header.write("ustar", 257, "ascii");
	header[262] = 0;
	header.write("00", 263, "ascii");
	let checksum = 0;
	for (const byte of header) checksum += byte;
	header.write(checksum.toString(8).padStart(6, "0"), 148, "ascii");
	header[154] = 0;
	header[155] = 0x20;
	return header;
}

function fixtureTarballEntries(files: readonly { path: string; data: Buffer }[]): Buffer {
	const parts: Buffer[] = [];
	for (const file of files) {
		parts.push(tarHeader(file.path, file.data));
		parts.push(file.data);
		const padding = (512 - (file.data.length % 512)) % 512;
		if (padding > 0) parts.push(Buffer.alloc(padding));
	}
	parts.push(Buffer.alloc(1024));
	return Buffer.from(gzipSync(Buffer.concat(parts)));
}

function fixtureTarball(manifest: string): Buffer {
	return fixtureTarballEntries([
		{ path: "package/index.js", data: Buffer.from("export {};\n") },
		{ path: "package/package.json", data: Buffer.from(manifest, "utf8") },
	]);
}

function tarballLimits(overrides: Partial<TarballLimits>): TarballLimits {
	return { ...RELEASE_TARBALL_LIMITS, ...overrides };
}

function expectedRecord(definition: (typeof PUBLIC_PACKAGE_DEFINITIONS)[number], dependencies: Record<string, string> = {}): PackageEvidenceRecord {
	const manifest = `{"name":"${definition.name}","version":"1.2.3","dependencies":${JSON.stringify(dependencies)}}\n`;
	const tarball = canonicalizePackageTarball(fixtureTarball(manifest));
	return packageEvidenceFromTarball(definition, tarball);
}


function expectedFixture(): { records: PackageEvidenceRecord[]; expected: ExpectedReleaseEvidence } {
	const records = PUBLIC_PACKAGE_DEFINITIONS.map((definition, index) =>
		expectedRecord(definition, index === 3 ? { "@gajae-code/ai": "1.2.3" } : {}),
	);
	return {
		records,
		expected: createExpectedEvidence({
			sourceCommit: "a".repeat(40),
			releaseVersion: "1.2.3",
			packages: records,
		}),
	};
}

function observation(record: PackageEvidenceRecord): RegistryPackageObservation {
	return {
		registry_sri: record.expected_sri,
		registry_tarball_sha512: record.tarball_sha512,
		registry_manifest_sha256: record.manifest_sha256,
		registry_internal_dependencies: record.internal_dependencies,
		registry_latest_version: record.version,
	};
}

describe("release package evidence", () => {
	test("hashes the raw package/package.json bytes without parsing or normalizing them", () => {
		const rawManifest = "{\r\n  \"name\": \"@gajae-code/ai\",\r\n  \"version\": \"1.2.3\"\r\n}\r\n";
		const tarball = canonicalizePackageTarball(fixtureTarball(rawManifest));
		const inspection = inspectPackageTarball(tarball);
		const record = packageEvidenceFromTarball(PUBLIC_PACKAGE_DEFINITIONS[1]!, tarball);

		expect(inspection.manifestBytes.equals(Buffer.from(rawManifest))).toBe(true);
		expect(record.manifest_sha256).toBe(createHash("sha256").update(Buffer.from(rawManifest)).digest("hex"));
		expect(record.manifest_sha256).not.toBe(sha256(Buffer.from(`${JSON.stringify(JSON.parse(rawManifest))}\n`)));
		validateExpectedTarball(record, tarball);
	});

	test("rejects workspace, file, ranged, and stale internal dependency forms in every packed field", () => {
		const definition = PUBLIC_PACKAGE_DEFINITIONS.find(candidate => candidate.name === "@gajae-code/natives")!;
		const dependencyName = "@gajae-code/natives-linux-x64";
		const cases = [
			["dependencies", "workspace:*"],
			["devDependencies", "file:../natives-linux-x64"],
			["peerDependencies", "^1.2.3"],
			["optionalDependencies", "1.2.2"],
		] as const;
		for (const [field, spec] of cases) {
			const manifest = JSON.stringify({ name: definition.name, version: "1.2.3", [field]: { [dependencyName]: spec } });
			expect(() => packageEvidenceFromTarball(definition, fixtureTarball(manifest))).toThrow("exact release version");
		}
		const wrapper = PUBLIC_PACKAGE_DEFINITIONS.find(candidate => candidate.name === "gajae-code")!;
		expect(() => packageEvidenceFromTarball(wrapper, fixtureTarball(JSON.stringify({
			name: wrapper.name,
			version: "1.2.3",
			dependencies: { "@gajae-code/coding-agent": "catalog:" },
		})))).toThrow("exact release version");
	});
	test("rejects unknown owned internal names before registry or publish callbacks", async () => {
		const definition = PUBLIC_PACKAGE_DEFINITIONS.find(candidate => candidate.name === "@gajae-code/natives")!;
		for (const dependencyName of ["@gajae-code/unknown-owned", "@gajae-code-sync-sandbox/unknown-owned"]) {
			const manifest = JSON.stringify({
				name: definition.name,
				version: "1.2.3",
				devDependencies: { [dependencyName]: "1.2.3" },
			});
			expect(() => packageEvidenceFromTarball(definition, fixtureTarball(manifest))).toThrow("unknown owned internal dependency");
		}

		const { records } = expectedFixture();
		const record = records[0]!;
		const unknownOwnedTarball = canonicalizePackageTarball(fixtureTarball(JSON.stringify({
			name: record.name,
			version: record.version,
			devDependencies: { "@gajae-code/unknown-owned": record.version },
		})));
		let callbacks = 0;
		await expect(publishRetainedPackage(record, "retained.tgz", {
			readTarball: async () => unknownOwnedTarball,
			observe: async () => {
				callbacks += 1;
				return undefined;
			},
			publish: async () => {
				callbacks += 1;
				return { exitCode: 0, output: "" };
			},
		})).rejects.toThrow("unknown owned internal dependency");
		expect(callbacks).toBe(0);
	});


	test("bounds compressed, unpacked, per-entry, and file-count tarball resources", () => {
		const manifest = Buffer.from('{"name":"@gajae-code/ai","version":"1.2.3"}\n');
		const normal = fixtureTarballEntries([
			{ path: "package/index.js", data: Buffer.from("export {};\n") },
			{ path: "package/package.json", data: manifest },
		]);
		expect(() => inspectPackageTarball(normal, tarballLimits({ maxCompressedBytes: normal.length - 1 }))).toThrow("compressed size");

		const largeEntry = fixtureTarballEntries([
			{ path: "package/index.js", data: Buffer.alloc(512) },
			{ path: "package/package.json", data: manifest },
		]);
		expect(() => inspectPackageTarball(largeEntry, tarballLimits({ maxUnpackedBytes: 10_000, maxEntryBytes: 128 }))).toThrow("exceeds 128");

		const manyFiles = fixtureTarballEntries([
			{ path: "package/index.js", data: Buffer.from("a") },
			{ path: "package/extra.js", data: Buffer.from("b") },
			{ path: "package/package.json", data: manifest },
		]);
		expect(() => inspectPackageTarball(manyFiles, tarballLimits({ maxUnpackedBytes: 10_000, maxEntryBytes: 10_000, maxFileCount: 2 }))).toThrow("more than 2 files");

		const expanded = fixtureTarballEntries([
			{ path: "package/index.js", data: Buffer.alloc(4_096) },
			{ path: "package/package.json", data: manifest },
		]);
		expect(() => inspectPackageTarball(expanded, tarballLimits({ maxUnpackedBytes: 2_048, maxEntryBytes: 2_048 }))).toThrow();
	});

	test("streams capped official-registry tarballs and authenticates compressed bytes before inspection", async () => {
		const tarball = fixtureTarball('{"name":"@gajae-code/ai","version":"1.2.3"}\n');
		const fetchTarball = (async () => new Response(tarball)) as unknown as typeof fetch;
		await expect(downloadNpmRegistryTarball(
			"https://registry.npmjs.org/@gajae-code%2fai/-/ai-1.2.3.tgz",
			sha512Sri(tarball),
			{ fetcher: fetchTarball, maxCompressedBytes: tarball.length },
		)).resolves.toEqual(tarball);

		const malformedCompressed = Buffer.from("not a gzip tarball");
		const fetchMalformed = (async () => new Response(malformedCompressed)) as unknown as typeof fetch;
		await expect(downloadNpmRegistryTarball(
			"https://registry.npmjs.org/@gajae-code%2fai/-/ai-1.2.3.tgz",
			sha512Sri(Buffer.from("different compressed bytes")),
			{ fetcher: fetchMalformed, maxCompressedBytes: 1_024 },
		)).rejects.toThrow("compressed bytes");

		const fetchOversized = (async () => new Response(Buffer.alloc(64))) as unknown as typeof fetch;
		await expect(downloadNpmRegistryTarball(
			"https://registry.npmjs.org/@gajae-code%2fai/-/ai-1.2.3.tgz",
			sha512Sri(Buffer.alloc(64)),
			{ fetcher: fetchOversized, maxCompressedBytes: 16 },
		)).rejects.toThrow("compressed size");

		const fetchRedirect = (async () => new Response(null, {
			status: 302,
			headers: { location: "https://registry.npmjs.evil.invalid/ai.tgz" },
		})) as unknown as typeof fetch;
		await expect(downloadNpmRegistryTarball(
			"https://registry.npmjs.org/@gajae-code%2fai/-/ai-1.2.3.tgz",
			sha512Sri(tarball),
			{ fetcher: fetchRedirect },
		)).rejects.toThrow("redirect destination");
		expect(() => validateNpmRegistryTarballUrl("https://evil.invalid/ai.tgz", "test tarball")).toThrow("must remain");
	});
	test("requires exactly the complete sorted 14-package set and closed expected schema", () => {
		const { expected } = expectedFixture();
		expect(expected.packages).toHaveLength(14);
		expect(validateExpectedEvidence(expected)).toEqual(expected);
		expect(() => validateExpectedEvidence({ ...expected, unexpected: true })).toThrow("unknown or missing");
		expect(() => validateExpectedEvidence({ ...expected, packages: expected.packages.slice(1) })).toThrow("exactly 14 packages");
		expect(() => validateExpectedEvidence({ ...expected, packages: [...expected.packages].reverse() })).toThrow("complete public package set");
	});

	test("distinguishes absent, exact-resume, and immutable conflict registry states", () => {
		const { records } = expectedFixture();
		const record = records[0]!;
		const exact = observation(record);

		expect(classifyRegistryObservation(record, undefined)).toBe("publish");
		expect(classifyRegistryObservation(record, exact)).toBe("skip");
		expect(classifyRegistryObservation(record, { ...exact, registry_sri: "sha512-invalid" })).toBe("conflict");
		expect(classifyRegistryObservation(record, { ...exact, registry_internal_dependencies: { "@gajae-code/ai": "9.9.9" } })).toBe("conflict");

	});
	test("rejects stale latest observations and re-observes the complete set before final evidence", async () => {
		const { records } = expectedFixture();
		const record = records[0]!;
		const tarball = canonicalizePackageTarball(fixtureTarball(`{"name":"${record.name}","version":"${record.version}","dependencies":{}}\n`));
		const staleLatest = { ...observation(record), registry_latest_version: "1.2.4" };
		let publishCalls = 0;
		await expect(publishRetainedPackage(record, "retained.tgz", {
			readTarball: async () => tarball,
			observe: async () => staleLatest,
			publish: async () => {
				publishCalls += 1;
				return { exitCode: 0, output: "" };
			},
		})).rejects.toThrow("conflicts with immutable expected evidence");
		expect(publishCalls).toBe(0);
		expect(assertMonotonicLatestVersion(record.version, "1.2.4", "test latest")).toBeUndefined();
		expect(() => assertMonotonicLatestVersion(record.version, "1.2.2", "test latest")).toThrow("regresses below target");

		const observedNames: string[] = [];
		const observations = await reobserveExpectedEvidencePackages(records, async (candidate) => {
			observedNames.push(candidate.name);
			return observation(candidate);
		});
		expect([...observedNames].sort()).toEqual(PUBLIC_PACKAGE_DEFINITIONS.map(definition => definition.name));
		expect(Object.keys(observations)).toHaveLength(PUBLIC_PACKAGE_DEFINITIONS.length);
		await expect(reobserveExpectedEvidencePackages(records, async (candidate) =>
			candidate.name === record.name
				? { ...observation(candidate), registry_latest_version: "1.2.2" }
				: observation(candidate),
		)).rejects.toThrow("regresses below target");
	});
	test("recovers only an exact concurrent publication and reports an absent publish failure", async () => {
		const { expected } = expectedFixture();
		const record = expected.packages[0]!;
		const tarball = canonicalizePackageTarball(fixtureTarball(`{"name":"${record.name}","version":"1.2.3","dependencies":{}}\n`));
		const exact = observation(record);
		const observations: Array<RegistryPackageObservation | undefined> = [undefined, exact];
		await expect(publishRetainedPackage(record, "retained.tgz", {
			readTarball: async () => tarball,
			observe: async () => observations.shift(),
			publish: async () => ({ exitCode: 1, output: "E409 concurrent publish" }),
		})).resolves.toEqual(exact);
		const conflict = { ...exact, registry_sri: "sha512-conflict" };
		const conflictingObservations: Array<RegistryPackageObservation | undefined> = [undefined, conflict];
		await expect(publishRetainedPackage(record, "retained.tgz", {
			readTarball: async () => tarball,
			observe: async () => conflictingObservations.shift(),
			publish: async () => ({ exitCode: 1, output: "E409 concurrent publish" }),
		})).rejects.toThrow("conflicts with immutable expected evidence");
		await expect(publishRetainedPackage(record, "retained.tgz", {
			readTarball: async () => tarball,
			observe: async () => undefined,
			publish: async () => ({ exitCode: 1, output: "E403 denied" }),
		})).rejects.toThrow("E403 denied");
	});

	test("rejects malformed tarballs and malformed expected evidence before publication", async () => {
		const { expected } = expectedFixture();
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gajae-code-release-evidence-malformed-"));
		try {
			expect(() => canonicalizePackageTarball(gzipSync(Buffer.alloc(512)))).toThrow("two zero-block terminator");
			const malformedEvidence = path.join(directory, "expected.json");
			await fs.writeFile(malformedEvidence, JSON.stringify({ schema_version: 1 }));
			await expect(readExpectedEvidenceFile(malformedEvidence)).rejects.toThrow("unknown or missing");

			const record = expected.packages[0]!;
			const tarball = canonicalizePackageTarball(fixtureTarball(`{"name":"${record.name}","version":"1.2.3","dependencies":{}}\n`));
			const retained = await Promise.all(Array.from({ length: 4 }, () => retainTarball(directory, record, tarball)));
			expect(new Set(retained).size).toBe(1);
			await fs.writeFile(retained[0]!, Buffer.from("not a gzip tarball"));
			await expect(readRetainedTarball(record, retained[0]!)).rejects.toThrow("not a valid gzip stream");
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
	test("fails closed when an expired retained tarball cannot be reproduced before resume", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gajae-code-release-evidence-expired-"));
		try {
			const { records } = expectedFixture();
			await expect(readRetainedTarball(records[0]!, path.join(directory, "missing.tgz"))).rejects.toThrow("missing or expired");
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
	test("rejects an oversized retained tarball from on-disk metadata before allocation", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gajae-code-release-evidence-oversized-"));
		try {
			const { records } = expectedFixture();
			const oversizedPath = path.join(directory, "oversized.tgz");
			const retainedFile = await fs.open(oversizedPath, "w");
			try {
				await retainedFile.truncate(RELEASE_TARBALL_LIMITS.maxCompressedBytes + 1);
			} finally {
				await retainedFile.close();
			}
			await expect(readRetainedTarball(records[0]!, oversizedPath)).rejects.toThrow("compressed size exceeds");
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});


	test("links final evidence to immutable expected evidence and requires stable-finalization-last identity", () => {
		const { expected } = expectedFixture();
		const digest = expectedEvidenceSha256(expected);
		const observations = Object.fromEntries(expected.packages.map(record => [record.name, observation(record)]));
		const final = createFinalEvidence(expected, digest, observations);

		verifyFinalEvidence(expected, final, digest);
		assertStableFinalization({
			expected,
			final,
			expectedEvidenceSha256: digest,
			tag: "v1.2.3",
			version: "1.2.3",
			sourceCommit: "a".repeat(40),
			tagCommit: "a".repeat(40),
		});
		expect(final.expected_evidence_sha256).toBe(digest);
		expect(() => assertStableFinalization({
			expected,
			final,
			expectedEvidenceSha256: digest,
			tag: "v1.2.2",
			version: "1.2.3",
			sourceCommit: "a".repeat(40),
			tagCommit: "a".repeat(40),
		})).toThrow("exact vX.Y.Z tag");
		expect(() => assertStableFinalization({
			expected,
			final,
			expectedEvidenceSha256: digest,
			tag: "v1.2.2",
			version: "1.2.2",
			sourceCommit: "a".repeat(40),
			tagCommit: "a".repeat(40),
		})).toThrow("version does not match evidence");
		expect(() => assertStableFinalization({
			expected,
			final,
			expectedEvidenceSha256: digest,
			tag: "v1.2.3",
			version: "1.2.3",
			sourceCommit: "b".repeat(40),
			tagCommit: "b".repeat(40),
		})).toThrow("source commit does not match evidence");
		expect(() => assertStableFinalization({
			expected,
			final,
			expectedEvidenceSha256: digest,
			tag: "v1.2.3",
			version: "1.2.3",
			sourceCommit: "a".repeat(40),
			tagCommit: "b".repeat(40),
		})).toThrow("does not peel");
		expect(() => verifyFinalEvidence(expected, { ...final, expected_evidence_sha256: "0".repeat(64) }, digest)).toThrow("does not link");
	});

	test("creates expected and final evidence exclusively under concurrent exact and conflicting writers", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gajae-code-release-evidence-"));
		try {
			const { expected } = expectedFixture();
			const expectedPath = path.join(directory, "expected.json");
			const expectedDigests = await Promise.all(Array.from({ length: 4 }, () => writeImmutableEvidence(expectedPath, expected)));
			expect(new Set(expectedDigests).size).toBe(1);

			const expectedConflictPath = path.join(directory, "expected-conflict.json");
			const expectedConflict = { ...expected, source_commit: "b".repeat(40) };
			const expectedResults = await Promise.allSettled([
				writeImmutableEvidence(expectedConflictPath, expected),
				writeImmutableEvidence(expectedConflictPath, expectedConflict),
			]);
			expect(expectedResults.filter(result => result.status === "fulfilled")).toHaveLength(1);
			expect(expectedResults.filter(result => result.status === "rejected")).toHaveLength(1);

			const digest = expectedEvidenceSha256(expected);
			const observations = Object.fromEntries(expected.packages.map(record => [record.name, observation(record)]));
			const final = createFinalEvidence(expected, digest, observations);
			const finalPath = path.join(directory, "final.json");
			const finalDigests = await Promise.all(Array.from({ length: 4 }, () => writeImmutableEvidence(finalPath, final)));
			expect(new Set(finalDigests).size).toBe(1);

			const finalConflictPath = path.join(directory, "final-conflict.json");
			const finalConflict = { ...final, expected_evidence_sha256: "b".repeat(64) };
			const finalResults = await Promise.allSettled([
				writeImmutableEvidence(finalConflictPath, final),
				writeImmutableEvidence(finalConflictPath, finalConflict),
			]);
			expect(finalResults.filter(result => result.status === "fulfilled")).toHaveLength(1);
			expect(finalResults.filter(result => result.status === "rejected")).toHaveLength(1);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	test("accepts only mode-specific evidence CLI arguments", () => {
		expect(parseReleaseEvidenceCli(["--self-test"])).toEqual({ mode: "self-test" });
		expect(parseReleaseEvidenceCli(["--verify-final", "--expected-evidence", "expected.json", "--final-evidence", "final.json"])).toEqual({
			mode: "verify-final",
			expectedEvidence: "expected.json",
			finalEvidence: "final.json",
		});
		expect(() => parseReleaseEvidenceCli(["--verify-final", "--expected-evidence", "expected.json", "--final-evidence", "final.json", "--tag", "v1.2.3"])).toThrow("not valid");
		expect(() => parseReleaseEvidenceCli(["--verify-final", "--expected-evidence", "expected.json", "--expected-evidence", "other.json", "--final-evidence", "final.json"])).toThrow("duplicate");
		expect(() => parseReleaseEvidenceCli(["--verify-stable-finalization", "--expected-evidence", "expected.json", "--final-evidence", "final.json", "--tag", "v1.2.3", "--version", "1.2.3"])).toThrow("missing --source-commit");
	});
	test("requires an externally supplied shared cross-version release serialization guard", () => {
		expect(parseReleasePublishCli([
			"--publish-from-evidence",
			"--evidence-dir",
			"release-evidence",
			"--release-serialization-key",
			"npm-release-global",
		])).toEqual({
			mode: "publish-from-evidence",
			evidenceDir: "release-evidence",
			releaseSerializationKey: "npm-release-global",
		});
		expect(() => parseReleasePublishCli(["--publish-from-evidence", "--evidence-dir", "release-evidence"])).toThrow("release-serialization-key");
		expect(assertReleaseSerializationGuard("npm-release-global", "1.2.3")).toBeUndefined();
		expect(() => assertReleaseSerializationGuard("npm-release-1.2.3", "1.2.3")).toThrow("must not be scoped");
	});

	test("emits deterministic canonical source-native expected and final golden evidence", () => {
		const golden = createGoldenReleaseEvidence();
		const bytes = goldenReleaseEvidenceBytes();
		const expectedBytes = canonicalJsonBytes(golden.expected_evidence);
		const finalBytes = canonicalJsonBytes(golden.final_evidence);
		expect(bytes).toEqual(canonicalJsonBytes(golden));
		expect(golden.expected_evidence_sha256).toBe(sha256(expectedBytes));
		expect(golden.final_evidence_sha256).toBe(sha256(finalBytes));
		expect(goldenReleaseEvidenceSha256()).toBe(sha256(bytes));
		expect(golden.expected_evidence.packages).toHaveLength(PUBLIC_PACKAGE_DEFINITIONS.length);
		expect(golden.expected_evidence.packages.find(record => record.name === "@gajae-code/coding-agent")!.internal_dependencies)
			.toEqual({ "@gajae-code/ai": "1.2.3" });
		expect(golden.final_evidence.packages.every(record => record.registry_sri === record.expected_sri)).toBe(true);
		verifyFinalEvidence(golden.expected_evidence, golden.final_evidence, golden.expected_evidence_sha256);
		expect(parseReleaseEvidenceCli(["--emit-golden-evidence"])).toEqual({ mode: "emit-golden-evidence" });
	});
});
