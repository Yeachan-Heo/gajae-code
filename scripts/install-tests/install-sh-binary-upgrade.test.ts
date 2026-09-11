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

function writeLockRaceShims(dir: string): void {
	const binDir = process.platform === "darwin" ? "/bin" : "/usr/bin";
	const psShim = `#!/bin/sh
barrier="$GJC_LOCK_RACE_DIR"
if [ "\${1:-}" = "-p" ] && [ -n "$barrier" ]; then
  if mkdir "$barrier/ps-first" 2>/dev/null; then
    while [ ! -f "$barrier/ps-release" ]; do sleep 0.01; done
  else
    : > "$barrier/ps-release"
  fi
fi
exit 1
`;
	const catShim = `#!/bin/sh
barrier="$GJC_LOCK_RACE_DIR"
lock="$GJC_INSTALL_DIR/.gjc-install.lock"
if [ "\${1:-}" = "$lock" ] && [ -n "$barrier" ]; then
  if mkdir "$barrier/cat-first" 2>/dev/null; then
    while [ ! -f "$barrier/cat-release" ]; do sleep 0.01; done
  else
    : > "$barrier/cat-release"
  fi
fi
exec "${binDir}/cat" "$@"
`;
	const mvShim = `#!/bin/sh
barrier="$GJC_LOCK_RACE_DIR"
lock="$GJC_INSTALL_DIR/.gjc-install.lock"
source="$1"
destination="$2"
if [ "$source" = "$lock" ]; then
  case "$destination" in
    "$source.stale."*)
      if [ -n "$barrier" ] && mkdir "$barrier/mv-first" 2>/dev/null; then
        "${binDir}/mv" "$@"
        exit $?
      fi
      if [ -n "$barrier" ]; then
        while [ ! -f "$source" ]; do sleep 0.01; done
      fi
      ;;
  esac
fi
exec "${binDir}/mv" "$@"
`;
	for (const [name, content] of [
		["ps", psShim],
		["cat", catShim],
		["mv", mvShim],
	] as const) {
		const shimPath = path.join(dir, name);
		fs.writeFileSync(shimPath, content);
		fs.chmodSync(shimPath, 0o755);
	}
}

interface InstallerOptions {
	cwd?: string;
	script?: string;
	shell?: string;
}

