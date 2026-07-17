import { describe, expect, it } from "bun:test";
import * as path from "node:path";

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
