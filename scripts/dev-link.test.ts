import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	commandExtensions,
	findGjcOnPath,
	isApprovedWorkspaceSource,
	isLocalWindowsBunShim,
	pathDirs,
	smokeTest,
} from "./dev-link";

const tempRoots: string[] = [];
const shimFlags = (5478 << 3) | 0b101;

async function makeExecutable(file: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await Bun.write(file, content);
	await fs.chmod(file, 0o755);
}

function bunMetadata(target = "@gajae-code\\coding-agent\\bin\\gjc.js", command = "bun "): Buffer {
	const pathBytes = Buffer.from(target, "utf16le");
	const framing = Buffer.from('"\0', "utf16le");
	const shebang = Buffer.from(command, "utf16le");
	const lengths = Buffer.alloc(8);
	lengths.writeUInt32LE(pathBytes.length, 0);
	lengths.writeUInt32LE(shebang.length, 4);
	const flags = Buffer.alloc(2);
	flags.writeUInt16LE(shimFlags, 0);
	return Buffer.concat([pathBytes, framing, shebang, lengths, flags]);
}

function windowsShimExecutable(): Buffer {
	const executable = Buffer.alloc(0x200);
	executable.write("MZ", 0);
	executable.writeUInt32LE(0x80, 0x3c);
	executable.write("PE\0\0", 0x80);
	executable.writeUInt16LE(1, 0x86);
	executable.writeUInt16LE(0, 0x94);
	executable.writeUInt32LE(0x140, 0x98 + 16);
	executable.writeUInt32LE(0xc0, 0x98 + 20);
	return executable;
}

function fixtureBun(root: string): string {
	return path.join(root, "bun.exe");
}

function isFixtureShim(file: string, root: string): boolean {
	return isLocalWindowsBunShim(file, root, fixtureBun(root));
}

function isFixtureSource(file: string, real: string | null, root: string, platform: NodeJS.Platform): boolean {
	return isApprovedWorkspaceSource(file, real, root, platform, fixtureBun(root));
}

async function workspaceFixture(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-dev-link-windows-"));
	tempRoots.push(root);
	const packageRoot = path.join(root, "packages", "coding-agent");
	await fs.mkdir(path.join(packageRoot, "bin"), { recursive: true });
	await fs.mkdir(path.join(packageRoot, "src"), { recursive: true });
	await Bun.write(
		path.join(packageRoot, "package.json"),
		JSON.stringify({ bin: { gjc: "bin/gjc.js" }, exports: { "./cli": "./src/cli.ts" } }),
	);
	await Bun.write(
		path.join(packageRoot, "bin", "gjc.js"),
		'#!/usr/bin/env bun\nimport { runCli } from "@gajae-code/coding-agent/cli";\n\nawait runCli(process.argv.slice(2));\n',
	);
	await Bun.write(path.join(packageRoot, "src", "cli.ts"), "export {};\n");
	await fs.mkdir(path.join(root, "node_modules", "@gajae-code"), { recursive: true });
	await fs.symlink(packageRoot, path.join(root, "node_modules", "@gajae-code", "coding-agent"), "dir");
	await fs.mkdir(path.join(root, "node_modules", ".bin"), { recursive: true });
	await Bun.write(path.join(root, "node_modules", ".bin", "gjc.exe"), windowsShimExecutable());
	await Bun.write(path.join(root, "node_modules", ".bin", "gjc.bunx"), bunMetadata());
	await Bun.write(fixtureBun(root), Buffer.concat([Buffer.from("bun-runtime"), windowsShimExecutable(), Buffer.from("tail")]));
	return root;
}

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(root => fs.rm(root, { force: true, recursive: true })));
});

describe("dev:link command discovery", () => {
	test("uses Windows PATH directory order and PATHEXT order with case-insensitive deduplication", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-dev-link-path-"));
		tempRoots.push(root);
		const first = path.join(root, "first");
		const second = path.join(root, "second");
		await makeExecutable(path.join(first, "gjc.CMD"), "");
		await makeExecutable(path.join(first, "gjc.exe"), "");
		await makeExecutable(path.join(second, "gjc.exe"), "");
		expect(pathDirs(`${first};${second}`, "win32")).toEqual([first, second]);
		expect(commandExtensions("win32", ".CMD;.exe;.CMD;.EXE")).toEqual([".CMD", ".exe"]);
		expect(findGjcOnPath(`${first};${second}`, "win32", ".CMD;.exe;.CMD;.EXE").map(hit => hit.file)).toEqual([
			path.join(first, "gjc.CMD"),
			path.join(first, "gjc.exe"),
			path.join(second, "gjc.exe"),
		]);
	});

	test("uses the documented Windows PATHEXT fallback and keeps Unix extensionless", () => {
		expect(commandExtensions("win32", "")).toEqual([".COM", ".EXE", ".BAT", ".CMD"]);
		expect(commandExtensions("linux", ".EXE")).toEqual([""]);
	});
});


