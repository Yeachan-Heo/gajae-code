import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..", "..");
const installScript = path.join(repoRoot, "scripts", "install.sh");

const EXISTING_BINARY = '#!/bin/sh\necho "gjc 0.8.1 (existing install)"\n';
const RELEASE_JSON = '{"tag_name": "v0.9.0"}';
const NEW_BINARY_CONTENT = "#!/bin/sh\necho new-binary\n";

interface Sandbox {
	root: string;
	shimDir: string;
	installDir: string;
}

let sandbox: Sandbox;

function writeCurlShim(dir: string, options: { downloadFails: boolean }): void {
	// Emulates curl just enough for install.sh: the GitHub API call returns a
	// release tag, and the asset download either succeeds (writing to the -o
	// target) or fails like `curl -f` does on an HTTP 404 (exit 22).
	const downloadBranch = options.downloadFails
		? "exit 22"
		: 'printf \'%s\' "$NEW_BINARY_CONTENT" > "$out"\nexit 0';
	const shim = [
		"#!/bin/sh",
		'for arg in "$@"; do',
		'  case "$arg" in',
		"    https://api.github.com/*)",
		`      printf '%s\\n' '${RELEASE_JSON}'`,
		"      exit 0",
		"      ;;",
		"  esac",
		"done",
		'out=""',
		'prev=""',
		'for arg in "$@"; do',
		'  if [ "$prev" = "-o" ]; then out="$arg"; fi',
		'  prev="$arg"',
		"done",
		'if [ -z "$out" ]; then exit 22; fi',
		downloadBranch,
		"",
	].join("\n");
	const shimPath = path.join(dir, "curl");
	fs.writeFileSync(shimPath, shim);
	fs.chmodSync(shimPath, 0o755);
}

async function runInstaller(): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(["sh", installScript, "--binary"], {
		env: {
			...process.env,
			PATH: `${sandbox.shimDir}:/usr/bin:/bin`,
			GJC_INSTALL_DIR: sandbox.installDir,
			NEW_BINARY_CONTENT,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
}

beforeEach(() => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-install-sh-"));
	const shimDir = path.join(root, "shim-bin");
	const installDir = path.join(root, "install");
	fs.mkdirSync(shimDir, { recursive: true });
	fs.mkdirSync(installDir, { recursive: true });
	sandbox = { root, shimDir, installDir };
});

afterEach(() => {
	fs.rmSync(sandbox.root, { recursive: true, force: true });
});

describe("install.sh binary upgrades", () => {
	test("a failed download leaves the existing gjc binary untouched", async () => {
		const existingPath = path.join(sandbox.installDir, "gjc");
		fs.writeFileSync(existingPath, EXISTING_BINARY);
		fs.chmodSync(existingPath, 0o755);
		writeCurlShim(sandbox.shimDir, { downloadFails: true });

		const result = await runInstaller();

		expect(result.exitCode).not.toBe(0);
		expect(fs.existsSync(existingPath)).toBe(true);
		expect(fs.readFileSync(existingPath, "utf8")).toBe(EXISTING_BINARY);
	});

	test("a successful download replaces the binary and leaves no temp files", async () => {
		const existingPath = path.join(sandbox.installDir, "gjc");
		fs.writeFileSync(existingPath, EXISTING_BINARY);
		fs.chmodSync(existingPath, 0o755);
		writeCurlShim(sandbox.shimDir, { downloadFails: false });

		const result = await runInstaller();

		expect(result.exitCode).toBe(0);
		expect(fs.readFileSync(existingPath, "utf8")).toBe(NEW_BINARY_CONTENT);
		// The install must be executable and must not leave partial download
		// artifacts next to the binary.
		expect(fs.statSync(existingPath).mode & 0o100).toBe(0o100);
		expect(fs.readdirSync(sandbox.installDir)).toEqual(["gjc"]);
	});
});
