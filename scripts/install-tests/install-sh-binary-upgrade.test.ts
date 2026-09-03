import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..", "..");
const installScript = path.join(repoRoot, "scripts", "install.sh");
const rootInstallScript = path.join(repoRoot, "install.sh");

const EXISTING_BINARY = '#!/bin/sh\necho "gjc 0.8.1 (existing install)"\n';
const VERSION = "0.9.0";
const TAG = `v${VERSION}`;

function hostBinaryName(): string {
	const osName = process.platform === "darwin" ? "darwin" : "linux";
	const arch = process.arch === "arm64" ? "arm64" : "x64";
	return `gjc-${osName}-${arch}`;
}

function sha256(content: string | Buffer): string {
	return crypto.createHash("sha256").update(content).digest("hex");
}

function fakeGjcScript(options: { version: string; smokeFails?: boolean; truncated?: boolean }): string {
	if (options.truncated) return "truncated";
	const smoke = options.smokeFails ? "exit 1" : "exit 0";
	return [
		"#!/bin/sh",
		`if [ "$1" = "--version" ]; then echo "gjc/${options.version}"; exit 0; fi`,
		`if [ "$1" = "--smoke-test" ]; then ${smoke}; fi`,
		"echo new-binary",
		"exit 0",
		"",
	].join("\n");
}

interface Sandbox {
	root: string;
	shimDir: string;
	installDir: string;
}

let sandbox: Sandbox;

interface CurlFixture {
	latestJson?: string;
	tagJson?: Record<string, string>;
	releasesJson?: string;
	assets: Record<string, string | Buffer>;
	missingAssets?: string[];
	failDownload?: boolean;
	emptyDownload?: boolean;
}

function writeCurlShim(dir: string, fixture: CurlFixture): void {
	const fixturePath = path.join(dir, "fixture.json");
	fs.writeFileSync(
		fixturePath,
		JSON.stringify({
			latestJson: fixture.latestJson ?? JSON.stringify({ tag_name: TAG, draft: false, prerelease: false }),
			tagJson: fixture.tagJson ?? {},
			releasesJson:
				fixture.releasesJson ??
				JSON.stringify(
					[
						{ tag_name: "v0.9.1-nightly.1.1.gabc", draft: false, prerelease: true },
						{ tag_name: TAG, draft: false, prerelease: false },
					],
					null,
					2,
				),
			assets: Object.fromEntries(
				Object.entries(fixture.assets).map(([name, body]) => [
					name,
					Buffer.isBuffer(body) ? body.toString("base64") : Buffer.from(body).toString("base64"),
				]),
			),
			missingAssets: fixture.missingAssets ?? [],
			failDownload: fixture.failDownload === true,
			emptyDownload: fixture.emptyDownload === true,
		}),
	);
	const shim = `#!/bin/sh
FIXTURE="${fixturePath}"
out=""
url=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then out="$arg"; fi
  case "$arg" in
    https://*|http://*) url="$arg" ;;
  esac
  prev="$arg"
done
python3 - "$FIXTURE" "$url" "$out" <<'PY'
import json, os, sys
fixture = json.load(open(sys.argv[1]))
url = sys.argv[2]
out = sys.argv[3] if len(sys.argv) > 3 else ""
def write(data: bytes, code: int = 0, http: str = "200"):
    if out:
        open(out, "wb").write(data)
    sys.stdout.write(http)
    sys.exit(code)
if "api.github.com" in url and "/releases/latest" in url:
    write(fixture["latestJson"].encode())
if "api.github.com" in url and "/releases?per_page" in url:
    write(fixture["releasesJson"].encode())
if "api.github.com" in url and "/releases/tags/" in url:
    tag = url.rsplit("/", 1)[-1]
    payload = fixture.get("tagJson", {}).get(tag) or json.dumps({"tag_name": tag})
    write(payload.encode())
if fixture.get("failDownload"):
    sys.exit(22)
name = url.rsplit("/", 1)[-1]
if name in fixture.get("missingAssets", []):
    if name.endswith(".sha256") or name.endswith(".json"):
        write(b"", 0, "404")
    sys.exit(22)
if fixture.get("emptyDownload") and not name.endswith(".sha256") and not name.endswith(".json"):
    write(b"", 0)
assets = fixture.get("assets", {})
if name in assets:
    write(__import__("base64").b64decode(assets[name]))
if name.endswith(".sha256") or name.endswith("gajae-release-binaries-v1.json"):
    write(b"", 0, "404")
sys.exit(22)
PY
`;
	const shimPath = path.join(dir, "curl");
	fs.writeFileSync(shimPath, shim);
	fs.chmodSync(shimPath, 0o755);
}

