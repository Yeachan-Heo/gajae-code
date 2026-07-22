#!/usr/bin/env bun

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");
const defaultReceiptPath = path.join(repoRoot, ".ci-dev-darwin-arm64-receipt.json");
const sha256 = /^[a-f0-9]{64}$/;
const gitSha = /^[a-f0-9]{40}$/;
const canonicalSmokeArgv = ["packages/coding-agent/dist/gjc", "--smoke-test"] as const;
const smokeEnvironmentKeys = ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"] as const;

type SmokeEnvironment = Record<(typeof smokeEnvironmentKeys)[number], string>;

interface DarwinReceipt {
	sourceSha: string;
	binarySha256: string;
	nativeAddonSha256: string;
	nativePackageVersion: string;
	versionSentinelExport: string;
	bunVersion: string;
	runnerOs: "darwin";
	runnerArch: "arm64";
	smokeArgv: string[];
	smokeEnvironment: SmokeEnvironment;
	outcome: "success";
}

interface NativePackageJson {
	name?: unknown;
	version?: unknown;
}

async function loadNativeIdentity(): Promise<{ packageVersion: string; versionSentinelExport: string }> {
	const nativePackage = await Bun.file(path.join(repoRoot, "packages/natives/package.json")).json() as NativePackageJson;
	if (nativePackage.name !== "@gajae-code/natives" || !isString(nativePackage.version) || nativePackage.version.trim().length === 0) {
		throw new Error("darwin-receipt-invalid: @gajae-code/natives package version is unavailable");
	}
	const versionSentinelExport = `__piNativesV${nativePackage.version.replace(/[^A-Za-z0-9]/g, "_")}`;
	const nativeIndex = await Bun.file(path.join(repoRoot, "packages/natives/native/index.js")).text();
	if (!nativeIndex.includes(`export const ${versionSentinelExport} = nativeBindings.${versionSentinelExport};`)) {
		throw new Error("darwin-receipt-invalid: native version sentinel is not exported by the loader wrapper");
	}
	const loaderState = await Bun.file(path.join(repoRoot, "packages/natives/native/loader-state.js")).text();
	if (!loaderState.includes("const versionSentinelExport =") || !loaderState.includes("bindings[ctx.versionSentinelExport]")) {
		throw new Error("darwin-receipt-invalid: native loader does not validate its version sentinel");
	}
	return { packageVersion: nativePackage.version, versionSentinelExport };
}

function assertReceipt(value: unknown, expectedSourceSha: string, nativeIdentity: { packageVersion: string; versionSentinelExport: string }): asserts value is DarwinReceipt {
	if (!isRecord(value)) throw new Error("darwin-receipt-invalid: receipt must be an object");
	const keys = ["sourceSha", "binarySha256", "nativeAddonSha256", "nativePackageVersion", "versionSentinelExport", "bunVersion", "runnerOs", "runnerArch", "smokeArgv", "smokeEnvironment", "outcome"];
	if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) throw new Error("darwin-receipt-invalid: unexpected receipt fields");
	if (!isString(value.sourceSha) || !gitSha.test(value.sourceSha) || value.sourceSha !== expectedSourceSha) throw new Error("darwin-receipt-invalid: source SHA does not match the PR head");
	for (const key of ["binarySha256", "nativeAddonSha256"] as const) {
		if (!isString(value[key]) || !sha256.test(value[key])) throw new Error(`darwin-receipt-invalid: invalid ${key}`);
	}
	if (value.nativePackageVersion !== nativeIdentity.packageVersion) throw new Error("darwin-receipt-invalid: native package version does not match @gajae-code/natives");
	if (value.versionSentinelExport !== nativeIdentity.versionSentinelExport) throw new Error("darwin-receipt-invalid: native version sentinel does not match the loader");
	if (!isString(value.bunVersion) || value.bunVersion.trim().length === 0) throw new Error("darwin-receipt-invalid: missing bunVersion");
	if (value.runnerOs !== "darwin" || value.runnerArch !== "arm64") throw new Error("darwin-receipt-invalid: wrong runner platform");
	if (!Array.isArray(value.smokeArgv) || value.smokeArgv.length !== canonicalSmokeArgv.length || value.smokeArgv.some((arg, index) => arg !== canonicalSmokeArgv[index])) {
		throw new Error("darwin-receipt-invalid: smoke argv is not canonical");
	}
	assertSmokeEnvironment(value.smokeEnvironment);
	if (value.outcome !== "success") throw new Error("darwin-receipt-invalid: smoke did not succeed");
}

