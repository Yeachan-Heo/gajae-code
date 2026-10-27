import { expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "../../..");
const scriptPath = path.join(repoRoot, "packages/natives/scripts/build-native.ts");
const nativeDir = path.join(repoRoot, "packages/natives/native");

function toolchainEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
	const home = path.join(os.tmpdir(), "gjc-native-build-path");
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env.CROSS_TARGET;
	delete env.TARGET_ARCH;
	delete env.TARGET_PLATFORM;
	delete env.TARGET_VARIANT;
	delete env.PI_NATIVE_PROFILE;
	delete env.CARGO;
	return {
		...env,
		...extra,
		HOME: home,
		USERPROFILE: home,
		CARGO_HOME: path.join(home, "cargo"),
		RUSTUP_HOME: path.join(home, "rustup"),
		PATH: "/usr/bin:/bin",
		CI: "",
	};
}

async function runBuildScript(extra: Record<string, string>): Promise<{ exitCode: number; output: string }> {
	const proc = Bun.spawn({
		cmd: [process.execPath, scriptPath],
		cwd: repoRoot,
		env: toolchainEnv(extra),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, output: `${stdout}\n${stderr}` };
}

async function withSentinel(sentinel: string, body: () => Promise<void>): Promise<void> {
	await fs.mkdir(path.dirname(sentinel), { recursive: true });
	if (await Bun.file(sentinel).exists()) {
		throw new Error(`refusing to overwrite existing sentinel ${path.basename(sentinel)}`);
	}
	await Bun.write(sentinel, "sentinel");
	try {
		await body();
		expect(await Bun.file(sentinel).text()).toBe("sentinel");
		expect(await Bun.file(`${sentinel}.build.json`).exists()).toBe(false);
	} finally {
		await fs.rm(sentinel, { force: true });
		await fs.rm(`${sentinel}.build.json`, { force: true });
	}
}

it("rejects TARGET_ARCH values that would install the addon outside nativeDir", async () => {
	const targetArch = `../../../gjc-native-victim-${crypto.randomUUID()}`;
	const sentinel = path.join(nativeDir, `pi_natives.${process.platform}-${targetArch}.node`);
	expect(path.relative(nativeDir, sentinel).startsWith("..")).toBe(true);
	await withSentinel(sentinel, async () => {
		const result = await runBuildScript({ TARGET_ARCH: targetArch });
		expect(result.exitCode).not.toBe(0);
		expect(result.output).toContain("Unsupported TARGET_ARCH: path separators are not allowed");
	});
});

it("rejects CROSS_TARGET values that would create the build directory outside nativeDir", async () => {
	const crossTarget = `../../../../gjc-native-escape-${crypto.randomUUID()}`;
	const escapedPrefix = path.join(nativeDir, ".build", `${crossTarget}-baseline-ci-`);
	expect(path.relative(path.join(nativeDir, ".build"), escapedPrefix).startsWith("..")).toBe(true);
	const parent = path.dirname(escapedPrefix);
	const before = new Set(await fs.readdir(parent));
	const result = await runBuildScript({
		TARGET_ARCH: "x64",
		TARGET_VARIANT: "baseline",
		CROSS_TARGET: crossTarget,
	});
	expect(result.exitCode).not.toBe(0);
	expect(result.output).toContain("Unsupported CROSS_TARGET: path separators are not allowed");
	const created = (await fs.readdir(parent)).filter(
		entry => !before.has(entry) && entry.includes(crossTarget.split("/").at(-1) ?? crossTarget),
	);
	expect(created).toEqual([]);
});

it("rejects TARGET_PLATFORM values that would install the addon outside nativeDir", async () => {
	const targetPlatform = `../../../gjc-native-plat-${crypto.randomUUID()}`;
	const sentinel = path.join(nativeDir, `pi_natives.${targetPlatform}-arm64.node`);
	expect(path.relative(nativeDir, sentinel).startsWith("..")).toBe(true);
	await withSentinel(sentinel, async () => {
		const result = await runBuildScript({ TARGET_PLATFORM: targetPlatform, TARGET_ARCH: "arm64" });
		expect(result.exitCode).not.toBe(0);
		expect(result.output).toContain("Unsupported TARGET_PLATFORM: path separators are not allowed");
	});
});

it("still allows a rust triple and x64 arch to reach toolchain resolution", async () => {
	const result = await runBuildScript({
		TARGET_PLATFORM: "linux",
		TARGET_ARCH: "x64",
		TARGET_VARIANT: "baseline",
		CROSS_TARGET: "x86_64-unknown-linux-gnu",
	});
	expect(result.exitCode).not.toBe(0);
	expect(result.output).not.toContain("path separators are not allowed");
	expect(result.output).not.toContain("escapes the native");
	expect(
		result.output.includes("Could not locate Cargo for native addon build") ||
			result.output.includes("Could not locate @napi-rs/cli"),
	).toBe(true);
});

function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
		mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
		return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
	};
}

