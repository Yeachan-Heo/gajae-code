import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { prependPathEntry, resolveCargoToolchainPathFromCandidates } from "../scripts/rust-toolchain-path";

const repoRoot = path.join(import.meta.dir, "../../..");

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

describe("native build Cargo profiles", () => {
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
