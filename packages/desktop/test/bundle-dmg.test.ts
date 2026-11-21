import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { bundleDmg } from "../scripts/bundle-dmg";

interface BundleFixture {
	root: string;
	app: string;
	output: string;
	outputDirectory: string;
	config: string;
}

async function withBundleFixture(run: (fixture: BundleFixture) => Promise<void>): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-bundle-dmg-test-"));
	const bundleDirectory = path.join(root, "src-tauri", "target", "release", "bundle");
	const app = path.join(bundleDirectory, "macos", "Fixture App.app");
	const outputDirectory = path.join(bundleDirectory, "dmg");
	const architecture = process.arch === "arm64" ? "aarch64" : process.arch;
	const output = path.join(outputDirectory, `Fixture App_1.2.3_${architecture}.dmg`);
	const config = path.join(root, "src-tauri", "tauri.conf.json");
	try {
		await fs.mkdir(path.join(app, "Contents", "MacOS"), { recursive: true });
		await Bun.write(config, JSON.stringify({ productName: "Fixture App", version: "1.2.3" }));
		await Bun.write(path.join(app, "Contents", "MacOS", "fixture"), "finalized executable fixture");
		await fs.chmod(path.join(app, "Contents", "MacOS", "fixture"), 0o755);
		await Bun.write(path.join(app, "Contents", "_CodeSignature", "CodeResources"), "sealed resources fixture");
		const framework = path.join(app, "Contents", "Frameworks", "Fixture.framework");
		await Bun.write(path.join(framework, "Versions", "A", "Fixture"), "framework fixture");
		await fs.symlink("A", path.join(framework, "Versions", "Current"));
		await fs.symlink("Versions/Current/Fixture", path.join(framework, "Fixture"));
		await fs.symlink("missing-resource", path.join(app, "Contents", "dangling-link"));
		await fs.mkdir(outputDirectory, { recursive: true });
		await Bun.write(output, "previous image fixture");
		await Bun.write(path.join(outputDirectory, "unrelated.txt"), "keep unrelated output");
		await run({ root, app, output, outputDirectory, config });
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

async function expectRetainedOutputs(fixture: BundleFixture, image: string): Promise<void> {
	expect((await fs.readdir(fixture.outputDirectory)).sort()).toEqual(
		[path.basename(fixture.output), "unrelated.txt"].sort(),
	);
	expect(await Bun.file(fixture.output).text()).toBe(image);
	expect(await Bun.file(path.join(fixture.outputDirectory, "unrelated.txt")).text()).toBe("keep unrelated output");
	expect(await Bun.file(path.join(fixture.app, "Contents", "_CodeSignature", "CodeResources")).text()).toBe(
		"sealed resources fixture",
	);
}

// Controlled runners below exercise packaging orchestration, not actual macOS
// signature validity. The real DMG requires separate mounted-app verification.
test("DMG packaging preserves finalized app contents and symlinks and verifies before creating UDZO", async () => {
	await withBundleFixture(async fixture => {
		const commands: string[][] = [];
		let stagedApp = "";
		const output = await bundleDmg(fixture.root, async command => {
			commands.push(command);
			if (command[0] === "codesign") {
				stagedApp = command.at(-1)!;
				expect(command).toEqual(["codesign", "--verify", "--deep", "--strict", stagedApp]);
				expect(stagedApp).not.toBe(fixture.app);
				expect(await Bun.file(path.join(stagedApp, "Contents", "MacOS", "fixture")).text()).toBe(
					"finalized executable fixture",
				);
				expect((await fs.stat(path.join(stagedApp, "Contents", "MacOS", "fixture"))).mode & 0o777).toBe(0o755);
				expect(await Bun.file(path.join(stagedApp, "Contents", "_CodeSignature", "CodeResources")).text()).toBe(
					"sealed resources fixture",
				);
				const framework = path.join(stagedApp, "Contents", "Frameworks", "Fixture.framework");
				expect(await fs.readlink(path.join(framework, "Versions", "Current"))).toBe("A");
				expect(await fs.readlink(path.join(framework, "Fixture"))).toBe("Versions/Current/Fixture");
				expect(await Bun.file(path.join(framework, "Fixture")).text()).toBe("framework fixture");
				expect(await fs.readlink(path.join(stagedApp, "Contents", "dangling-link"))).toBe("missing-resource");
				return;
			}
			expect(commands.map(args => args[0])).toEqual(["codesign", "hdiutil"]);
			const volume = path.dirname(stagedApp);
			const image = path.join(path.dirname(volume), "disk.dmg");
			expect(command).toEqual([
				"hdiutil",
				"create",
				"-volname",
				"Fixture App",
				"-srcfolder",
				volume,
				"-format",
				"UDZO",
				image,
			]);
			expect((await fs.readdir(volume)).sort()).toEqual(["Applications", "Fixture App.app"]);
			expect(await fs.readlink(path.join(volume, "Applications"))).toBe("/Applications");
			await Bun.write(image, "created image fixture");
		});
		expect(output).toBe(fixture.output);
		expect(commands).toHaveLength(2);
		expect(await Bun.file(path.join(stagedApp, "Contents", "MacOS", "fixture")).exists()).toBe(false);
		await expectRetainedOutputs(fixture, "created image fixture");
	});
});

test("DMG packaging stops on staged signature verification failure and cleans only owned staging", async () => {
	await withBundleFixture(async fixture => {
		const commands: string[][] = [];
		const failure = new Error("codesign fixture rejected sealed resources");
		await expect(
			bundleDmg(fixture.root, async command => {
				commands.push(command);
				throw failure;
			}),
		).rejects.toBe(failure);
		expect(commands.map(command => command[0])).toEqual(["codesign"]);
		await expectRetainedOutputs(fixture, "previous image fixture");
	});
});

test("DMG packaging propagates creation errors and removes partial temporary images without replacing output", async () => {
	await withBundleFixture(async fixture => {
		const commands: string[][] = [];
		const failure = new Error("hdiutil fixture failed while writing image");
		await expect(
			bundleDmg(fixture.root, async command => {
				commands.push(command);
				if (command[0] === "hdiutil") {
					await Bun.write(command.at(-1)!, "partial image fixture");
					throw failure;
				}
			}),
		).rejects.toBe(failure);
		expect(commands.map(command => command[0])).toEqual(["codesign", "hdiutil"]);
		await expectRetainedOutputs(fixture, "previous image fixture");
	});
});

test("DMG packaging rejects a successful command that produced no image and retains previous output", async () => {
	await withBundleFixture(async fixture => {
		const commands: string[][] = [];
		await expect(
			bundleDmg(fixture.root, async command => {
				commands.push(command);
			}),
		).rejects.toThrow("ENOENT");
		expect(commands.map(command => command[0])).toEqual(["codesign", "hdiutil"]);
		await expectRetainedOutputs(fixture, "previous image fixture");
	});
});

for (const field of ["productName", "version"] as const) {
	test(`DMG packaging rejects unsafe ${field} metadata before running commands or touching outputs`, async () => {
		await withBundleFixture(async fixture => {
			for (const value of [
				undefined,
				1,
				"",
				".",
				"..",
				"../escape",
				"/escape",
				"bad\\name",
				"bad:name",
				"bad\0name",
				" trailing ",
			]) {
				await Bun.write(
					fixture.config,
					JSON.stringify({ productName: "Fixture App", version: "1.2.3", [field]: value }),
				);
				let calls = 0;
				await expect(
					bundleDmg(fixture.root, async () => {
						calls++;
					}),
				).rejects.toThrow(`Tauri ${field}`);
				expect(calls).toBe(0);
				await expectRetainedOutputs(fixture, "previous image fixture");
			}
		});
	});
}

test("DMG packaging rejects a symlink in place of the finalized app without invoking commands", async () => {
	await withBundleFixture(async fixture => {
		const actualApp = `${fixture.app}.original`;
		await fs.rename(fixture.app, actualApp);
		await fs.symlink(actualApp, fixture.app);
		let calls = 0;
		await expect(
			bundleDmg(fixture.root, async () => {
				calls++;
			}),
		).rejects.toThrow("Expected a bundled app directory");
		expect(calls).toBe(0);
		await expectRetainedOutputs(fixture, "previous image fixture");
	});
});