function referenceLayout(
	pathApi: typeof path.posix,
	input: {
		nativeDir: string;
		crossTarget?: string;
		targetPlatform: string;
		targetArch: string;
		variantSuffix: string;
		variantLabel: string;
		profileLabel: string;
	},
): { buildOutputDirPrefix: string; canonicalAddonPath: string } {
	const buildTarget = input.crossTarget ?? `${input.targetPlatform}-${input.targetArch}`;
	return {
		buildOutputDirPrefix: pathApi.resolve(
			pathApi.join(input.nativeDir, ".build", `${buildTarget}-${input.variantLabel}-${input.profileLabel}-`),
		),
		canonicalAddonPath: pathApi.resolve(
			pathApi.join(
				input.nativeDir,
				`pi_natives.${input.targetPlatform}-${input.targetArch}${input.variantSuffix}.node`,
			),
		),
	};
}

it("property: native build output paths stay inside the native directory, seed 39664, 64 generated inputs", async () => {
	const source = await Bun.file(scriptPath).text();
	expect(source).toContain("export function resolveNativeBuildOutputPaths");
	const { resolveNativeBuildOutputPaths } = await import("../scripts/build-native");
	const seed = 39664;
	const random = mulberry32(seed);
	const alphabet = "abcXYZ012._-";
	const pick = (length: number) =>
		Array.from({ length }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
	const manualInputs = [
		{
			nativeDir: "/pkg/packages/natives/native",
			targetPlatform: "darwin",
			targetArch: "arm64",
			variantSuffix: "",
			variantLabel: "default",
			profileLabel: "local",
		},
		{
			nativeDir: "/pkg/packages/natives/native",
			crossTarget: "x86_64-unknown-linux-gnu",
			targetPlatform: "linux",
			targetArch: "x64",
			variantSuffix: "-baseline",
			variantLabel: "baseline",
			profileLabel: "ci",
		},
		{
			nativeDir: "/pkg/packages/natives/native",
			crossTarget: "aarch64-apple-darwin",
			targetPlatform: "darwin",
			targetArch: "arm64",
			variantSuffix: "",
			variantLabel: "default",
			profileLabel: "ci",
		},
		{
			nativeDir: "/pkg/packages/natives/native",
			crossTarget: "x86_64-pc-windows-msvc",
			targetPlatform: "win32",
			targetArch: "x64",
			variantSuffix: "-modern",
			variantLabel: "modern",
			profileLabel: "dist",
		},
	];
	const generatedInputs = Array.from({ length: 64 }, (_, index) => ({
		nativeDir: "/pkg/packages/natives/native",
		crossTarget: index % 2 === 0 ? pick(12) : undefined,
		targetPlatform: pick(6),
		targetArch: pick(4),
		variantSuffix: index % 3 === 0 ? "-baseline" : "",
		variantLabel: "default",
		profileLabel: "local",
	}));
	expect(generatedInputs).toHaveLength(64);
	const safeInputs = [...manualInputs, ...generatedInputs];
	const attacks = ["../x", "..\\x", "/tmp/x", "C:\\temp\\x", "a/b", "a\\b", "a\0b", "ok/../../etc"];
	let checked = 0;
	for (const pathApi of [path.posix, path.win32]) {
		for (const input of safeInputs) {
			const first = resolveNativeBuildOutputPaths(input, pathApi);
			const second = resolveNativeBuildOutputPaths(input, pathApi);
			expect(second).toEqual(first);
			expect(referenceLayout(pathApi, input)).toEqual({
				buildOutputDirPrefix: first.buildOutputDirPrefix,
				canonicalAddonPath: first.canonicalAddonPath,
			});
			expect(pathApi.dirname(first.buildOutputDirPrefix)).toBe(pathApi.resolve(input.nativeDir, ".build"));
			expect(pathApi.dirname(first.canonicalAddonPath)).toBe(pathApi.resolve(input.nativeDir));
			checked += 1;
		}
		for (const attack of attacks) {
			expect(() => resolveNativeBuildOutputPaths({ ...safeInputs[0], crossTarget: attack }, pathApi)).toThrow(
				/Unsupported CROSS_TARGET/,
			);
			expect(() => resolveNativeBuildOutputPaths({ ...safeInputs[0], targetArch: attack }, pathApi)).toThrow(
				/Unsupported TARGET_ARCH/,
			);
			checked += 2;
		}
	}
	expect(checked).toBe((manualInputs.length + generatedInputs.length + attacks.length * 2) * 2);
});
