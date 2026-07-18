import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const packageRoot = path.join(repoRoot, "packages", "coding-agent");
const generator = path.join(packageRoot, "scripts", "generate-telegram-baseline-manifest.ts");
const runner = path.join(packageRoot, "scripts", "run-test-manifest.ts");
const checkedInManifest = path.join(packageRoot, "test", "manifests", "telegram-baseline-v1.json");
const tempDirs: string[] = [];
const sdkAdapterParityManifestPath = path.join(packageRoot, "test", "manifests", "sdk-adapter-parity-v1.json");

interface SpawnResult {
	exitCode: number | null;
	stdout?: { toString(): string };
	stderr?: { toString(): string };
}

interface BaselineManifest {
	version: 1;
	commands: { argv: string[] }[];
	excluded: { file: string; reason: string }[];
	required?: string[];
}

interface SdkAdapterParityManifest extends BaselineManifest {
	rows: { argv: string[] }[];
}

async function tempDir(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-telegram-manifest-"));
	tempDirs.push(directory);
	return directory;
}

async function writeManifest(directory: string, manifest: unknown): Promise<string> {
	await fs.mkdir(directory, { recursive: true });
	const manifestPath = path.join(directory, "manifest.json");
	await Bun.write(manifestPath, JSON.stringify(manifest));
	return manifestPath;
}

