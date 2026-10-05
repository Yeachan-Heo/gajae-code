#!/usr/bin/env bun
/**
 * Carry the read-only diagnostic addon's trusted digest across the release path and
 * prove it at every packaging boundary.
 *
 * `packages/natives/native/diagnostic-artifact.json` is the only thing the
 * diagnostic loader trusts: it refuses to activate an addon whose bytes hash to
 * anything else. That record is written in the checkout that builds the addon, but
 * release addons travel to other checkouts as bare `.node` uploads, and the shipped
 * version can be staged after the build (nightly). Without this script the record
 * would either be missing there or describe a different build.
 *
 * Modes:
 *   --rebuild-from-sidecars <nativeDir>
 *       Every `*.node` in the directory must be accompanied by the
 *       `<addon>.provenance.json` its build emitted, and that sidecar's digest must
 *       equal the bytes that actually arrived. The record is then written with the
 *       version of the package that is about to ship, so a version staged after the
 *       build cannot leave a stale record behind. The digests come from the
 *       transferred build provenance -- never from a runtime cache.
 *   --verify <nativeDir>
 *       Gate for embedding and packing: the record must exist, its version must
 *       equal the package version, and every addon present must match its recorded
 *       digest. Addons recorded but not shipped in this package (the platform
 *       packages carry them) are allowed.
 *   --stage-check <stagedNativeDir> --trusted-native-dir <nativeDir>
 *       Gate for platform-package staging: every staged addon must be byte-equal to
 *       what the trusted record describes.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

const SCHEMA = "gjc.diagnostic-artifact";
const SIDECAR_SCHEMA = "gjc.diagnostic-artifact-provenance";
const MANIFEST_BASENAME = "diagnostic-artifact.json";

type TrustedRecord = {
	schema: string;
	version: string;
	artifacts: Record<string, string>;
	/** Build version of any artifact whose build predates the shipped version. */
	buildVersions?: Record<string, string>;
};

function fail(message: string): never {
	process.stderr.write(`diagnostic artifact provenance: ${message}\n`);
	process.exit(1);
}

async function digestOf(file: string): Promise<string> {
	return new Bun.CryptoHasher("sha256").update(await Bun.file(file).bytes()).digest("hex");
}

async function packageVersionFor(nativeDir: string): Promise<string> {
	const manifestPath = path.join(nativeDir, "..", "package.json");
	if (!(await Bun.file(manifestPath).exists())) fail(`no package manifest beside ${nativeDir}`);
	const { version } = (await Bun.file(manifestPath).json()) as { version?: string };
	if (typeof version !== "string" || version === "") fail(`package manifest beside ${nativeDir} has no version`);
	return version;
}

async function addonsIn(dir: string): Promise<string[]> {
	const entries = await fs.readdir(dir).catch(() => fail(`cannot read native directory ${dir}`));
	return entries.filter(entry => entry.endsWith(".node")).sort();
}

async function readTrustedRecord(nativeDir: string): Promise<TrustedRecord> {
	const recordPath = path.join(nativeDir, MANIFEST_BASENAME);
	if (!(await Bun.file(recordPath).exists())) fail(`missing ${MANIFEST_BASENAME} in ${nativeDir}`);
	const record = (await Bun.file(recordPath).json()) as Partial<TrustedRecord>;
	if (record.schema !== SCHEMA) fail(`unexpected schema in ${recordPath}: ${String(record.schema)}`);
	if (typeof record.version !== "string") fail(`missing version in ${recordPath}`);
	if (typeof record.artifacts !== "object" || record.artifacts === null) fail(`missing artifacts in ${recordPath}`);
	return record as TrustedRecord;
}

