import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const binWrapper = path.join(repoRoot, "packages", "gajae-code", "bin", "gjc.js");

let cleanupRoot: string | undefined;

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			text += decoder.decode(value, { stream: true });
		}
		return text + decoder.decode();
	} finally {
		reader.releaseLock();
	}
}

async function copyWrapperIntoInstallRoot(root: string): Promise<string> {
	const installedBinDir = path.join(root, "node_modules", "gajae-code", "bin");
	await fs.mkdir(installedBinDir, { recursive: true });
	const installedWrapper = path.join(installedBinDir, "gjc.js");
	await fs.copyFile(binWrapper, installedWrapper);
	return installedWrapper;
}

async function writeMockCodingAgentPackage(root: string): Promise<string> {
	const packageDir = path.join(root, "node_modules", "@gajae-code", "coding-agent");
	await fs.mkdir(packageDir, { recursive: true });
	const marker = path.join(root, "run-cli-argv.json");
	await fs.writeFile(
		path.join(packageDir, "package.json"),
		JSON.stringify(
			{
				type: "module",
				name: "@gajae-code/coding-agent",
				exports: { "./cli": "./cli.js" },
			},
			null,
			2,
		),
	);
	await fs.writeFile(
		path.join(packageDir, "cli.js"),
		`import { writeFileSync } from "node:fs";\nexport async function runCli(argv) {\n  writeFileSync(${JSON.stringify(marker)}, JSON.stringify(argv));\n  process.stdout.write("mock-run-cli\\n");\n}\n`,
	);
	return marker;
}

afterEach(async () => {
	if (cleanupRoot) {
		await fs.rm(cleanupRoot, { recursive: true, force: true });
		cleanupRoot = undefined;
	}
});

describe("gajae-code global bin wrapper", () => {
	it("invokes runCli from the installed coding-agent dependency instead of only side-effect importing it", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-global-bin-wrapper-"));
		cleanupRoot = root;
		const installedWrapper = await copyWrapperIntoInstallRoot(root);
		const marker = await writeMockCodingAgentPackage(root);

		const proc = Bun.spawn([process.execPath, installedWrapper, "--version", "extra"], {
			cwd: root,
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				NO_COLOR: "1",
			},
		});

		const [stdout, stderr, exitCode] = await Promise.all([
			readStream(proc.stdout as ReadableStream<Uint8Array>),
			readStream(proc.stderr as ReadableStream<Uint8Array>),
			proc.exited,
		]);

		expect(exitCode).toBe(0);
		expect(stderr).toBe("");
		expect(stdout).toBe("mock-run-cli\n");
		expect(JSON.parse(await fs.readFile(marker, "utf8"))).toEqual(["--version", "extra"]);
	}, 15_000);
});
