import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * The read-only diagnostic loader refuses any addon whose bytes are not the ones
 * recorded in `packages/natives/native/diagnostic-artifact.json`. That record is
 * written where the addon is built, but release addons travel to other checkouts as
 * bare `.node` uploads, so the record has to travel with them and be re-proved at
 * the packaging boundary. This suite covers that transfer and its guards with local
 * fixtures only: no network, no publish.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "..");

const SCRIPT = path.join(REPO_ROOT, "scripts", "verify-diagnostic-artifact-provenance.ts");
const NATIVES_PACKAGE = path.join(REPO_ROOT, "packages", "natives");

async function sha256(file: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(new Uint8Array(await Bun.file(file).arrayBuffer()));
	return hasher.digest("hex");
}

async function run(
	argv: string[],
	cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const child = Bun.spawnSync({
		cmd: [process.execPath, SCRIPT, ...argv],
		cwd,
		env: { PATH: "/usr/bin:/bin", HOME: cwd, TMPDIR: cwd },
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		exitCode: child.exitCode ?? -1,
		stdout: new TextDecoder().decode(child.stdout ?? new Uint8Array()),
		stderr: new TextDecoder().decode(child.stderr ?? new Uint8Array()),
	};
}

/** A natives-package-shaped fixture: `package.json` plus a `native/` directory. */
async function fixturePackage(
	workspace: string,
	options: { version?: string; addons?: Record<string, string>; sidecars?: "matching" | "mismatched" | "none" } = {},
): Promise<{ root: string; native: string; version: string }> {
	const root = path.join(workspace, "natives");
	const native = path.join(root, "native");
	await fs.mkdir(native, { recursive: true });
	const version = options.version ?? "9.9.9-fixture";
	await Bun.write(path.join(root, "package.json"), JSON.stringify({ name: "@gajae-code/natives", version }));
	const addons = options.addons ?? { "pi_natives.darwin-arm64.node": "addon-bytes-arm64" };
	for (const [name, bytes] of Object.entries(addons)) {
		const file = path.join(native, name);
		await Bun.write(file, bytes);
		if ((options.sidecars ?? "matching") === "none") continue;
		const digest =
			(options.sidecars ?? "matching") === "matching" ? await sha256(file) : "0".repeat(64);
		await Bun.write(
			`${file}.provenance.json`,
			JSON.stringify({ schema: "gjc.diagnostic-artifact-provenance", version, artifact: name, sha256: digest }),
		);
	}
	return { root, native, version };
}

describe("diagnostic artifact provenance transfer (C2)", () => {
	it("rebuilds the trusted record from the transferred sidecars", async () => {
		const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-prov-rebuild-"));
		try {
			const fixture = await fixturePackage(workspace, {
				addons: {
					"pi_natives.darwin-arm64.node": "arm64-bytes",
					"pi_natives.linux-x64-modern.node": "linux-bytes",
				},
			});
			const result = await run(["--rebuild-from-sidecars", fixture.native], workspace);
			expect(result.exitCode).toBe(0);
			const manifest = (await Bun.file(path.join(fixture.native, "diagnostic-artifact.json")).json()) as {
				schema: string;
				version: string;
				artifacts: Record<string, string>;
			};
			expect(manifest.schema).toBe("gjc.diagnostic-artifact");
			// The version comes from the package being shipped, not from the sidecar, so a
			// nightly version staged after the build cannot leave a stale record behind.
			expect(manifest.version).toBe(fixture.version);
			expect(manifest.artifacts).toEqual({
				"pi_natives.darwin-arm64.node": await sha256(path.join(fixture.native, "pi_natives.darwin-arm64.node")),
				"pi_natives.linux-x64-modern.node": await sha256(
					path.join(fixture.native, "pi_natives.linux-x64-modern.node"),
				),
			});
			expect((await run(["--verify", fixture.native], workspace)).exitCode).toBe(0);
		} finally {
			await fs.rm(workspace, { recursive: true, force: true });
		}
	});

	it("refuses an addon that arrived without its provenance sidecar", async () => {
		const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-prov-missing-"));
		try {
			const fixture = await fixturePackage(workspace, { sidecars: "none" });
			const result = await run(["--rebuild-from-sidecars", fixture.native], workspace);
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("pi_natives.darwin-arm64.node");
			expect(await Bun.file(path.join(fixture.native, "diagnostic-artifact.json")).exists()).toBe(false);
		} finally {
			await fs.rm(workspace, { recursive: true, force: true });
		}
	});

	it("refuses a sidecar whose digest does not match the transferred bytes", async () => {
		const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-prov-mismatch-"));
		try {
			const fixture = await fixturePackage(workspace, { sidecars: "mismatched" });
			const result = await run(["--rebuild-from-sidecars", fixture.native], workspace);
			expect(result.exitCode).not.toBe(0);
			expect(await Bun.file(path.join(fixture.native, "diagnostic-artifact.json")).exists()).toBe(false);
		} finally {
			await fs.rm(workspace, { recursive: true, force: true });
		}
	});

	it("fails the verify gate on a stale version or stale digest", async () => {
		const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-prov-stale-"));
		try {
			const fixture = await fixturePackage(workspace);
			const manifestPath = path.join(fixture.native, "diagnostic-artifact.json");
			const addon = path.join(fixture.native, "pi_natives.darwin-arm64.node");

			await Bun.write(
				manifestPath,
				JSON.stringify({
					schema: "gjc.diagnostic-artifact",
					version: "0.0.0-stale",
					artifacts: { "pi_natives.darwin-arm64.node": await sha256(addon) },
				}),
			);
			const staleVersion = await run(["--verify", fixture.native], workspace);
			expect(staleVersion.exitCode).not.toBe(0);
			expect(staleVersion.stderr).toContain("0.0.0-stale");

			await Bun.write(
				manifestPath,
				JSON.stringify({
					schema: "gjc.diagnostic-artifact",
					version: fixture.version,
					artifacts: { "pi_natives.darwin-arm64.node": "1".repeat(64) },
				}),
			);
			expect((await run(["--verify", fixture.native], workspace)).exitCode).not.toBe(0);
		} finally {
			await fs.rm(workspace, { recursive: true, force: true });
		}
	});

	it("gates platform-package staging on byte equality with the trusted record", async () => {
		const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-prov-stage-"));
		try {
			const fixture = await fixturePackage(workspace);
			expect((await run(["--rebuild-from-sidecars", fixture.native], workspace)).exitCode).toBe(0);
			const staged = path.join(workspace, "platform", "native");
			await fs.mkdir(staged, { recursive: true });
			await fs.copyFile(
				path.join(fixture.native, "pi_natives.darwin-arm64.node"),
				path.join(staged, "pi_natives.darwin-arm64.node"),
			);
			expect(
				(await run(["--stage-check", staged, "--trusted-native-dir", fixture.native], workspace)).exitCode,
			).toBe(0);

			await Bun.write(path.join(staged, "pi_natives.darwin-arm64.node"), "different-bytes");
			const mismatch = await run(["--stage-check", staged, "--trusted-native-dir", fixture.native], workspace);
			expect(mismatch.exitCode).not.toBe(0);
			expect(mismatch.stderr).toContain("pi_natives.darwin-arm64.node");
		} finally {
			await fs.rm(workspace, { recursive: true, force: true });
		}
	});

	it("never hides a build-version drift behind the re-stamped record", async () => {
		const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-prov-drift-"));
		try {
			// The sidecar was produced by a build at 9.9.9-fixture; the package now ships
			// 9.9.10-nightly. Re-stamping the record must not paper over that: the drift is
			// reported and recorded, and the runtime binding check still refuses an addon
			// whose own nativeBuildInfo() disagrees with the shipped version.
			const fixture = await fixturePackage(workspace);
			await Bun.write(
				path.join(fixture.root, "package.json"),
				JSON.stringify({ name: "@gajae-code/natives", version: "9.9.10-nightly" }),
			);
			const result = await run(["--rebuild-from-sidecars", fixture.native], workspace);
			expect(result.exitCode).toBe(0);
			expect(`${result.stdout}${result.stderr}`).toContain("9.9.9-fixture");
			const manifest = (await Bun.file(path.join(fixture.native, "diagnostic-artifact.json")).json()) as {
				version: string;
				buildVersions?: Record<string, string>;
			};
			expect(manifest.version).toBe("9.9.10-nightly");
			expect(manifest.buildVersions).toEqual({ "pi_natives.darwin-arm64.node": "9.9.9-fixture" });

			const { validateDiagnosticBinding } = (await import(
				path.join(REPO_ROOT, "packages", "natives", "native", "diagnostic-loader.js")
			)) as { validateDiagnosticBinding: (binding: unknown, expectedVersion: string) => boolean };
			const driftedAddon = {
				diagnosticSnapshotOpen: () => undefined,
				nativeBuildInfo: () => ({ version: "9.9.9-fixture" }),
			};
			expect(validateDiagnosticBinding(driftedAddon, "9.9.10-nightly")).toBe(false);
			expect(validateDiagnosticBinding(driftedAddon, "9.9.9-fixture")).toBe(true);
		} finally {
			await fs.rm(workspace, { recursive: true, force: true });
		}
	});

	it("packs the trusted record into the real natives tarball", async () => {
		const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-prov-pack-"));
		try {
			const packed = Bun.spawnSync({
				cmd: [process.execPath, "pm", "pack", "--destination", workspace],
				cwd: NATIVES_PACKAGE,
				env: { PATH: "/usr/bin:/bin", HOME: workspace, TMPDIR: workspace },
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(packed.exitCode).toBe(0);
			const tarballs = (await fs.readdir(workspace)).filter(entry => entry.endsWith(".tgz"));
			expect(tarballs.length).toBe(1);
			const listed = Bun.spawnSync({
				cmd: ["/usr/bin/tar", "-tzf", path.join(workspace, tarballs[0]!)],
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(listed.exitCode).toBe(0);
			const entries = new TextDecoder().decode(listed.stdout ?? new Uint8Array()).split("\n");
			expect(entries).toContain("package/native/diagnostic-artifact.json");
			expect(entries).toContain("package/native/diagnostic-loader.js");
		} finally {
			await fs.rm(workspace, { recursive: true, force: true });
		}
	}, 120_000);

	it("keeps the shipped record in step with the built addon in this checkout", async () => {
		// The runner gets a task-owned HOME/TMPDIR even though it inspects the real
		// package directory, so nothing is written inside the checkout.
		const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-prov-checkout-"));
		try {
			const result = await run(["--verify", path.join(NATIVES_PACKAGE, "native")], workspace);
			expect(result.exitCode).toBe(0);
		} finally {
			await fs.rm(workspace, { recursive: true, force: true });
		}
	});
});