describe.skipIf(process.platform === "win32")("dev:link Windows Bun workspace shim provenance", () => {
	test("accepts a direct canonical source link and the exact valid Bun workspace shim", async () => {
		const root = await workspaceFixture();
		const source = path.join(root, "packages", "coding-agent", "src", "cli.ts");
		const shim = path.join(root, "node_modules", ".bin", "gjc.exe");
		expect(isFixtureSource("ignored", source, root, "win32")).toBe(true);
		expect(isFixtureShim(shim, root)).toBe(true);
		expect(isFixtureSource(shim, null, root, "win32")).toBe(true);
	});

	test("keeps smoke health independent from accepted provenance", async () => {
		const root = await workspaceFixture();
		const shim = path.join(root, "node_modules", ".bin", "gjc.exe");
		const failedSmoke = path.join(root, "failed-smoke");
		await makeExecutable(failedSmoke, "#!/usr/bin/env sh\necho smoke-test: failed\nexit 1\n");
		expect(isFixtureSource(shim, null, root, "win32")).toBe(true);
		expect(smokeTest(failedSmoke).ok).toBe(false);
	});

	test("fails closed for missing, corrupt, foreign, or substituted shim metadata", async () => {
		const root = await workspaceFixture();
		const shim = path.join(root, "node_modules", ".bin", "gjc.exe");
		const metadata = path.join(root, "node_modules", ".bin", "gjc.bunx");
		await fs.rm(metadata);
		expect(isFixtureShim(shim, root)).toBe(false);
		await Bun.write(metadata, Buffer.from("corrupt"));
		expect(isFixtureShim(shim, root)).toBe(false);
		await fs.mkdir(path.join(root, "node_modules", "foreign", "bin"), { recursive: true });
		await Bun.write(path.join(root, "node_modules", "foreign", "bin", "gjc.js"), "#!/usr/bin/env bun\n");
		await Bun.write(metadata, bunMetadata("foreign\\bin\\gjc.js"));
		expect(isFixtureShim(shim, root)).toBe(false);
		await Bun.write(metadata, bunMetadata());
		const trusted = windowsShimExecutable();
		for (const fragment of [
			trusted.subarray(0, 1),
			Buffer.from("MZ"),
			trusted.subarray(0, -1),
			Buffer.concat([trusted, Buffer.from("suffix")]),
			trusted.subarray(32, 96),
		]) {
			await Bun.write(shim, fragment);
			expect(isFixtureShim(shim, root)).toBe(false);
		}

		const substituted = Buffer.from(trusted);
		substituted[0x1f0] = 1;
		Buffer.from("smoke-test: ok").copy(substituted, 0x1d0);
		await Bun.write(shim, substituted);
		expect(isFixtureShim(shim, root)).toBe(false);
		expect(substituted.includes(Buffer.from("smoke-test: ok"))).toBe(true);
	});

	test("rejects inconsistent metadata lengths, trailing bytes, versions, flags, commands, and oversized files", async () => {
		const root = await workspaceFixture();
		const shim = path.join(root, "node_modules", ".bin", "gjc.exe");
		const metadata = path.join(root, "node_modules", ".bin", "gjc.bunx");
		const valid = bunMetadata();

		const badLength = Buffer.from(valid);
		badLength.writeUInt32LE(badLength.readUInt32LE(badLength.length - 6) + 2, badLength.length - 6);
		await Bun.write(metadata, badLength);
		expect(isFixtureShim(shim, root)).toBe(false);

		await Bun.write(metadata, Buffer.concat([valid.subarray(0, -2), Buffer.from([0, 0]), valid.subarray(-2)]));
		expect(isFixtureShim(shim, root)).toBe(false);

		const wrongVersion = Buffer.from(valid);
		wrongVersion.writeUInt16LE((5477 << 3) | 0b101, wrongVersion.length - 2);
		await Bun.write(metadata, wrongVersion);
		expect(isFixtureShim(shim, root)).toBe(false);

		const wrongFlags = Buffer.from(valid);
		wrongFlags.writeUInt16LE((5478 << 3) | 0b111, wrongFlags.length - 2);
		await Bun.write(metadata, wrongFlags);
		expect(isFixtureShim(shim, root)).toBe(false);

		await Bun.write(metadata, bunMetadata(undefined, "node "));
		expect(isFixtureShim(shim, root)).toBe(false);

		await Bun.write(metadata, Buffer.alloc(64 * 1024));
		expect(isFixtureShim(shim, root)).toBe(false);
		await Bun.write(metadata, Buffer.alloc(64 * 1024 + 1));
		expect(isFixtureShim(shim, root)).toBe(false);

		await Bun.write(metadata, valid);
		await Bun.write(shim, Buffer.alloc(1024 * 1024 + 1));
		expect(isFixtureShim(shim, root)).toBe(false);
	});

	test("rejects bin and canonical export mismatches", async () => {
		const root = await workspaceFixture();
		const shim = path.join(root, "node_modules", ".bin", "gjc.exe");
		await Bun.write(path.join(root, "packages", "coding-agent", "package.json"), JSON.stringify({ bin: { gjc: "bin/other.js" } }));
		expect(isFixtureShim(shim, root)).toBe(false);
		const exportRoot = await workspaceFixture();
		const exportShim = path.join(exportRoot, "node_modules", ".bin", "gjc.exe");
		await Bun.write(
			path.join(exportRoot, "packages", "coding-agent", "package.json"),
			JSON.stringify({ bin: { gjc: "bin/gjc.js" }, exports: { "./cli": "./src/other.ts" } }),
		);
		await Bun.write(path.join(exportRoot, "packages", "coding-agent", "src", "other.ts"), "export {};\n");
		expect(isFixtureShim(exportShim, exportRoot)).toBe(false);

		const markerRoot = await workspaceFixture();
		const markerShim = path.join(markerRoot, "node_modules", ".bin", "gjc.exe");
		await Bun.write(
			path.join(markerRoot, "packages", "coding-agent", "bin", "gjc.js"),
			'#!/usr/bin/env bun\n// from "@gajae-code/coding-agent/cli"\nconsole.log("smoke-test: ok");\n',
		);
		expect(isFixtureShim(markerShim, markerRoot)).toBe(false);
	});

	test("rejects wrong-extension, compiled, and published targets even at an allowlisted path", async () => {
		const root = await workspaceFixture();
		const shim = path.join(root, "node_modules", ".bin", "gjc.exe");
		expect(isFixtureSource(path.join(root, "node_modules", ".bin", "gjc.cmd"), null, root, "win32")).toBe(false);
		expect(isFixtureSource(path.join(root, "dist", "gjc.exe"), path.join(root, "dist", "gjc.exe"), root, "win32")).toBe(false);
		expect(
			isFixtureSource(
				path.join(root, "node_modules", "gajae-code", "bin", "gjc.js"),
				path.join(root, "node_modules", "gajae-code", "bin", "gjc.js"),
				root,
				"win32",
			),
		).toBe(false);
		expect(isFixtureSource(shim, null, root, "linux")).toBe(false);
	});
});


describe("dev:link", () => {
	test.skipIf(process.platform === "win32")("fails when a shadow gjc earlier on PATH would make smoke-test validate the wrong command", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-dev-link-shadow-"));
		tempRoots.push(root);
		const shadowDir = path.join(root, "shadow-bin");
		const targetDir = path.join(root, "managed-bin");
		await makeExecutable(
			path.join(shadowDir, "gjc"),
			`#!/usr/bin/env sh\nif [ "$1" = "--smoke-test" ]; then echo "smoke-test: ok"; exit 0; fi\necho shadow\nexit 0\n`,
		);
		const result = Bun.spawnSync([process.execPath, "scripts/dev-link.ts"], {
			env: { ...process.env, GJC_DEV_LINK_DIR: targetDir, PATH: `${shadowDir}:${targetDir}` },
			stderr: "pipe",
			stdout: "pipe",
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.stdout.toString()).toContain(`Linked ${path.join(targetDir, "gjc")}`);
		expect(result.stderr.toString()).toContain("still resolves to a different command earlier on PATH");
		expect(result.stderr.toString()).toContain(path.join(shadowDir, "gjc"));
	});
});