async function rebuildFromSidecars(nativeDir: string): Promise<void> {
	const version = await packageVersionFor(nativeDir);
	const addons = await addonsIn(nativeDir);
	if (addons.length === 0) fail(`no native addons found in ${nativeDir}`);
	const artifacts: Record<string, string> = {};
	const buildVersions: Record<string, string> = {};
	for (const addon of addons) {
		const addonPath = path.join(nativeDir, addon);
		const sidecarPath = `${addonPath}.provenance.json`;
		if (!(await Bun.file(sidecarPath).exists())) {
			fail(`${addon} arrived without its build provenance sidecar (${path.basename(sidecarPath)})`);
		}
		const sidecar = (await Bun.file(sidecarPath).json()) as {
			schema?: string;
			version?: string;
			artifact?: string;
			sha256?: string;
		};
		if (sidecar.schema !== SIDECAR_SCHEMA) fail(`unexpected sidecar schema for ${addon}`);
		if (sidecar.artifact !== addon) fail(`sidecar for ${addon} names ${String(sidecar.artifact)}`);
		if (typeof sidecar.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sidecar.sha256)) {
			fail(`sidecar for ${addon} has no usable digest`);
		}
		const actual = await digestOf(addonPath);
		if (actual !== sidecar.sha256) {
			fail(`${addon} bytes do not match their build provenance (${actual} != ${sidecar.sha256})`);
		}
		artifacts[addon] = actual;
		if (typeof sidecar.version === "string" && sidecar.version !== version) {
			// The record's version has to describe the package being shipped, but the drift
			// itself must stay visible: the addon's own `nativeBuildInfo()` still reports the
			// build version, and the loader refuses a binding that disagrees with the shipped
			// version. Re-stamping is therefore not a way to make an incompatible addon load.
			buildVersions[addon] = sidecar.version;
			process.stderr.write(
				`diagnostic artifact provenance: ${addon} was built at ${sidecar.version} but is shipping as ${version}; the runtime binding check will refuse it unless the addon reports ${version}\n`,
			);
		}
	}
	const record: TrustedRecord = {
		schema: SCHEMA,
		version,
		artifacts,
		...(Object.keys(buildVersions).length > 0 ? { buildVersions } : {}),
	};
	await Bun.write(path.join(nativeDir, MANIFEST_BASENAME), `${JSON.stringify(record, null, 2)}\n`);
	process.stdout.write(
		`diagnostic artifact provenance: recorded ${Object.keys(artifacts).length} artifact digest(s) for ${version}\n`,
	);
}

async function verify(nativeDir: string): Promise<void> {
	const version = await packageVersionFor(nativeDir);
	const record = await readTrustedRecord(nativeDir);
	if (record.version !== version) {
		fail(`record version ${record.version} does not match package version ${version}`);
	}
	const addons = await addonsIn(nativeDir);
	for (const addon of addons) {
		const expected = record.artifacts[addon];
		if (expected === undefined) fail(`${addon} is present but has no trusted digest`);
		const actual = await digestOf(path.join(nativeDir, addon));
		if (actual !== expected) fail(`${addon} bytes do not match the trusted digest (${actual} != ${expected})`);
	}
	process.stdout.write(
		`diagnostic artifact provenance: verified ${addons.length} present artifact(s) against ${version}\n`,
	);
}

async function stageCheck(stagedDir: string, trustedNativeDir: string): Promise<void> {
	const record = await readTrustedRecord(trustedNativeDir);
	const staged = await addonsIn(stagedDir);
	if (staged.length === 0) fail(`no staged native addons found in ${stagedDir}`);
	for (const addon of staged) {
		const expected = record.artifacts[addon];
		if (expected === undefined) fail(`${addon} is staged but has no trusted digest`);
		const actual = await digestOf(path.join(stagedDir, addon));
		if (actual !== expected) fail(`${addon} staged bytes do not match the trusted digest`);
	}
	process.stdout.write(`diagnostic artifact provenance: staged ${staged.length} artifact(s) match the record\n`);
}

const argv = process.argv.slice(2);

function valueFor(flag: string): string | undefined {
	const index = argv.indexOf(flag);
	if (index < 0) return undefined;
	const value = argv[index + 1];
	if (value === undefined || value.startsWith("--")) fail(`${flag} needs a directory`);
	return value;
}

const rebuildDir = valueFor("--rebuild-from-sidecars");
const verifyDir = valueFor("--verify");
const stagedDir = valueFor("--stage-check");

if (rebuildDir !== undefined) {
	await rebuildFromSidecars(path.resolve(rebuildDir));
} else if (verifyDir !== undefined) {
	await verify(path.resolve(verifyDir));
} else if (stagedDir !== undefined) {
	const trusted = valueFor("--trusted-native-dir");
	if (trusted === undefined) fail("--stage-check needs --trusted-native-dir");
	await stageCheck(path.resolve(stagedDir), path.resolve(trusted));
} else {
	fail("usage: --rebuild-from-sidecars <dir> | --verify <dir> | --stage-check <dir> --trusted-native-dir <dir>");
}