function run(script: string, args: string[], env?: Record<string, string>): SpawnResult {
	return Bun.spawnSync([process.execPath, script, ...args], {
		cwd: repoRoot,
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
}

function output(result: SpawnResult): string {
	return `${result.stdout?.toString() ?? ""}\n${result.stderr?.toString() ?? ""}`;
}

async function baselineManifest(): Promise<BaselineManifest> {
	return await Bun.file(checkedInManifest).json();
}

async function sdkAdapterParityManifest(): Promise<SdkAdapterParityManifest> {
	return await Bun.file(sdkAdapterParityManifestPath).json();
}

async function fakeBun(directory: string): Promise<{ binDirectory: string; log: string }> {
	const binDirectory = path.join(directory, "bin");
	const log = path.join(directory, "receipts.log");
	const command = path.join(binDirectory, process.platform === "win32" ? "bun.exe" : "bun");
	await fs.mkdir(binDirectory, { recursive: true });
	if (process.platform === "win32") {
		const source = path.join(directory, "fake-bun.ts");
		await Bun.write(
			source,
			'import { appendFile } from "node:fs/promises";\n\nconst args = process.argv.slice(2);\nawait appendFile(process.env.GJC_MANIFEST_RECEIPT_LOG!, args.join(" ") + "\\n");\nif (args.includes("fail-command.test.ts")) {\n\tconsole.log("1 fail");\n\tprocess.exit(1);\n}\nconsole.log("1 pass");\n',
		);
		const build = Bun.spawnSync([process.execPath, "build", source, "--compile", "--outfile", command]);
		if (build.exitCode !== 0) throw new Error(`failed to compile fake Bun: ${build.stderr?.toString() ?? ""}`);
	} else {
		await Bun.write(
			command,
			'#!/bin/sh\nprintf "%s\\n" "$*" >> "$GJC_MANIFEST_RECEIPT_LOG"\ncase "$*" in\n*fail-command.test.ts*) echo "1 fail"; exit 1 ;;\n*) echo "1 pass" ;;\nesac\n',
		);
		await fs.chmod(command, 0o755);
	}
	return { binDirectory, log };
}

afterEach(async () => {
	for (const directory of tempDirs.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

describe("telegram baseline manifest generator", () => {
	it("rejects missing, wrong, and unknown manifest versions", async () => {
		for (const version of [undefined, 0, 2, "1"]) {
			const directory = await tempDir();
			const manifest = await baselineManifest();
			if (version === undefined) delete (manifest as { version?: unknown }).version;
			else (manifest as { version: unknown }).version = version;
			const manifestPath = await writeManifest(directory, manifest);
			const result = run(generator, ["--check"], { GJC_TELEGRAM_BASELINE_MANIFEST: manifestPath });
			expect(result.exitCode, output(result)).toBe(1);
			expect(output(result)).toContain("Manifest version must be 1");
		}
	});

	it("rejects malformed commands, missing generated commands, blank exclusions, and a missing chat-adapters command", async () => {
		const cases: Array<{ mutate: (manifest: BaselineManifest) => void; message: string }> = [
			{
				mutate: manifest => {
					manifest.commands[0] = { argv: [] };
				},
				message: "Manifest command 0",
			},
			{
				mutate: manifest => {
					manifest.commands = manifest.commands.filter(
						command => !command.argv[2].endsWith("notifications-config.test.ts"),
					);
				},
				message: "notifications-config.test.ts",
			},
			{
				mutate: manifest => {
					manifest.excluded.push({ file: "packages/coding-agent/test/telegram-send-tool.test.ts", reason: "   " });
				},
				message: "Manifest excluded entry",
			},
			{
				mutate: manifest => {
					manifest.commands = manifest.commands.filter(
						command => !command.argv[2].endsWith("notifications-chat-adapters.test.ts"),
					);
				},
				message: "notifications-chat-adapters.test.ts",
			},
		];

		for (const { mutate, message } of cases) {
			const directory = await tempDir();
			const manifest = await baselineManifest();
			mutate(manifest);
			const manifestPath = await writeManifest(directory, manifest);
			const result = run(generator, ["--check"], { GJC_TELEGRAM_BASELINE_MANIFEST: manifestPath });
			expect(result.exitCode, output(result)).toBe(1);
			expect(output(result)).toContain(message);
		}
	});

	it("rejects a stale command", async () => {
		const directory = await tempDir();
		const manifest = await baselineManifest();
		manifest.commands.push({ argv: ["bun", "test", "packages/coding-agent/test/stale-telegram-baseline.test.ts"] });
		const manifestPath = await writeManifest(directory, manifest);
		const result = run(generator, ["--check"], { GJC_TELEGRAM_BASELINE_MANIFEST: manifestPath });
		expect(result.exitCode, output(result)).toBe(1);
		expect(output(result)).toContain(
			"stale command: bun test packages/coding-agent/test/stale-telegram-baseline.test.ts",
		);
	});

	it("rejects an unapproved exclusion even with a non-empty reason", async () => {
		const directory = await tempDir();
		const manifest = await baselineManifest();
		manifest.commands = manifest.commands.filter(command => !command.argv[2].endsWith("telegram-send-tool.test.ts"));
		manifest.excluded.push({
			file: "packages/coding-agent/test/telegram-send-tool.test.ts",
			reason: "Covered by the dedicated notification integration baseline.",
		});
		const manifestPath = await writeManifest(directory, manifest);
		const result = run(generator, ["--check"], { GJC_TELEGRAM_BASELINE_MANIFEST: manifestPath });
		expect(result.exitCode, output(result)).toBe(1);
		expect(output(result)).toContain("unapproved exclusion: packages/coding-agent/test/telegram-send-tool.test.ts");
	});

	it("rejects an empty commands array in a checked manifest", async () => {
		const directory = await tempDir();
		const manifestPath = await writeManifest(directory, { version: 1, commands: [], excluded: [] });
		const result = run(generator, ["--check"], { GJC_TELEGRAM_BASELINE_MANIFEST: manifestPath });
		expect(result.exitCode, output(result)).toBe(1);
		expect(output(result)).toContain("Manifest must contain at least one command.");
	});

	it("refuses to generate a manifest when discovery finds zero tests", async () => {
		const directory = await tempDir();
		const emptyTestDir = path.join(directory, "empty-tests");
		await fs.mkdir(emptyTestDir, { recursive: true });
		const manifestPath = path.join(directory, "generated.json");
		const result = run(generator, [], {
			GJC_TELEGRAM_BASELINE_MANIFEST: manifestPath,
			GJC_TELEGRAM_BASELINE_TEST_DIR: emptyTestDir,
		});
		expect(result.exitCode, output(result)).not.toBe(0);
		expect(output(result)).toContain("Manifest must contain at least one command.");
		expect(await Bun.file(manifestPath).exists()).toBe(false);
	});
});

describe("test manifest runner", () => {
	it("rejects invalid versions and malformed entries before execution", async () => {
		for (const manifest of [
			{ commands: [], excluded: [] },
			{ version: 2, commands: [], excluded: [] },
			{ version: "unknown", commands: [], excluded: [] },
			{ version: 1, commands: [{ argv: [] }], excluded: [] },
			{ version: 1, commands: [{ argv: ["bun", "-e", ""] }], excluded: [{ file: "test.ts", reason: "" }] },
		]) {
			const manifestPath = await writeManifest(await tempDir(), manifest);
			const result = run(runner, [manifestPath]);
			expect(result.exitCode, output(result)).toBe(2);
			expect(output(result)).toMatch(/Manifest version must be 1|Manifest command 0|Manifest excluded entry/);
		}
	});

	it("rejects an empty commands array before execution", async () => {
		const manifestPath = await writeManifest(await tempDir(), { version: 1, commands: [], excluded: [] });
		const result = run(runner, [manifestPath]);
		expect(result.exitCode, output(result)).toBe(2);
		expect(output(result)).toContain("Manifest must contain at least one command.");
	});

	it("rejects an exit-zero command that does not report tests", async () => {
		const manifestPath = await writeManifest(await tempDir(), {
			version: 1,
			commands: [{ argv: ["bun", "-e", ""] }],
			excluded: [],
		});
		const result = run(runner, [manifestPath]);
		expect(result.exitCode, output(result)).toBe(1);
		expect(output(result)).toContain("did not report at least one test");
	});

	it("fails closed when a required file is absent and accepts it when executable", async () => {
		const directory = await tempDir();
		const passingTest = path.join(directory, "passing.test.ts");
		const failingTest = path.join(directory, "failing.test.ts");
		await Bun.write(
			passingTest,
			'import { expect, test } from "bun:test"; test("passes", () => expect(true).toBe(true));\n',
		);
		await Bun.write(
			failingTest,
			'import { expect, test } from "bun:test"; test("fails", () => expect(true).toBe(false));\n',
		);

		const missingRequiredManifest = await writeManifest(directory, {
			version: 1,
			commands: [{ argv: ["bun", "test", passingTest] }],
			excluded: [],
			required: [failingTest],
		});
		const missingRequired = run(runner, [missingRequiredManifest]);
		expect(missingRequired.exitCode, output(missingRequired)).toBe(1);
		expect(output(missingRequired)).toContain(
			`Manifest required file is not covered by executable commands: ${failingTest}`,
		);

		const passingManifest = await writeManifest(path.join(directory, "success"), {
			version: 1,
			commands: [{ argv: ["bun", "test", passingTest] }],
			excluded: [],
			required: [passingTest],
		});
		const passing = run(runner, [passingManifest]);
		expect(passing.exitCode, output(passing)).toBe(0);
		expect(output(passing)).toContain(`receipt: bun test ${passingTest} exit=0 tests=1`);

		const failingManifest = await writeManifest(path.join(directory, "failure"), {
			version: 1,
			commands: [{ argv: ["bun", "test", failingTest] }],
			excluded: [],
		});
		const failing = run(runner, [failingManifest]);
		expect(failing.exitCode, output(failing)).toBe(1);
		expect(output(failing)).toContain("Manifest receipt failed");
		expect(output(failing)).toContain("exit 1");
	});

	it("rejects a required file that appears only as a non-positional argv token", async () => {
		const directory = await tempDir();
		const requiredTest = path.join(directory, "required.test.ts");
		await Bun.write(
			requiredTest,
			'import { expect, test } from "bun:test"; test("passes", () => expect(true).toBe(true));\n',
		);
		const manifestPath = await writeManifest(directory, {
			version: 1,
			commands: [{ argv: ["bun", "test", "--timeout", requiredTest] }],
			excluded: [],
			required: [requiredTest],
		});
		const result = run(runner, [manifestPath]);
		expect(result.exitCode, output(result)).toBe(1);
		expect(output(result)).toContain(`Manifest required file is not covered by executable commands: ${requiredTest}`);
	});
	it("rejects incomplete anchored partitions for a required parity file", async () => {
		const directory = await tempDir();
		const manifest = await sdkAdapterParityManifest();
		manifest.commands = manifest.commands.filter(command => command.argv[4] !== "^AD-L-");
		const manifestPath = await writeManifest(directory, manifest);
		const result = run(runner, [manifestPath]);
		expect(result.exitCode, output(result)).toBe(1);
		expect(output(result)).toContain(
			"Manifest required file is not covered by executable commands: packages/coding-agent/test/sdk-adapter-dispositions.test.ts",
		);
	});
	it("does not run parity rows after a behavioral command fails", async () => {
		const directory = await tempDir();
		const manifest = await sdkAdapterParityManifest();
		manifest.commands = [{ argv: ["bun", "test", "fail-command.test.ts"] }];
		delete manifest.required;
		const manifestPath = await writeManifest(directory, manifest);
		const fake = await fakeBun(directory);
		const result = run(runner, [manifestPath], {
			GJC_MANIFEST_RECEIPT_LOG: fake.log,
			PATH: `${fake.binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
		});

		expect(result.exitCode, output(result)).toBe(1);
		expect(output(result)).toContain("Manifest receipt failed: bun test fail-command.test.ts (exit 1)");
		expect(await Bun.file(fake.log).text()).toBe("test fail-command.test.ts\n");
	});

	it("runs behavioral commands and every parity row with separate receipts", async () => {
		const directory = await tempDir();
		const manifest = await sdkAdapterParityManifest();
		const manifestPath = await writeManifest(directory, manifest);
		const fake = await fakeBun(directory);
		const result = run(runner, [manifestPath], {
			GJC_MANIFEST_RECEIPT_LOG: fake.log,
			PATH: `${fake.binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
		});

		expect(result.exitCode, output(result)).toBe(0);
		expect(output(result)).toContain(`manifest command receipts complete: ${manifest.commands.length}`);
		expect(output(result)).toContain(
			"manifest row receipts complete: 546 (telegram=91, discord=91, slack=91, mcp=91, acp=91, daemonCli=91)",
		);
		const invocations = (await Bun.file(fake.log).text()).trim().split("\n");
		expect(invocations).toHaveLength(manifest.commands.length + manifest.rows.length);
		expect(invocations[0]).toBe(`test ${manifest.commands[0]?.argv.slice(2).join(" ")}`);
		expect(invocations.at(-1)).toBe(`test ${manifest.rows.at(-1)?.argv.slice(2).join(" ")}`);
	}, 300_000);
});

describe("gjc-sdk rename scanner", () => {
	it.skipIf(process.platform === "win32")("fails closed when a tracked file cannot be read", async () => {
		const directory = await tempDir();
		const scanRoot = path.join(directory, "repo");
		await fs.mkdir(scanRoot, { recursive: true });
		const git = (...args: string[]) =>
			Bun.spawnSync(["git", ...args], { cwd: scanRoot, stdout: "pipe", stderr: "pipe" });
		git("init");
		git("config", "user.email", "test@example.com");
		git("config", "user.name", "Test");
		await Bun.write(path.join(scanRoot, "clean.txt"), "no forbidden tokens here\n");
		git("add", "clean.txt");
		git("commit", "-m", "initial");
		await fs.chmod(path.join(scanRoot, "clean.txt"), 0o000);
		const scanner = path.join(packageRoot, "scripts", "verify-gjc-sdk-rename.ts");
		const result = run(scanner, [], { GJC_SDK_RENAME_SCAN_ROOT: scanRoot });
		await fs.chmod(path.join(scanRoot, "clean.txt"), 0o644);
		expect(result.exitCode, output(result)).toBe(2);
		expect(output(result)).toContain("Unable to scan tracked file clean.txt");
	});

	it("permits notification subsystem identifiers", async () => {
		const directory = await tempDir();
		const scanRoot = path.join(directory, "repo");
		await fs.mkdir(scanRoot, { recursive: true });
		const git = (...args: string[]) =>
			Bun.spawnSync(["git", ...args], { cwd: scanRoot, stdout: "pipe", stderr: "pipe" });
		git("init");
		git("config", "user.email", "test@example.com");
		git("config", "user.name", "Test");
		await Bun.write(
			path.join(scanRoot, "clean.txt"),
			"GJC_NOTIFICATIONS configures the notification daemon; gjc-notif-switch- is a temporary prefix.\n",
		);
		git("add", "clean.txt");
		git("commit", "-m", "initial");
		const scanner = path.join(packageRoot, "scripts", "verify-gjc-sdk-rename.ts");
		const result = run(scanner, [], { GJC_SDK_RENAME_SCAN_ROOT: scanRoot });

		expect(result.exitCode, output(result)).toBe(0);
	});

	it("rejects old SDK branding in tracked and untracked files", async () => {
		const directory = await tempDir();
		const scanRoot = path.join(directory, "repo");
		await fs.mkdir(scanRoot, { recursive: true });
		const git = (...args: string[]) =>
			Bun.spawnSync(["git", ...args], { cwd: scanRoot, stdout: "pipe", stderr: "pipe" });
		git("init");
		git("config", "user.email", "test@example.com");
		git("config", "user.name", "Test");
		await Bun.write(
			path.join(scanRoot, "clean.txt"),
			`${[["Notifications", "SDK"].join(" "), ["NOTIFICATIONS", "SDK"].join("-")].join("\n")}\n`,
		);
		git("add", "clean.txt");
		git("commit", "-m", "initial");

		const legacyPath = path.join("src", "notifications", "legacy.ts");
		const legacyPosixPath = legacyPath.replaceAll("\\", "/");
		await fs.mkdir(path.join(scanRoot, path.dirname(legacyPath)), { recursive: true });
		await Bun.write(path.join(scanRoot, legacyPath), `${["use", ["gjc", "notifications"].join("_")].join(" ")}\n`);
		const scanner = path.join(packageRoot, "scripts", "verify-gjc-sdk-rename.ts");
		const result = run(scanner, [], { GJC_SDK_RENAME_SCAN_ROOT: scanRoot });

		expect(result.exitCode, output(result)).toBe(1);
		expect(output(result)).toContain(`clean.txt:1: forbidden ${JSON.stringify(["notifications", "SDK"].join(" "))}`);
		expect(output(result)).toContain(`clean.txt:2: forbidden ${JSON.stringify(["notifications", "SDK"].join(" "))}`);
		expect(output(result)).toContain(
			`${legacyPosixPath}: forbidden filename ${JSON.stringify(["src", "notifications", ""].join("/"))}`,
		);
		expect(output(result)).toContain(
			`${legacyPosixPath}:1: forbidden ${JSON.stringify(["gjc", "notifications"].join("_"))}`,
		);
	});
});