function assertSmokeEnvironment(value: unknown): asserts value is SmokeEnvironment {
	if (!isRecord(value) || Object.keys(value).length !== smokeEnvironmentKeys.length || Object.keys(value).some(key => !smokeEnvironmentKeys.includes(key as (typeof smokeEnvironmentKeys)[number]))) {
		throw new Error("darwin-receipt-invalid: smoke environment keys are not canonical");
	}
	const runtimeDir = value.HOME;
	if (!isString(runtimeDir) || !path.isAbsolute(runtimeDir) || path.basename(runtimeDir) !== "home") throw new Error("darwin-receipt-invalid: HOME is not a fresh smoke home");
	const root = path.dirname(runtimeDir);
	const expectedEnvironment: SmokeEnvironment = {
		HOME: path.join(root, "home"),
		XDG_CONFIG_HOME: path.join(root, "xdg", "config"),
		XDG_DATA_HOME: path.join(root, "xdg", "data"),
		XDG_CACHE_HOME: path.join(root, "xdg", "cache"),
	};
	for (const key of smokeEnvironmentKeys) {
		if (value[key] !== expectedEnvironment[key]) throw new Error(`darwin-receipt-invalid: ${key} is not a fresh canonical smoke directory`);
	}
}

async function fileSha256(file: string): Promise<string> {
	return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

async function writeReceipt(receiptPath: string): Promise<void> {
	const sourceSha = requiredEnv("CI_DEV_SOURCE_SHA");
	if (!gitSha.test(sourceSha)) throw new Error("darwin-receipt-invalid: CI_DEV_SOURCE_SHA must be a commit SHA");
	const headProcess = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
	const checkedOutHead = (await new Response(headProcess.stdout).text()).trim();
	if (await headProcess.exited !== 0 || checkedOutHead !== sourceSha) throw new Error("darwin-receipt-invalid: checked-out source does not match CI_DEV_SOURCE_SHA");
	const binaryPath = path.resolve(repoRoot, requiredEnv("CI_DEV_DARWIN_BINARY"));
	const nativeAddonPath = path.resolve(repoRoot, requiredEnv("CI_DEV_DARWIN_NATIVE_ADDON"));
	const smokeEnvironment = readSmokeEnvironment();
	const nativeIdentity = await loadNativeIdentity();
	const receipt: DarwinReceipt = {
		sourceSha,
		binarySha256: await fileSha256(binaryPath),
		nativeAddonSha256: await fileSha256(nativeAddonPath),
		nativePackageVersion: nativeIdentity.packageVersion,
		versionSentinelExport: nativeIdentity.versionSentinelExport,
		bunVersion: Bun.version,
		runnerOs: process.platform as "darwin",
		runnerArch: process.arch as "arm64",
		smokeArgv: [...canonicalSmokeArgv],
		smokeEnvironment,
		outcome: "success",
	};
	assertReceipt(receipt, sourceSha, nativeIdentity);
	await fs.writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, { flag: "wx" });
}

function readSmokeEnvironment(): SmokeEnvironment {
	return Object.fromEntries(smokeEnvironmentKeys.map(key => [key, requiredEnv(`CI_DEV_DARWIN_SMOKE_${key}`)])) as SmokeEnvironment;
}

function requiredEnv(name: string): string {
	const value = Bun.env[name]?.trim();
	if (!value) throw new Error(`darwin-receipt-invalid: ${name} is required`);
	return value;
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function main(): Promise<void> {
	const receiptPath = path.resolve(repoRoot, Bun.env.CI_DEV_DARWIN_RECEIPT?.trim() || defaultReceiptPath);
	const expectedSourceSha = requiredEnv("CI_DEV_SOURCE_SHA");
	const nativeIdentity = await loadNativeIdentity();
	if (process.argv.includes("--write")) await writeReceipt(receiptPath);
	assertReceipt(await Bun.file(receiptPath).json(), expectedSourceSha, nativeIdentity);
}

if (import.meta.main) await main();