async function runInstaller(
	args: string[],
	env: Record<string, string> = {},
	options: InstallerOptions = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn([options.shell ?? "sh", options.script ?? installScript, ...args], {
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

for (const [signal, exitCode] of [["INT", 130], ["TERM", 143], ["HUP", 129], ["none", 0]] as const) {
	test(`settles late offer cancellation at the final signal check: ${signal}`, async () => {
		const marker = path.join(sandbox.root, "signal-boundary");
		const bashEnv = path.join(sandbox.root, "boundary.bash");
		// DEBUG observes the actual script without rewriting it or adding a production hook.
		await Bun.write(bashEnv, `set -T
boundary_injected=""
boundary_debug() {
  case "$BASH_COMMAND" in
    *OFFER_SIGNAL_EXIT*"-ne 0"*)
      if [ -z "$boundary_injected" ]; then
        boundary_injected=1
        printf 'boundary\\n' >> "$GJC_TEST_BOUNDARY"
        trap - DEBUG
        if [ "$GJC_TEST_BOUNDARY_SIGNAL" != none ]; then
          kill -s "$GJC_TEST_BOUNDARY_SIGNAL" "$$"
        fi
      fi
      ;;
  esac
}
trap boundary_debug DEBUG
`);
		const payload = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "gjc/${VERSION}"; exit 0; fi
if [ "$1" = "--smoke-test" ] || [ "$1" = "--supports-macos-community-app" ]; then exit 0; fi
if [ "$1" = "--internal-macos-community-app-offer" ]; then
  printf 'offer\\n' >> "$GJC_TEST_OFFER_CALLS"
  exit 0
fi
exit 1
`;
		await Bun.write(path.join(sandbox.shimDir, "uname"),
			'#!/bin/sh\nif [ "$1" = "-s" ]; then echo Darwin; else echo x86_64; fi\n');
		fs.chmodSync(path.join(sandbox.shimDir, "uname"), 0o755);
		writeCurlShim(sandbox.shimDir, { assets: {
			"gjc-darwin-x64": payload,
			"gajae-release-binaries.sha256": `${sha256(payload)}  gjc-darwin-x64\n`,
		} });
		const offerCalls = path.join(sandbox.root, "offer-calls");
		const result = await runInstaller([], {
			BASH_ENV: bashEnv,
			GJC_TEST_BOUNDARY: marker,
			GJC_TEST_BOUNDARY_SIGNAL: signal,
			GJC_TEST_OFFER_CALLS: offerCalls,
			GJC_NO_COMMUNITY_APP: "0",
			GJC_NONINTERACTIVE: "0",
			CI: "0",
			GITHUB_ACTIONS: "0",
		}, { shell: "/bin/bash" });
		expect(await Bun.file(marker).text()).toBe("boundary\n");
		expect(result.exitCode).toBe(exitCode);
		expect(await Bun.file(path.join(sandbox.installDir, "gjc")).text()).toBe(payload);
		expect(await Bun.file(offerCalls).text()).toBe("offer\n");
		expect(fs.readdirSync(sandbox.installDir)).toEqual(["gjc"]);
		expect(result.stdout).toContain(`Installed gjc ${VERSION}`);
		if (signal === "none") expect(result.stdout).toMatch(/Run 'gjc' to get started!|Add .+ to your PATH, then run 'gjc'/);
		else expect(result.stdout).not.toMatch(/Run 'gjc' to get started!|Add .+ to your PATH, then run 'gjc'/);
	}, 30_000);
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

	test("optional app fails closed without Bash job ownership, preserving the core install", async () => {
		const script = path.join(sandbox.root, "non-bash-install.sh");
		// Exercise the refusal deterministically even on macOS where /bin/sh is Bash.
		fs.writeFileSync(script, `unset BASH_VERSION\n${fs.readFileSync(installScript, "utf8")}`);
		const payload = fakeGjcScript({ version: VERSION });
		fs.writeFileSync(path.join(sandbox.shimDir, "uname"),
			'#!/bin/sh\nif [ "$1" = "-s" ]; then echo Darwin; else echo x86_64; fi\n', { mode: 0o755 });
		writeCurlShim(sandbox.shimDir, { assets: {
			"gjc-darwin-x64": payload,
			"gajae-release-binaries.sha256": `${sha256(payload)}  gjc-darwin-x64\n`,
		} });
		const result = await runInstaller([], {
			CI: "false", GITHUB_ACTIONS: "false", GJC_NONINTERACTIVE: "false", GJC_NO_COMMUNITY_APP: "false",
		}, { script });
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("safe child ownership requires Bash");
		expect(fs.readFileSync(path.join(sandbox.installDir, "gjc"), "utf8")).toBe(payload);
		expect(fs.readdirSync(sandbox.installDir)).toEqual(["gjc"]);
	});

	test("a reaped optional job never signals a modeled recycled PID", async () => {
		const source = fs.readFileSync(installScript, "utf8");
		const command = source.slice(source.indexOf("run_offer_command() {"), source.indexOf("prepare_community_app_runtime() {"));
		// Interpose the signal boundary: a positive PID represents a recycled
		// bystander, never a host process. Reap the real job between liveness and
		// delivery, exactly where numerical kill authority used to become stale.
		const harness = `${command}
OFFER_RUNTIME_SIGNAL=""
OFFER_RUNTIME_RETAIN=""
kill() {
    for target do :; done
    case "$target" in
        %%)
            wait "$OFFER_RUNTIME_PID" || :
            builtin kill "$@" 2>/dev/null || :
            printf 'owned-job\\n'
            ;;
        *) printf 'recycled-bystander\\n'; return 1 ;;
    esac
}
sleep() { :; }
run_offer_command 0 /bin/sleep 1 || :
`;
		const child = Bun.spawn(["bash", "-c", harness], { stdout: "pipe", stderr: "pipe" });
		const stdout = new Response(child.stdout).text();
		const stderr = new Response(child.stderr).text();
		expect(await child.exited).toBe(0);
		expect(await stdout).toContain("owned-job");
		expect(await stdout).not.toContain("recycled-bystander");
		expect(await stderr).toBe("");
	});
	for (const phase of ["copy", "hash", "probe", "offer", "uncooperative-offer"] as const) {
		for (const [signal, exitCode] of [["SIGTERM", 143], ["SIGINT", 130], ["SIGHUP", 129]] as const) {
			test(`owns and reaps ${phase} on ${signal}, retaining the successful core install`, async () => {
				const markerPath = path.join(sandbox.root, "offer-marker");
				const signalPath = path.join(sandbox.root, "offer-signal");
				const blocker = path.join(sandbox.root, "blocker.py");
				fs.writeFileSync(blocker, `import os, signal, sys, time
runtime = sys.argv[1]
assert "MallocStackLogging" not in os.environ
assert "MallocStackLoggingNoCompact" not in os.environ
assert "GJC_MALLOC_ENV_REEXEC" not in os.environ
# A fixture-owned deadline cleans up failed assertions without stale PID kills.
signal.signal(signal.SIGALRM, lambda signum, frame: sys.exit(99))
signal.alarm(25)
def stop(signum, frame):
    with open(os.environ["GJC_TEST_OFFER_SIGNAL"], "a") as log:
        log.write(signal.Signals(signum).name + "\\n")
    if os.environ["GJC_TEST_PHASE"] != "uncooperative-offer":
        time.sleep(1.5)
        sys.exit(0)
for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
    signal.signal(sig, stop)
with open(os.environ["GJC_TEST_OFFER_MARKER"], "w") as marker:
    marker.write(str(os.getpid()) + "|" + runtime + "|" + str(os.getppid()))
while True:
    time.sleep(1)
`);
				const payload = `#!/bin/sh
if [ "$1" = "--version" ]; then
  [ "$MallocStackLogging" = 1 ] && [ "$MallocStackLoggingNoCompact" = 1 ] || exit 1
  echo "gjc/${VERSION}"; exit 0
fi
if [ "$1" = "--smoke-test" ]; then exit 0; fi
if [ "$1" = "--supports-macos-community-app" ]; then
  if [ "$GJC_TEST_PHASE" = probe ]; then exec python3 "$GJC_TEST_BLOCKER" "$0"; fi
  exit 0
fi
if [ "$1" = "--internal-macos-community-app-offer" ]; then
  exec python3 "$GJC_TEST_BLOCKER" "$0"
fi
exit 1
`;
				const shims: Record<string, string> = {
					uname: '#!/bin/sh\nif [ "$1" = "-s" ]; then echo Darwin; else echo x86_64; fi\n',
					cp: `#!/bin/sh
case "$3" in
  */.gjc-community-app.*/gjc)
    if [ "$GJC_TEST_PHASE" = copy ]; then
      /bin/cp "$@" || exit 1
      exec python3 "$GJC_TEST_BLOCKER" "$3"
    fi ;;
esac
exec /bin/cp "$@"
`,
					sha256sum: `#!/bin/sh
case "$1" in
  */.gjc-community-app.*/gjc)
    if [ "$GJC_TEST_PHASE" = hash ]; then exec python3 "$GJC_TEST_BLOCKER" "$1"; fi ;;
esac
exec python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest(), sys.argv[1])' "$1"
`,
				};
				for (const [name, content] of Object.entries(shims)) {
					fs.writeFileSync(path.join(sandbox.shimDir, name), content, { mode: 0o755 });
				}
				writeCurlShim(sandbox.shimDir, {
					assets: {
						"gjc-darwin-x64": payload,
						"gajae-release-binaries.sha256": `${sha256(payload)}  gjc-darwin-x64\n`,
					},
				});
				const installer = Bun.spawn(["bash", installScript], {
					env: {
						...process.env,
						PATH: `${sandbox.shimDir}:/usr/bin:/bin`,
						GJC_INSTALL_DIR: sandbox.installDir,
						HOME: sandbox.root,
						GITHUB_TOKEN: "",
						GH_TOKEN: "",
						CI: "false",
						GITHUB_ACTIONS: "false",
						GJC_NONINTERACTIVE: "false",
						GJC_NO_COMMUNITY_APP: "false",
						GJC_TEST_PHASE: phase,
						GJC_TEST_BLOCKER: blocker,
						GJC_TEST_OFFER_MARKER: markerPath,
						GJC_TEST_OFFER_SIGNAL: signalPath,
						MallocStackLogging: "1",
						MallocStackLoggingNoCompact: "1",
						GJC_MALLOC_ENV_REEXEC: undefined,
					},
					stdout: "pipe",
					stderr: "pipe",
				});
				const stdout = new Response(installer.stdout).text();
				const stderr = new Response(installer.stderr).text();
				let runtimePid: number | undefined;
				try {
					let marker = "";
					for (let attempt = 0; attempt < 400; attempt++) {
						marker = fs.existsSync(markerPath) ? fs.readFileSync(markerPath, "utf8").trim() : "";
						if (marker.includes("|")) break;
						if (installer.exitCode !== null) {
							throw new Error(`Installer exited before ${phase} marker (${installer.exitCode}):\n${await stdout}\n${await stderr}`);
						}
						await Bun.sleep(50);
					}
					expect(marker).toContain("|");
					const [pidText, runtimePath, parentPid] = marker.split("|");
					expect(Number(parentPid)).toBe(installer.pid);
					runtimePid = Number(pidText);
					expect(fs.existsSync(runtimePath)).toBe(true);
					installer.kill(signal);
					for (let attempt = 0; attempt < 60 && !fs.existsSync(signalPath); attempt++) {
						await Bun.sleep(50);
					}
					expect(fs.existsSync(signalPath)).toBe(true);
					installer.kill(signal === "SIGTERM" ? "SIGHUP" : "SIGTERM");
					await Bun.sleep(100);
					expect(fs.existsSync(runtimePath)).toBe(true);
					const result = await Promise.race([
						installer.exited,
						Bun.sleep(12_000).then(() => "cancellation deadline exceeded"),
					]);
					expect(result).toBe(exitCode);
					expect(() => process.kill(runtimePid!, 0)).toThrow();
					expect(fs.existsSync(runtimePath)).toBe(phase === "uncooperative-offer");
					expect(fs.readFileSync(signalPath, "utf8").trim()).toBe(signal);
					expect(fs.readFileSync(path.join(sandbox.installDir, "gjc"), "utf8")).toBe(payload);
					if (phase === "uncooperative-offer") {
						expect(fs.readdirSync(sandbox.installDir).sort()).toEqual([path.basename(path.dirname(runtimePath)), "gjc"].sort());
						expect(await stderr).toContain("retained runtime");
					} else {
						expect(fs.readdirSync(sandbox.installDir)).toEqual(["gjc"]);
					}
					expect(await stdout).toContain(`Installed gjc ${VERSION}`);
					await stderr;
				} finally {
					if (installer.exitCode === null) installer.kill("SIGKILL");
					await installer.exited;
					for (const name of fs.readdirSync(sandbox.installDir)) {
						if (name.startsWith(".gjc-community-app.")) fs.chmodSync(path.join(sandbox.installDir, name), 0o700);
					}
				}
			}, 40_000);
		}
	}

	// pty.fork establishes a private controlling terminal on macOS/Linux; redirect
	// only fd 0 after the fork so terminal stdout cannot hide stdin promotion.
	test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
		"preserves nonTTY stdin with terminal stdout and a controlling tty for the verified offer runtime",
		async () => {
			const marker = path.join(sandbox.root, "runtime-fds");
			const applications = path.join(sandbox.root, "Applications");
			fs.mkdirSync(applications);
			fs.writeFileSync(path.join(applications, "existing-app"), "unchanged");
			const payload = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "gjc/${VERSION}"; exit 0; fi
if [ "$1" = "--smoke-test" ]; then exit 0; fi
if [ "$1" = "--supports-macos-community-app" ]; then exit 0; fi
if [ "$1" = "--internal-macos-community-app-offer" ]; then
  stdin=nonTTY; stdout=nonTTY; controlling=absent
  [ ! -t 0 ] || stdin=TTY
  [ ! -t 1 ] || stdout=TTY
  if ( : < /dev/tty ) 2>/dev/null; then controlling=present; fi
  printf '%s|%s|%s\\n' "$stdin" "$stdout" "$controlling" > "$GJC_TEST_FDS"
  if [ -t 0 ]; then
    echo 'FIXTURE OFFER PROMPT'
    mkdir "$HOME/Applications/Gajae Community.app"
  fi
  exit 0
fi
exit 1
`;
			fs.writeFileSync(path.join(sandbox.shimDir, "uname"),
				'#!/bin/sh\nif [ "$1" = "-s" ]; then echo Darwin; else echo x86_64; fi\n', { mode: 0o755 });
			writeCurlShim(sandbox.shimDir, {
				assets: {
					"gjc-darwin-x64": payload,
					"gajae-release-binaries.sha256": `${sha256(payload)}  gjc-darwin-x64\n`,
				},
			});
			// No input is forwarded from the test runner and no host terminal settings
			// are changed. Bound the whole private PTY session, including descendants.
			const driver = `import errno, os, pty, select, signal, sys, time
pid, master = pty.fork()
if pid == 0:
    fd = os.open(os.devnull, os.O_RDONLY)
    os.dup2(fd, 0)
    if fd != 0:
        os.close(fd)
    os.execv("/bin/bash", ["bash", sys.argv[1]])
deadline = time.monotonic() + 15
status = None
try:
    while True:
        if time.monotonic() >= deadline:
            raise TimeoutError("installer PTY session exceeded 15 seconds")
        ready, _, _ = select.select([master], [], [], 0.1)
        if ready:
            try:
                data = os.read(master, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                data = b""
            if not data:
                break
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
    while status is None:
        waited, result = os.waitpid(pid, os.WNOHANG)
        if waited:
            status = result
        elif time.monotonic() >= deadline:
            raise TimeoutError("installer did not exit after PTY close")
        else:
            time.sleep(0.05)
finally:
    if status is None:
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.waitpid(pid, 0)
    os.close(master)
sys.exit(os.waitstatus_to_exitcode(status))
`;
			const proc = Bun.spawn(["python3", "-c", driver, installScript], {
				cwd: repoRoot,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					PATH: `${sandbox.shimDir}:/usr/bin:/bin`,
					GJC_INSTALL_DIR: sandbox.installDir,
					HOME: sandbox.root,
					GITHUB_TOKEN: "",
					GH_TOKEN: "",
					CI: "false",
					GITHUB_ACTIONS: "false",
					GJC_NONINTERACTIVE: "false",
					GJC_NO_COMMUNITY_APP: "false",
					GJC_TEST_FDS: marker,
				},
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			expect(stderr).toBe("");
			expect(exitCode).toBe(0);
			expect(stdout).toContain(`Installed gjc ${VERSION}`);
			expect(fs.readFileSync(marker, "utf8")).toBe("nonTTY|TTY|present\n");
			expect(stdout).not.toContain("FIXTURE OFFER PROMPT");
			expect(fs.readFileSync(path.join(sandbox.installDir, "gjc"), "utf8")).toBe(payload);
			expect(fs.readdirSync(sandbox.installDir)).toEqual(["gjc"]);
			expect(fs.readdirSync(applications)).toEqual(["existing-app"]);
			expect(fs.readFileSync(path.join(applications, "existing-app"), "utf8")).toBe("unchanged");
		}, 20_000,
	);

	test("releases the core lock during a long-lived optional offer and preserves a successor lock on exit", async () => {
		const offerReady = path.join(sandbox.root, "offer-ready");
		const offerRelease = path.join(sandbox.root, "offer-release");
		const successorReady = path.join(sandbox.root, "successor-ready");
		const successorRelease = path.join(sandbox.root, "successor-release");
		const lockFile = path.join(sandbox.installDir, ".gjc-install.lock");
		const payload = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "gjc/${VERSION}"; exit 0; fi
if [ "$1" = "--smoke-test" ] || [ "$1" = "--supports-macos-community-app" ]; then exit 0; fi
if [ "$1" = "--internal-macos-community-app-offer" ]; then
  [ ! -e "$GJC_INSTALL_DIR/.gjc-install.lock" ] || exit 1
  printf 'absent\\n' > "$GJC_TEST_OFFER_READY"
  attempts=0
  while [ ! -f "$GJC_TEST_OFFER_RELEASE" ]; do
    attempts=$((attempts + 1))
    [ "$attempts" -lt 1000 ] || exit 1
    sleep 0.01
  done
  exit 0
fi
exit 1
`;
		fs.writeFileSync(path.join(sandbox.shimDir, "uname"),
			'#!/bin/sh\nif [ "$1" = "-s" ]; then echo Darwin; else echo x86_64; fi\n', { mode: 0o755 });
		writeCurlShim(sandbox.shimDir, {
			assets: {
				"gjc-darwin-x64": payload,
				"gajae-release-binaries.sha256": `${sha256(payload)}  gjc-darwin-x64\n`,
			},
		});
		// Use the installer's real lock acquisition and EXIT cleanup, but hold the
		// successor before publishing anything. All processes are sandbox fixtures.
		const source = fs.readFileSync(installScript, "utf8");
		const successorScript = path.join(sandbox.root, "successor.sh");
		fs.writeFileSync(successorScript, `${source.slice(0, source.indexOf('while [ $# -gt 0 ]; do'))}
acquire_lock
printf 'acquired\\n' > "$GJC_TEST_SUCCESSOR_READY"
attempts=0
while [ ! -f "$GJC_TEST_SUCCESSOR_RELEASE" ]; do
    attempts=$((attempts + 1))
    [ "$attempts" -lt 1000 ] || exit 1
    sleep 0.01
done
`);
		const waitForMarker = async (marker: string): Promise<void> => {
			const deadline = Date.now() + 15_000;
			while (!fs.existsSync(marker) && Date.now() < deadline) await Bun.sleep(10);
			expect(fs.existsSync(marker)).toBe(true);
		};
		const first = runInstaller([], {
			CI: "false",
			GITHUB_ACTIONS: "false",
			GJC_NONINTERACTIVE: "false",
			GJC_NO_COMMUNITY_APP: "false",
			GJC_TEST_OFFER_READY: offerReady,
			GJC_TEST_OFFER_RELEASE: offerRelease,
		}, { shell: "bash" });
		let successor: Promise<{ exitCode: number; stdout: string; stderr: string }> | undefined;
		try {
			await waitForMarker(offerReady);
			expect(fs.readFileSync(offerReady, "utf8")).toBe("absent\n");
			expect(fs.existsSync(lockFile)).toBe(false);
			successor = runInstaller([], {
				GJC_TEST_SUCCESSOR_READY: successorReady,
				GJC_TEST_SUCCESSOR_RELEASE: successorRelease,
			}, { shell: "bash", script: successorScript });
			await waitForMarker(successorReady);
			const successorClaim = fs.readFileSync(lockFile, "utf8");
			expect(successorClaim).toMatch(/^\d+ [^\s]+\n$/);
			fs.writeFileSync(offerRelease, "release");
			const result = await first;
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain(`Installed gjc ${VERSION}`);
			expect(fs.readFileSync(lockFile, "utf8")).toBe(successorClaim);
			expect(fs.readFileSync(path.join(sandbox.installDir, "gjc"), "utf8")).toBe(payload);
			fs.writeFileSync(successorRelease, "release");
			expect((await successor).exitCode).toBe(0);
			expect(fs.existsSync(lockFile)).toBe(false);
		} finally {
			fs.writeFileSync(offerRelease, "release");
			fs.writeFileSync(successorRelease, "release");
			await first;
			await successor;
		}
	}, 40_000);

	for (const scenario of ["supported", "unsupported", "replacement", "suppressed"] as const) {
		test(`optional runtime ${scenario} preserves core success and executes only a verified snapshot`, async () => {
			const marker = path.join(sandbox.root, "runtime-calls");
			const payload = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "gjc/${VERSION}"; exit 0; fi
if [ "$1" = "--smoke-test" ]; then exit 0; fi
printf '%s\\n' "$1" >> "$GJC_TEST_CALLS"
if [ "$1" = "--supports-macos-community-app" ]; then
  [ "$GJC_TEST_SCENARIO" != unsupported ]; exit $?
fi
if [ "$1" = "--internal-macos-community-app-offer" ]; then exit 0; fi
exit 1
`;
			fs.writeFileSync(path.join(sandbox.shimDir, "uname"),
				'#!/bin/sh\nif [ "$1" = "-s" ]; then echo Darwin; else echo x86_64; fi\n', { mode: 0o755 });
			// Replace only the test snapshot copy, after core verification. Neither
			// the attacker's capability hook nor its offer hook may be executed.
			const replacement = path.join(sandbox.root, "unverified");
			fs.writeFileSync(replacement, '#!/bin/sh\necho unverified >> "$GJC_TEST_CALLS"\nexit 0\n');
			fs.writeFileSync(path.join(sandbox.shimDir, "cp"), `#!/bin/sh
case "$3" in
  */.gjc-community-app.*/gjc)
    if [ "$GJC_TEST_SCENARIO" = replacement ]; then exec /bin/cp "$GJC_TEST_REPLACEMENT" "$3"; fi ;;
esac
exec /bin/cp "$@"
`, { mode: 0o755 });
			writeCurlShim(sandbox.shimDir, {
				assets: {
					"gjc-darwin-x64": payload,
					"gajae-release-binaries.sha256": `${sha256(payload)}  gjc-darwin-x64\n`,
				},
			});
			const result = await runInstaller([], {
				CI: "false",
				GITHUB_ACTIONS: "false",
				GJC_NONINTERACTIVE: "false",
				GJC_NO_COMMUNITY_APP: scenario === "suppressed" ? "true" : "false",
				GJC_TEST_SCENARIO: scenario,
				GJC_TEST_CALLS: marker,
				GJC_TEST_REPLACEMENT: replacement,
			}, { shell: "bash" });
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain(`Installed gjc ${VERSION}`);
			expect(fs.readFileSync(path.join(sandbox.installDir, "gjc"), "utf8")).toBe(payload);
			expect(fs.readdirSync(sandbox.installDir)).toEqual(["gjc"]);
			const calls = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim().split("\n") : [];
			expect(calls).toEqual(scenario === "supported"
				? ["--supports-macos-community-app", "--internal-macos-community-app-offer"]
				: scenario === "unsupported" ? ["--supports-macos-community-app"] : []);
		}, 20_000);
	}

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

	test("reclaims a lock whose recorded owner is no longer running", async () => {
		const payload = fakeGjcScript({ version: VERSION });
		writeCurlShim(sandbox.shimDir, {
			assets: {
				[hostBinaryName()]: payload,
				"gajae-release-binaries.sha256": `${sha256(payload)}  ${hostBinaryName()}\n`,
			},
		});
		const lockFile = path.join(sandbox.installDir, ".gjc-install.lock");
		fs.writeFileSync(lockFile, "999999 stale-nonce\n");
		const result = await runInstaller([]);
		expect(result.exitCode).toBe(0);
		expect(fs.readFileSync(path.join(sandbox.installDir, "gjc"), "utf8")).toBe(payload);
		expect(fs.existsSync(lockFile)).toBe(false);
	});

	test("allows only one concurrent installer to reclaim the same stale lock", async () => {
		const payload = fakeGjcScript({ version: VERSION });
		writeCurlShim(sandbox.shimDir, {
			assets: {
				[hostBinaryName()]: payload,
				"gajae-release-binaries.sha256": `${sha256(payload)}  ${hostBinaryName()}\n`,
			},
		});
		const lockFile = path.join(sandbox.installDir, ".gjc-install.lock");
		const raceDir = path.join(sandbox.root, "lock-race");
		fs.mkdirSync(raceDir);
		fs.writeFileSync(lockFile, "999999 stale-nonce\n");
		writeLockRaceShims(sandbox.shimDir);

		const env = { GJC_LOCK_RACE_DIR: raceDir };
		const results = await Promise.all([runInstaller([], env), runInstaller([], env)]);
		const successful = results.filter(result => result.exitCode === 0);
		expect(successful).toHaveLength(1);
		expect(results.some(result => (result.stderr + result.stdout).includes("Another GJC installer is already running"))).toBe(true);
		expect(fs.readFileSync(path.join(sandbox.installDir, "gjc"), "utf8")).toBe(payload);
		expect(fs.existsSync(lockFile)).toBe(false);
		expect(fs.existsSync(`${lockFile}.reclaim`)).toBe(false);
	});

	test("fails closed when an installer lock owner cannot be proven stale", async () => {
		writeCurlShim(sandbox.shimDir, { assets: {} });
		const lockFile = path.join(sandbox.installDir, ".gjc-install.lock");
		const claim = "not-a-pid malformed-lock\n";
		fs.writeFileSync(lockFile, claim);
		const result = await runInstaller([]);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr + result.stdout).toContain("Another GJC installer is already running");
		expect(fs.readFileSync(lockFile, "utf8")).toBe(claim);
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
