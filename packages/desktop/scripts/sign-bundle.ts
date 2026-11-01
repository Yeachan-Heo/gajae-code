import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Ad-hoc sign the bundled macOS app.
 *
 * Tauri bundles the release binary as-is, so the main executable keeps its
 * linker-only signature while the bundle has no sealed resources: `codesign
 * --verify` then fails with "code has no resources but signature indicates they
 * must be present", and Gatekeeper treats every rebuild as a different app. A
 * stable designated requirement keeps the identity fixed across rebuilds so
 * macOS privacy decisions survive them.
 *
 * A configured release identity owns the signature, so this step stands down
 * whenever Tauri was given one.
 */
const ROOT = path.resolve(import.meta.dir, "..");
const BUNDLE_DIR = path.join(ROOT, "src-tauri", "target", "release", "bundle", "macos");

async function run(command: string[]): Promise<void> {
	const child = Bun.spawn(command, { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
	const code = await child.exited;
	if (code !== 0) throw new Error(`${command[0]} failed with exit code ${code}`);
}

async function configuredIdentity(): Promise<string | undefined> {
	if (process.env.APPLE_SIGNING_IDENTITY?.trim()) return process.env.APPLE_SIGNING_IDENTITY.trim();
	for (const file of ["tauri.bundle.conf.json", "tauri.conf.json"]) {
		const config = (await Bun.file(path.join(ROOT, "src-tauri", file)).json()) as {
			bundle?: { macOS?: { signingIdentity?: string } };
		};
		const identity = config.bundle?.macOS?.signingIdentity?.trim();
		if (identity) return identity;
	}
	return undefined;
}

async function bundledApp(): Promise<string> {
	const entries = await fs.readdir(BUNDLE_DIR).catch(() => [] as string[]);
	const apps = entries.filter(name => name.endsWith(".app"));
	if (apps.length !== 1) throw new Error(`Expected one bundled app in ${BUNDLE_DIR}, found ${apps.length}`);
	return path.join(BUNDLE_DIR, apps[0]!);
}

if (process.platform !== "darwin") {
	process.stdout.write("Bundle signing skipped: ad-hoc signing is macOS only\n");
} else {
	const identity = await configuredIdentity();
	if (identity) {
		process.stdout.write(`Bundle signing skipped: Tauri signed with ${identity}\n`);
	} else {
		const app = await bundledApp();
		const identifier = Bun.spawnSync([
			"defaults",
			"read",
			path.join(app, "Contents", "Info.plist"),
			"CFBundleIdentifier",
		])
			.stdout.toString()
			.trim();
		if (!identifier) throw new Error(`Cannot read CFBundleIdentifier from ${app}`);
		const requirementPath = path.join(os.tmpdir(), `gjc-bundle-${process.pid}-${crypto.randomUUID()}.req`);
		await Bun.write(requirementPath, `designated => identifier "${identifier}"\n`);
		try {
			await run([
				"codesign",
				"--force",
				"--deep",
				"--sign",
				"-",
				"--identifier",
				identifier,
				"--requirements",
				requirementPath,
				app,
			]);
		} finally {
			await fs.rm(requirementPath, { force: true });
		}
		await run(["codesign", "--verify", "--deep", "--strict", app]);
		process.stdout.write(`Ad-hoc signed ${path.basename(app)} as ${identifier}\n`);
	}
}
