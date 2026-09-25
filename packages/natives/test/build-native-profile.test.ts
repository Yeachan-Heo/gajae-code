import { beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import {
	prependPathEntry,
	resolveCargoToolchainPath,
	resolveCargoToolchainPathFromCandidates,
	resolveRustupCandidatePaths,
} from "../scripts/rust-toolchain-path";

const repoRoot = path.join(import.meta.dir, "../../..");
const rustupExecutableName = process.platform === "win32" ? "rustup.exe" : "rustup";

type TomlSection = Record<string, string>;

function parseTomlSections(source: string): Record<string, TomlSection> {
	const sections: Record<string, TomlSection> = {};
	let currentSection: TomlSection | undefined;

	for (const rawLine of source.split(/\r?\n/)) {
		const line = rawLine.replace(/\s+#.*$/, "").trim();
		if (!line) continue;

		const sectionMatch = line.match(/^\[([^\]]+)]$/);
		if (sectionMatch) {
			currentSection = {};
			sections[sectionMatch[1]] = currentSection;
			continue;
		}

		if (!currentSection) continue;
		const assignmentMatch = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
		if (assignmentMatch) {
			currentSection[assignmentMatch[1]] = assignmentMatch[2].trim();
		}
	}

	return sections;
}

async function listNativeBuildDirs(): Promise<string[]> {
	const buildRoot = path.join(repoRoot, "packages/natives/native/.build");
	try {
		return (await fs.readdir(buildRoot)).sort();
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}
}

describe("native build Cargo profiles", () => {
	beforeAll(async () => {
		// A cold Cargo home needs registry/package downloads. Keep that setup out of
		// each 30-second graph assertion and expose download errors in CI output.
		const proc = Bun.spawn(["cargo", "fetch", "--locked"], {
			cwd: repoRoot,
			stdout: "inherit",
			stderr: "inherit",
			timeout: 150_000,
		});
		expect(await proc.exited).toBe(0);
	}, 180_000);

	it.each([
		["x86_64-pc-windows-msvc", false],
		["aarch64-pc-windows-msvc", false],
		["x86_64-unknown-linux-gnu", true],
		["aarch64-unknown-linux-gnu", true],
		["x86_64-apple-darwin", true],
		["aarch64-apple-darwin", true],
	] as const)(
		"resolves the supported SHA backend for %s",
		async (target, assemblyExpected) => {
			const result = await $`cargo tree --frozen -p pi-natives --target ${target} --prefix none --format "{p} {f}"`
				.cwd(repoRoot)
				.quiet()
				.nothrow();
			expect(result.exitCode, result.stderr.toString()).toBe(0);
			const dependencies = result.stdout.toString().split("\n");
			expect(dependencies.some(line => line.startsWith("sha2 v"))).toBe(true);
			expect(dependencies.some(line => line.startsWith("sha2-asm v"))).toBe(assemblyExpected);
		},
		30_000,
	);

	it("defines an unwind-safe dist profile that only inherits size settings from release", async () => {
		const cargoToml = await Bun.file(path.join(repoRoot, "Cargo.toml")).text();
		const sections = parseTomlSections(cargoToml);

		expect(sections["profile.release"]?.panic).toBe('"abort"');
		expect(sections["profile.dist"]).toEqual(
			expect.objectContaining({
				inherits: '"release"',
				panic: '"unwind"',
				strip: '"debuginfo"',
			}),
		);
		expect(sections["profile.dist"]?.panic).toBe('"unwind"');
	});

	it("forces statically bundled PCRE2 in local and CI native builds", async () => {
		const [buildScript, action] = await Promise.all([
			fs.readFile(path.join(repoRoot, "packages/natives/scripts/build-native.ts"), "utf8"),
			fs.readFile(path.join(repoRoot, ".github/actions/build-native/action.yml"), "utf8"),
		]);

		expect(buildScript).toContain('Bun.env.PCRE2_SYS_STATIC = "1";');
		expect(action).toContain('PCRE2_SYS_STATIC: "1"');
	});

	it("rejects unsupported PI_NATIVE_PROFILE overrides before running a native build", async () => {
		const proc = Bun.spawn({
			cmd: ["bun", path.join(repoRoot, "packages/natives/scripts/build-native.ts")],
			cwd: repoRoot,
			env: {
				...process.env,
				PI_NATIVE_PROFILE: "bogus",
			},
			stdout: "pipe",
			stderr: "pipe",
		});

		const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("Unsupported PI_NATIVE_PROFILE: bogus");
	});
});

describe("native build Rust toolchain integration", () => {
	it.skipIf(process.platform === "win32")(
		"resolves cargo through CARGO_HOME rustup when neither rustup nor cargo is on PATH",
		async () => {
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-rustup-path-"));
			const cargoHome = path.join(tempDir, "cargo-home");
			const cargoBinary = path.join(cargoHome, "toolchains", "nightly", "bin", "cargo");
			const rustupBinary = path.join(cargoHome, "bin", "rustup");

			await fs.mkdir(path.dirname(rustupBinary), { recursive: true });
			await fs.mkdir(path.dirname(cargoBinary), { recursive: true });
			await Bun.write(
				rustupBinary,
				`#!/bin/sh
if [ "$1" = "which" ] && [ "$2" = "cargo" ]; then
	printf '%s\n' "${cargoBinary}"
	exit 0
fi
exit 1
`,
			);
			await fs.chmod(rustupBinary, 0o755);

			const previousCargoHome = Bun.env.CARGO_HOME;
			try {
				Bun.env.CARGO_HOME = cargoHome;
				const resolution = await resolveCargoToolchainPath({
					cwd: repoRoot,
					currentPath: "/usr/bin:/bin",
				});

				expect(resolution).toEqual({
					cargoBinary,
					toolchainBin: path.dirname(cargoBinary),
					pathValue: `${path.dirname(cargoBinary)}:/usr/bin:/bin`,
					source: "rustup",
				});
			} finally {
				if (previousCargoHome === undefined) {
					delete Bun.env.CARGO_HOME;
				} else {
					Bun.env.CARGO_HOME = previousCargoHome;
				}
				await fs.rm(tempDir, { recursive: true, force: true });
			}
		},
	);
});

describe("native build failure cleanup", () => {
	it.skipIf(process.platform === "win32")(
		"does not create a native .build directory when Cargo is unavailable",
		async () => {
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-missing-cargo-"));
			const before = await listNativeBuildDirs();

			try {
				const proc = Bun.spawn({
					cmd: [process.execPath, path.join(repoRoot, "packages/natives/scripts/build-native.ts")],
					cwd: repoRoot,
					env: {
						...process.env,
						CARGO_HOME: path.join(tempDir, "cargo-home"),
						HOME: path.join(tempDir, "home"),
						PATH: "/usr/bin:/bin",
					},
					stdout: "pipe",
					stderr: "pipe",
				});

				const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
				expect(exitCode).not.toBe(0);
				expect(stderr).toContain("Could not locate Cargo for native addon build");
				expect(await listNativeBuildDirs()).toEqual(before);
			} finally {
				await fs.rm(tempDir, { recursive: true, force: true });
			}
		},
	);
});

describe("native build Rust toolchain PATH", () => {
	it("prepends the rustup active toolchain cargo bin before invoking napi", () => {
		const resolution = resolveCargoToolchainPathFromCandidates({
			currentPath: "/usr/bin:/bin",
			pathSeparator: ":",
			pathCargoBinary: null,
			rustupCargoBinary: "/Users/example/.rustup/toolchains/nightly/bin/cargo",
		});

		expect(resolution).toEqual({
			cargoBinary: "/Users/example/.rustup/toolchains/nightly/bin/cargo",
			toolchainBin: "/Users/example/.rustup/toolchains/nightly/bin",
			pathValue: "/Users/example/.rustup/toolchains/nightly/bin:/usr/bin:/bin",
			source: "rustup",
		});
	});

	it("prefers rustup's active cargo over a different cargo already on PATH", () => {
		const resolution = resolveCargoToolchainPathFromCandidates({
			currentPath: "/opt/cargo/bin:/usr/bin",
			pathSeparator: ":",
			pathCargoBinary: "/opt/cargo/bin/cargo",
			rustupCargoBinary: "/Users/example/.rustup/toolchains/nightly/bin/cargo",
		});

		expect(resolution).toEqual({
			cargoBinary: "/Users/example/.rustup/toolchains/nightly/bin/cargo",
			toolchainBin: "/Users/example/.rustup/toolchains/nightly/bin",
			pathValue: "/Users/example/.rustup/toolchains/nightly/bin:/opt/cargo/bin:/usr/bin",
			source: "rustup",
		});
	});

	it("deduplicates an existing toolchain bin while preserving the remaining PATH order", () => {
		expect(prependPathEntry("/usr/bin:/toolchain/bin:/bin", "/toolchain/bin", ":")).toBe(
			"/toolchain/bin:/usr/bin:/bin",
		);
	});

	it("keeps a single toolchain entry when the current PATH only contains that entry", () => {
		expect(prependPathEntry("/toolchain/bin", "/toolchain/bin", ":")).toBe("/toolchain/bin");
	});

	it("supports Windows PATH separators when deduplicating a toolchain bin", () => {
		expect(prependPathEntry("C:\\Windows\\System32;C:\\Rust\\bin;C:\\Tools", "C:\\Rust\\bin", ";")).toBe(
			"C:\\Rust\\bin;C:\\Windows\\System32;C:\\Tools",
		);
	});

	it("falls back to a cargo binary already on PATH when rustup cannot resolve one", () => {
		const resolution = resolveCargoToolchainPathFromCandidates({
			currentPath: "/opt/cargo/bin:/usr/bin",
			pathSeparator: ":",
			pathCargoBinary: "/opt/cargo/bin/cargo",
			rustupCargoBinary: null,
		});

		expect(resolution).toEqual({
			cargoBinary: "/opt/cargo/bin/cargo",
			toolchainBin: "/opt/cargo/bin",
			pathValue: "/opt/cargo/bin:/usr/bin",
			source: "path",
		});
	});

	it("probes CARGO_HOME and the default cargo home when rustup is missing from PATH", () => {
		expect(
			resolveRustupCandidatePaths({
				currentPath: "/usr/bin:/bin",
				cargoHome: "/custom/cargo",
				homeDir: "/Users/example",
			}),
		).toEqual([
			path.join("/custom/cargo", "bin", rustupExecutableName),
			path.join("/Users/example", ".cargo", "bin", rustupExecutableName),
		]);
	});

	it("deduplicates CARGO_HOME when it matches the default cargo home", () => {
		expect(
			resolveRustupCandidatePaths({
				currentPath: "/usr/bin:/bin",
				cargoHome: "/Users/example/.cargo",
				homeDir: "/Users/example",
			}),
		).toEqual([path.join("/Users/example", ".cargo", "bin", rustupExecutableName)]);
	});
	it("returns null when neither rustup nor PATH can provide cargo", () => {
		expect(
			resolveCargoToolchainPathFromCandidates({
				currentPath: "/usr/bin:/bin",
				pathSeparator: ":",
				pathCargoBinary: null,
				rustupCargoBinary: null,
			}),
		).toBeNull();
	});

	it("treats whitespace-only cargo candidates as unavailable", () => {
		expect(
			resolveCargoToolchainPathFromCandidates({
				currentPath: "/usr/bin:/bin",
				pathSeparator: ":",
				pathCargoBinary: "  ",
				rustupCargoBinary: "\t",
			}),
		).toBeNull();
	});
});