function writeFailingBun(dir: string): void {
	const bunPath = path.join(dir, "bun");
	fs.writeFileSync(bunPath, "#!/bin/sh\necho 'bun should not run' >&2\nexit 99\n");
	fs.chmodSync(bunPath, 0o755);
}

function writeRecordingBun(dir: string): void {
	const bunPath = path.join(dir, "bun");
	const shim = `#!/bin/sh
printf '%s\n' "$*" >> "\${GJC_DEV_COMMAND_LOG:?}"
printf '%s\n' "$(pwd)" >> "\${GJC_DEV_CWD_LOG:?}"
case "$*" in
  "run build"|"run install:dev:bin") exit 0 ;;
  *) echo "unexpected bun command: $*" >&2; exit 98 ;;
esac
`;
	fs.writeFileSync(bunPath, shim);
	fs.chmodSync(bunPath, 0o755);
}

interface InstallerOptions {
	cwd?: string;
	script?: string;
}

async function runInstaller(
	args: string[],
	env: Record<string, string> = {},
	options: InstallerOptions = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(["sh", options.script ?? installScript, ...args], {
		cwd: options.cwd ?? repoRoot,
		env: {
			...process.env,
			PATH: `${sandbox.shimDir}:/usr/bin:/bin`,
			GJC_INSTALL_DIR: sandbox.installDir,
			HOME: sandbox.root,
			GITHUB_TOKEN: "",
			GH_TOKEN: "",
			...env,
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

async function runPipedInstaller(
	args: string[],
	env: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(["sh", "-s", "--", ...args], {
		cwd: repoRoot,
		stdin: "pipe",
		env: {
			...process.env,
			PATH: `${sandbox.shimDir}:/usr/bin:/bin`,
			GJC_INSTALL_DIR: sandbox.installDir,
			HOME: sandbox.root,
			GITHUB_TOKEN: "",
			GH_TOKEN: "",
			...env,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	proc.stdin.write(await Bun.file(installScript).text());
	proc.stdin.end();
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
	writeFailingBun(shimDir);
});

afterEach(() => {
	fs.rmSync(sandbox.root, { recursive: true, force: true });
});

describe("install.sh binary-first contract", () => {
	test("never installs or invokes bun on the default path, even when bun is present", async () => {
		const installer = await Bun.file(installScript).text();
		expect(installer).not.toContain("bun.sh/install");
		expect(installer).toContain("never downloads Bun");
		expect(installer).toContain('MODE="binary"');
		expect(installer).not.toContain("Default: use bun if available");

		const binaryName = hostBinaryName();
		const payload = fakeGjcScript({ version: VERSION });
		writeCurlShim(sandbox.shimDir, {
			assets: {
				[binaryName]: payload,
				"gajae-release-binaries.sha256": `${sha256(payload)}  ${binaryName}\n`,
			},
		});
		const result = await runInstaller([]);
		expect(result.stderr).not.toContain("bun should not run");
		expect(result.exitCode).toBe(0);
		expect(fs.readFileSync(path.join(sandbox.installDir, "gjc"), "utf8")).toBe(payload);
	});

	test("documents --dev in installer help", async () => {
		const result = await runInstaller(["--help"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("--dev");
		expect(result.stdout).toContain("current checkout");
	});

	test("--dev runs the build and install shortcuts from the checkout root", async () => {
		const commandLog = path.join(sandbox.root, "bun-commands.log");
		const cwdLog = path.join(sandbox.root, "bun-cwds.log");
		writeRecordingBun(sandbox.shimDir);

		const result = await runInstaller(
			["--dev"],
			{
				GJC_DEV_COMMAND_LOG: commandLog,
				GJC_DEV_CWD_LOG: cwdLog,
			},
			{ cwd: sandbox.root },
		);

		expect(result.exitCode).toBe(0);
		expect(fs.readFileSync(commandLog, "utf8").trim().split("\n")).toEqual(["run build", "run install:dev:bin"]);
		expect(fs.readFileSync(cwdLog, "utf8").trim().split("\n")).toEqual([repoRoot, repoRoot]);
	});

	test("--dev rejects a non-checkout script without invoking Bun", async () => {
		const script = path.join(sandbox.root, "not-a-checkout", "scripts", "install.sh");
		fs.mkdirSync(path.dirname(script), { recursive: true });
		fs.copyFileSync(installScript, script);
		const commandLog = path.join(sandbox.root, "bun-commands.log");
		writeRecordingBun(sandbox.shimDir);

		const result = await runInstaller(
			["--dev"],
			{
				GJC_DEV_COMMAND_LOG: commandLog,
				GJC_DEV_CWD_LOG: path.join(sandbox.root, "bun-cwds.log"),
			},
			{ cwd: sandbox.root, script },
		);

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr + result.stdout).toContain("GJC checkout");
		expect(fs.existsSync(commandLog)).toBe(false);
	});

	test("--dev rejects piped installers without invoking Bun", async () => {
		const commandLog = path.join(sandbox.root, "bun-commands.log");
		writeRecordingBun(sandbox.shimDir);

		const result = await runPipedInstaller(["--dev"], {
			GJC_DEV_COMMAND_LOG: commandLog,
			GJC_DEV_CWD_LOG: path.join(sandbox.root, "bun-cwds.log"),
		});

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr + result.stdout).toContain("piped");
		expect(fs.existsSync(commandLog)).toBe(false);
	});

	test("--dev requires Bun without falling back to a release download", async () => {
		const result = await runInstaller(["--dev"], { PATH: "/usr/bin:/bin" });
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr + result.stdout).toMatch(/requires an existing Bun/i);
		expect(fs.readdirSync(sandbox.installDir)).toEqual([]);
	});

	test("--dev rejects release options that would be ignored", async () => {
		for (const args of [
			["--dev", "--ref", "v0.15.0"],
			["--dev", "--channel", "nightly"],
		]) {
			const result = await runInstaller(args);
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr + result.stdout).toContain("--dev cannot be combined");
		}
	});

	test("root install.sh execs the canonical scripts/install.sh from a clone", async () => {
		const root = await Bun.file(rootInstallScript).text();
		expect(root).toContain("scripts/install.sh");
		expect(root).toContain("https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/main/scripts/install.sh");
		expect(root).not.toContain("exec sh \"$TMP\"");
		const binaryName = hostBinaryName();
		const payload = fakeGjcScript({ version: VERSION });
		writeCurlShim(sandbox.shimDir, {
			assets: {
				[binaryName]: payload,
				"gajae-release-binaries.sha256": `${sha256(payload)}  ${binaryName}\n`,
			},
		});
		const proc = Bun.spawn(["sh", rootInstallScript], {
			env: {
				...process.env,
				PATH: `${sandbox.shimDir}:/usr/bin:/bin`,
				GJC_INSTALL_DIR: sandbox.installDir,
				HOME: sandbox.root,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		expect(exitCode).toBe(0);
		expect(fs.readFileSync(path.join(sandbox.installDir, "gjc"), "utf8")).toBe(payload);
	});

	test("a failed download leaves the existing gjc binary untouched", async () => {
		const existingPath = path.join(sandbox.installDir, "gjc");
		fs.writeFileSync(existingPath, EXISTING_BINARY);
		fs.chmodSync(existingPath, 0o755);
		writeCurlShim(sandbox.shimDir, { assets: {}, failDownload: true });

		const result = await runInstaller(["--binary"]);

		expect(result.exitCode).not.toBe(0);
		expect(fs.readFileSync(existingPath, "utf8")).toBe(EXISTING_BINARY);
	});

	test("an empty download leaves the existing gjc binary untouched", async () => {
		const existingPath = path.join(sandbox.installDir, "gjc");
		fs.writeFileSync(existingPath, EXISTING_BINARY);
		fs.chmodSync(existingPath, 0o755);
		writeCurlShim(sandbox.shimDir, { assets: { [hostBinaryName()]: "" }, emptyDownload: true });

		const result = await runInstaller([]);
		expect(result.exitCode).not.toBe(0);
		expect(fs.readFileSync(existingPath, "utf8")).toBe(EXISTING_BINARY);
	});

	test("checksum mismatch leaves the existing binary untouched", async () => {
		const existingPath = path.join(sandbox.installDir, "gjc");
		fs.writeFileSync(existingPath, EXISTING_BINARY);
		fs.chmodSync(existingPath, 0o755);
		const payload = fakeGjcScript({ version: VERSION });
		writeCurlShim(sandbox.shimDir, {
			assets: {
				[hostBinaryName()]: payload,
				"gajae-release-binaries.sha256": `${"a".repeat(64)}  ${hostBinaryName()}\n`,
			},
		});
		const result = await runInstaller([]);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr + result.stdout).toContain("Checksum mismatch");
		expect(fs.readFileSync(existingPath, "utf8")).toBe(EXISTING_BINARY);
	});

	test("version/smoke failure restores the previous binary", async () => {
		const existingPath = path.join(sandbox.installDir, "gjc");
		fs.writeFileSync(existingPath, EXISTING_BINARY);
		fs.chmodSync(existingPath, 0o755);
		const payload = fakeGjcScript({ version: "9.9.9", smokeFails: true });
		writeCurlShim(sandbox.shimDir, {
			assets: {
				[hostBinaryName()]: payload,
				"gajae-release-binaries.sha256": `${sha256(payload)}  ${hostBinaryName()}\n`,
			},
		});
		const result = await runInstaller([]);
		expect(result.exitCode).not.toBe(0);
		expect(fs.readFileSync(existingPath, "utf8")).toBe(EXISTING_BINARY);
	});

	test("a successful download replaces the binary, verifies, and leaves no temp files", async () => {
		const existingPath = path.join(sandbox.installDir, "gjc");
		fs.writeFileSync(existingPath, EXISTING_BINARY);
		fs.chmodSync(existingPath, 0o755);
		const payload = fakeGjcScript({ version: VERSION });
		writeCurlShim(sandbox.shimDir, {
			assets: {
				[hostBinaryName()]: payload,
				"gajae-release-binaries.sha256": `${sha256(payload)}  ${hostBinaryName()}\n`,
			},
		});

		const result = await runInstaller(["--binary"]);
		expect(result.exitCode).toBe(0);
		expect(fs.readFileSync(existingPath, "utf8")).toBe(payload);
		expect(fs.statSync(existingPath).mode & 0o100).toBe(0o100);
		const leftover = fs.readdirSync(sandbox.installDir).filter(name => name !== "gjc");
		expect(leftover).toEqual([]);
	});

	test("installs an explicit release tag as a binary without switching to source", async () => {
		const payload = fakeGjcScript({ version: "0.15.0" });
		writeCurlShim(sandbox.shimDir, {
			tagJson: { "v0.15.0": JSON.stringify({ tag_name: "v0.15.0" }) },
			assets: {
				[hostBinaryName()]: payload,
				"gajae-release-binaries.sha256": `${sha256(payload)}  ${hostBinaryName()}\n`,
			},
		});
		const result = await runInstaller(["--ref", "v0.15.0"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Using version: v0.15.0");
		expect(fs.readFileSync(path.join(sandbox.installDir, "gjc"), "utf8")).toBe(payload);
	});

	test("rejects path-traversal tags", async () => {
		writeCurlShim(sandbox.shimDir, { assets: {} });
		const result = await runInstaller(["--ref", "v1.0.0/../../evil"]);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr + result.stdout).toContain("Invalid --ref");
	});

	test("selects a nightly GitHub prerelease", async () => {
		const nightly = "0.9.1-nightly.1.1.gabc";
		const payload = fakeGjcScript({ version: nightly });
		writeCurlShim(sandbox.shimDir, {
			assets: {
				[hostBinaryName()]: payload,
				"gajae-release-binaries.sha256": `${sha256(payload)}  ${hostBinaryName()}\n`,
			},
		});
		const result = await runInstaller(["--channel", "nightly"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(`Using version: v${nightly}`);
	});

	test("--source without bun fails and never downloads bun", async () => {
		writeCurlShim(sandbox.shimDir, { assets: {} });
		const result = await runInstaller(["--source"], {
			PATH: "/usr/bin:/bin",
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr + result.stdout).not.toContain("Installing bun");
		expect(result.stderr + result.stdout).toMatch(/requires an existing Bun/i);
	});

	test("supported platform names are the published release assets", async () => {
		const installer = await Bun.file(installScript).text();
		expect(installer).toContain("gjc-${PLATFORM}-${ARCH}");
		expect(installer).toContain('PLATFORM="linux"');
		expect(installer).toContain('PLATFORM="darwin"');
		expect(installer).toContain('ARCH="x64"');
		expect(installer).toContain('ARCH="arm64"');
	});

	test("forwards installer termination and waits for optional runtime cleanup", async () => {
		const installer = await Bun.file(installScript).text();
		expect(installer).toContain("OFFER_RUNTIME_PID=$!");
		expect(installer).toContain('[ -z "$OFFER_RUNTIME_SIGNAL" ] || return 0');
		expect(installer).toContain('kill -s "$1" "$OFFER_RUNTIME_PID"');
		expect(installer).toContain('wait "$OFFER_RUNTIME_PID"');
		expect(installer).toContain(
			'while [ -n "$OFFER_RUNTIME_SIGNAL" ] && kill -0 "$OFFER_RUNTIME_PID" 2>/dev/null; do',
		);
		expect(installer).not.toContain('kill -KILL "$OFFER_RUNTIME_PID"');
	});

	test("reaps the optional runtime before deleting its snapshot after repeated signals", async () => {
		const markerPath = path.join(sandbox.root, "offer-marker");
		const signalPath = path.join(sandbox.root, "offer-signal");
		const unamePath = path.join(sandbox.shimDir, "uname");
		fs.writeFileSync(
			unamePath,
			'#!/bin/sh\nif [ "$1" = "-s" ]; then echo Darwin; else echo x86_64; fi\n',
		);
		fs.chmodSync(unamePath, 0o755);
		const payload = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "gjc/${VERSION}"; exit 0; fi
if [ "$1" = "--smoke-test" ]; then exit 0; fi
if [ "$1" = "macos-community-app-offer" ]; then
  printf '%s|%s\n' "$$" "$0" > "$GJC_TEST_OFFER_MARKER"
  trap 'printf "TERM\\n" >> "$GJC_TEST_OFFER_SIGNAL"; sleep 1; exit 0' TERM
  while :; do sleep 1; done
fi
exit 0
`;
		const binaryName = "gjc-darwin-x64";
		writeCurlShim(sandbox.shimDir, {
			assets: {
				[binaryName]: payload,
				"gajae-release-binaries.sha256": `${sha256(payload)}  ${binaryName}\n`,
			},
		});
		const installer = Bun.spawn(["sh", installScript], {
			env: {
				...process.env,
				PATH: `${sandbox.shimDir}:/usr/bin:/bin`,
				GJC_INSTALL_DIR: sandbox.installDir,
				HOME: sandbox.root,
				GITHUB_TOKEN: "",
				GH_TOKEN: "",
				GJC_TEST_OFFER_MARKER: markerPath,
				GJC_TEST_OFFER_SIGNAL: signalPath,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		let marker: string | undefined;
		for (let attempt = 0; attempt < 100; attempt++) {
			marker = fs.existsSync(markerPath) ? fs.readFileSync(markerPath, "utf8").trim() : undefined;
			if (marker) break;
			await Bun.sleep(50);
		}
		if (!marker) throw new Error(`optional runtime did not start: ${await new Response(installer.stderr).text()}`);
		const [pidText, runtimePath] = marker.split("|");
		const runtimePid = Number(pidText);
		expect(fs.existsSync(runtimePath)).toBe(true);
		process.kill(installer.pid, "SIGTERM");
		await Bun.sleep(50);
		process.kill(installer.pid, "SIGINT");
		await Bun.sleep(100);
		expect(fs.existsSync(runtimePath)).toBe(true);
		expect(await installer.exited).toBe(143);
		expect(() => process.kill(runtimePid, 0)).toThrow();
		expect(fs.existsSync(runtimePath)).toBe(false);
		expect(fs.readFileSync(signalPath, "utf8").trim()).toBe("TERM");
	}, 15_000);

	test("follows redirects and fail-closes checksum fetch except HTTP 404", async () => {
		const installer = await Bun.file(installScript).text();
		expect(installer).toContain("curl -sSL");
		expect(installer).toContain('if [ "$http_code" != "404" ]');
		expect(installer).toContain("tag ~ /-nightly\\.[0-9]+\\.[0-9]+\\.g[0-9a-f]+$/");
		expect(installer).toContain("trusted_github_url");
		expect(installer).toContain("require_official_github_origins");
		expect(installer).toContain("try_publish_lock_file");
		expect(installer).toContain("set -C");
		expect(installer).toContain("exclusive_tmp");
		expect(installer).toContain("could not identify glibc");
		expect(installer).toContain("leftover lock file");
		expect(installer).toContain('cp -p "$DEST_PATH" "$BACKUP_PATH"');
		expect(installer).not.toContain("No checksum asset on");
		expect(installer).toContain("has no checksum assets");
		expect(installer).toContain("mktemp");
		expect(installer).not.toContain('Authorization: Bearer ${token}');
		expect(installer).toContain('-H "@${AUTH_HDR}"');
		expect(installer).toContain("prepare_github_auth_header");
		expect(installer).toContain("Refusing to replace symlink");
		expect(installer).not.toContain('rm -rf "$lock"');
		expect(installer).toContain("is_stable_release_tag");
		expect(installer).toContain("Failed to publish the downloaded binary");
		expect(installer).toContain("exit 130");
		expect(installer).toContain("Unsupported libc: musl");
		expect(installer).toContain("SOURCE_CLONE_DIR");
	});

	test("rejects unofficial GitHub origin overrides", async () => {
		writeCurlShim(sandbox.shimDir, { assets: {} });
		const result = await runInstaller([], {
			GJC_GITHUB_API: "https://evil.example/api",
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr + result.stdout).toContain("GJC_GITHUB_API must be https://api.github.com");
	});

	test("selects a compact JSON nightly list without a pretty-printed layout", async () => {
		const nightly = "0.9.1-nightly.1.1.gabc";
		const payload = fakeGjcScript({ version: nightly });
		writeCurlShim(sandbox.shimDir, {
			releasesJson: JSON.stringify([
				{ tag_name: "v0.9.0-rc.1", draft: false, prerelease: true },
				{ tag_name: `v${nightly}`, draft: false, prerelease: true },
			]),
			assets: {
				[hostBinaryName()]: payload,
				"gajae-release-binaries.sha256": `${sha256(payload)}  ${hostBinaryName()}\n`,
			},
		});
		const result = await runInstaller(["--channel", "nightly"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(`Using version: v${nightly}`);
	});
	test("selects a nightly tag when prerelease appears before tag_name", async () => {
		const nightly = "0.9.2-nightly.1.1.gdef";
		const payload = fakeGjcScript({ version: nightly });
		writeCurlShim(sandbox.shimDir, {
			releasesJson: `[{"prerelease":true,"draft":false,"tag_name":"v${nightly}"}]`,
			assets: {
				[hostBinaryName()]: payload,
				"gajae-release-binaries.sha256": `${sha256(payload)}  ${hostBinaryName()}\n`,
			},
		});
		const result = await runInstaller(["--channel", "nightly"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(`Using version: v${nightly}`);
	});

	test("rejects a non-semver stable tag such as vpreview", async () => {
		writeCurlShim(sandbox.shimDir, {
			latestJson: JSON.stringify({ tag_name: "vpreview", draft: false, prerelease: false }),
			assets: {},
		});
		const result = await runInstaller([]);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr + result.stdout).toContain("Refusing non-stable release tag");
	});

	test("rejects --ref vpreview before downloading", async () => {
		writeCurlShim(sandbox.shimDir, { assets: {} });
		const result = await runInstaller(["--ref", "vpreview"]);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr + result.stdout).toContain("Invalid --ref");
	});

	test("does not delete a live foreign installer lock", async () => {
		writeCurlShim(sandbox.shimDir, { assets: {} });
		const lockFile = path.join(sandbox.installDir, ".gjc-install.lock");
		const sleeper = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
		const claim = `${sleeper.pid} foreign-nonce\n`;
		fs.writeFileSync(lockFile, claim);
		try {
			const result = await runInstaller([]);
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr + result.stdout).toContain("Another GJC installer is already running");
			expect(fs.readFileSync(lockFile, "utf8")).toBe(claim);
		} finally {
			sleeper.kill();
			await sleeper.exited;
		}
	});

	test("fails closed when an installer lock already exists", async () => {
		writeCurlShim(sandbox.shimDir, { assets: {} });
		const lockFile = path.join(sandbox.installDir, ".gjc-install.lock");
		fs.writeFileSync(lockFile, "999999 stale-nonce\n");
		const result = await runInstaller([]);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr + result.stdout).toContain("Another GJC installer is already running");
		expect(fs.readFileSync(lockFile, "utf8")).toBe("999999 stale-nonce\n");
	});

	test("refuses to replace a destination symlink", async () => {
		const payload = fakeGjcScript({ version: VERSION });
		writeCurlShim(sandbox.shimDir, {
			assets: {
				[hostBinaryName()]: payload,
				"gajae-release-binaries.sha256": `${sha256(payload)}  ${hostBinaryName()}\n`,
			},
		});
		const dest = path.join(sandbox.installDir, "gjc");
		const real = path.join(sandbox.installDir, "real-gjc");
		fs.writeFileSync(real, "managed\n");
		fs.symlinkSync(real, dest);
		const result = await runInstaller([]);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr + result.stdout).toContain("Refusing to replace symlink");
		expect(fs.readFileSync(real, "utf8")).toBe("managed\n");
		expect(fs.lstatSync(dest).isSymbolicLink()).toBe(true);
	});
});
