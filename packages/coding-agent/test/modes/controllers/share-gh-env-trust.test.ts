import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Default `/share` spawns `gh auth status` and `gh gist create` with an
 * explicit environment copy. The project dotenv is already in that environment.
 * These probes use the public `handleShareCommand` entry.
 */

const PROBE = path.join(import.meta.dir, "../../fixtures/share-gh-env-probe.ts");
const CLR_PROFILER_ENV_KEYS = [
	"CORECLR_ENABLE_PROFILING",
	"DOTNET_ENABLE_PROFILING",
	"CORECLR_PROFILER",
	"DOTNET_PROFILER",
	"CORECLR_PROFILER_PATH",
	"CORECLR_PROFILER_PATH_32",
	"CORECLR_PROFILER_PATH_64",
	"CORECLR_PROFILER_PATH_ARM32",
	"CORECLR_PROFILER_PATH_ARM64",
	"DOTNET_PROFILER_PATH",
	"DOTNET_PROFILER_PATH_32",
	"DOTNET_PROFILER_PATH_64",
	"DOTNET_PROFILER_PATH_ARM32",
	"DOTNET_PROFILER_PATH_ARM64",
] as const;
type ClrProfilerEnvironmentKey = (typeof CLR_PROFILER_ENV_KEYS)[number];
const DOTNET_ROOT_ENV_KEYS = [
	"DOTNET_ROOT",
	"DOTNET_ROOT_X86",
	"DOTNET_ROOT_X64",
	"DOTNET_ROOT_ARM",
	"DOTNET_ROOT_ARM64",
] as const;
type DotnetRootEnvironmentKey = (typeof DOTNET_ROOT_ENV_KEYS)[number];
const LUA_INIT_VERSIONED_ENV_KEYS = [
	"LUA_INIT_5_1",
	"LUA_INIT_5_2",
	"LUA_INIT_5_3",
	"LUA_INIT_5_4",
	"LUA_INIT_5_5",
] as const;
type LuaInitVersionedEnvironmentKey = (typeof LUA_INIT_VERSIONED_ENV_KEYS)[number];
const LUA_MODULE_PATH_ENV_KEYS = [
	"LUA_PATH",
	"LUA_CPATH",
	"LUA_PATH_5_1",
	"LUA_PATH_5_2",
	"LUA_PATH_5_3",
	"LUA_PATH_5_4",
	"LUA_PATH_5_5",
	"LUA_CPATH_5_1",
	"LUA_CPATH_5_2",
	"LUA_CPATH_5_3",
	"LUA_CPATH_5_4",
	"LUA_CPATH_5_5",
] as const;
type LuaModulePathEnvironmentKey = (typeof LUA_MODULE_PATH_ENV_KEYS)[number];
const TRUST_KEYS = [
	"GH_HOST",
	"GH_CONFIG_DIR",
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"GH_ENTERPRISE_TOKEN",
	"GITHUB_ENTERPRISE_TOKEN",
	"XDG_CONFIG_HOME",
	"HOME",
	"USERPROFILE",
	"APPDATA",
	"BASH_ENV",
	"BUN_OPTIONS",
	"ENV",
	"ZDOTDIR",
	"NODE_OPTIONS",
	"NODE_PATH",
	"PYTHONHOME",
	"PYTHONPATH",
	"PYTHONUSERBASE",
	"PYTHONSTARTUP",
	"JULIA_DEPOT_PATH",
	"JULIA_LOAD_PATH",
	"JULIA_PROJECT",
	"TCL_LIBRARY",
	"TCLLIBPATH",
	"LUA_INIT",
	...LUA_INIT_VERSIONED_ENV_KEYS,
	...LUA_MODULE_PATH_ENV_KEYS,
	"R_ENVIRON",
	"R_ENVIRON_USER",
	"R_PROFILE",
	"R_PROFILE_USER",
	"ELIXIR_ERL_OPTIONS",
	"ERL_AFLAGS",
	"ERL_FLAGS",
	"ERL_ZFLAGS",
	"BUNDLER_SETUP",
	"BUNDLE_GEMFILE",
	"GEM_HOME",
	"GEM_PATH",
	"RUBYGEMS_GEMDEPS",
	"RUBYOPT",
	"RUBYLIB",
	"PERL5OPT",
	"PERL5LIB",
	"PERLLIB",
	"JAVA_HOME",
	"JAVA_TOOL_OPTIONS",
	"JDK_JAVA_OPTIONS",
	"_JAVA_OPTIONS",
	"CLASSPATH",
	"PHPRC",
	"PHP_INI_SCAN_DIR",
	"DOTNET_STARTUP_HOOKS",
	...DOTNET_ROOT_ENV_KEYS,
	...CLR_PROFILER_ENV_KEYS,
	"PATH",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"all_proxy",
	"no_proxy",
	"OPENSSL_CONF",
	"OPENSSL_CONF_INCLUDE",
	"OPENSSL_MODULES",
	"OPENSSL_ENGINES",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"LD_PRELOAD",
	"LD_LIBRARY_PATH",
	"LD_AUDIT",
	"DYLD_INSERT_LIBRARIES",
	"DYLD_LIBRARY_PATH",
	"DYLD_FRAMEWORK_PATH",
	"DYLD_FALLBACK_LIBRARY_PATH",
	"DYLD_FALLBACK_FRAMEWORK_PATH",
	"DYLD_ROOT_PATH",
	"GH_HOST_PLANTED",
	"GH_CONFIG_PLANTED",
] as const;

interface GhSpawn {
	args: string[];
	source: string;
	cwd: string;
	projectRoot: string;
	bunfigPreloadExecuted: boolean;
	PATH: string;
	BASH_ENV: string | null;
	BUN_OPTIONS: string | null;
	ENV: string | null;
	ZDOTDIR: string | null;
	NODE_OPTIONS: string | null;
	NODE_PATH: string | null;
	PYTHONHOME: string | null;
	PYTHONPATH: string | null;
	PYTHONUSERBASE: string | null;
	PYTHONSTARTUP: string | null;
	JULIA_DEPOT_PATH: string | null;
	JULIA_LOAD_PATH: string | null;
	JULIA_PROJECT: string | null;
	TCL_LIBRARY: string | null;
	TCLLIBPATH: string | null;
	LUA_INIT: string | null;
	luaInitVersionedEnvironment: Record<LuaInitVersionedEnvironmentKey, string | null>;
	luaModulePathEnvironment: Record<LuaModulePathEnvironmentKey, string | null>;
	R_ENVIRON: string | null;
	R_ENVIRON_USER: string | null;
	R_PROFILE: string | null;
	R_PROFILE_USER: string | null;
	ELIXIR_ERL_OPTIONS: string | null;
	ERL_AFLAGS: string | null;
	ERL_FLAGS: string | null;
	ERL_ZFLAGS: string | null;
	BUNDLER_SETUP: string | null;
	BUNDLE_GEMFILE: string | null;
	GEM_HOME: string | null;
	GEM_PATH: string | null;
	RUBYGEMS_GEMDEPS: string | null;
	RUBYOPT: string | null;
	RUBYLIB: string | null;
	PERL5OPT: string | null;
	PERL5LIB: string | null;
	PERLLIB: string | null;
	JAVA_HOME: string | null;
	JAVA_TOOL_OPTIONS: string | null;
	JDK_JAVA_OPTIONS: string | null;
	_JAVA_OPTIONS: string | null;
	CLASSPATH: string | null;
	PHPRC: string | null;
	PHP_INI_SCAN_DIR: string | null;
	DOTNET_STARTUP_HOOKS: string | null;
	OPENSSL_CONF: string | null;
	OPENSSL_CONF_INCLUDE: string | null;
	OPENSSL_MODULES: string | null;
	OPENSSL_ENGINES: string | null;
	dotnetRootEnvironment: Record<DotnetRootEnvironmentKey, string | null>;
	profilerEnvironment: Record<ClrProfilerEnvironmentKey, string | null>;
	GH_HOST: string | null;
	GH_CONFIG_DIR: string | null;
	GH_TOKEN: string | null;
	GITHUB_TOKEN: string | null;
	GH_ENTERPRISE_TOKEN: string | null;
	GITHUB_ENTERPRISE_TOKEN: string | null;
	XDG_CONFIG_HOME: string | null;
	HOME: string | null;
	USERPROFILE: string | null;
	APPDATA: string | null;
	HTTP_PROXY: string | null;
	HTTPS_PROXY: string | null;
	ALL_PROXY: string | null;
	NO_PROXY: string | null;
	http_proxy: string | null;
	https_proxy: string | null;
	all_proxy: string | null;
	no_proxy: string | null;
	SSL_CERT_FILE: string | null;
	SSL_CERT_DIR: string | null;
	LD_PRELOAD: string | null;
	LD_LIBRARY_PATH: string | null;
	LD_AUDIT: string | null;
	DYLD_INSERT_LIBRARIES: string | null;
	DYLD_LIBRARY_PATH: string | null;
	DYLD_FRAMEWORK_PATH: string | null;
	DYLD_FALLBACK_LIBRARY_PATH: string | null;
	DYLD_FALLBACK_FRAMEWORK_PATH: string | null;
	DYLD_ROOT_PATH: string | null;
}

const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function writeGh(binDir: string, source: string): Promise<void> {
	await fs.mkdir(binDir, { recursive: true });
	const gh = path.join(binDir, "gh");
	await Bun.write(
		gh,
		`#!/usr/bin/env -S ${process.execPath} --no-env-file
import * as fsPromises from "node:fs/promises";
const record = process.env.GJC_SHARE_GH_RECORD;
if (!record) {
	process.stderr.write("missing share record\\n");
	process.exit(2);
}
const bunfigPreloadMarker = process.env.GJC_SHARE_BUNFIG_MARKER;
await fsPromises.appendFile(
	record,
	JSON.stringify({
		args: process.argv.slice(2),
		source: ${JSON.stringify(source)},
		cwd: process.cwd(),
		projectRoot: process.env.GJC_SHARE_PROJECT_ROOT ?? "",
		bunfigPreloadExecuted: bunfigPreloadMarker
			? await fsPromises.stat(bunfigPreloadMarker).then(() => true, () => false)
			: false,
		PATH: process.env.PATH ?? "",
		BASH_ENV: process.env.BASH_ENV ?? null,
		BUN_OPTIONS: process.env.BUN_OPTIONS ?? null,
		ENV: process.env.ENV ?? null,
		ZDOTDIR: process.env.ZDOTDIR ?? null,
		NODE_OPTIONS: process.env.NODE_OPTIONS ?? null,
		NODE_PATH: process.env.NODE_PATH ?? null,
		PYTHONHOME: process.env.PYTHONHOME ?? null,
		PYTHONPATH: process.env.PYTHONPATH ?? null,
		PYTHONUSERBASE: process.env.PYTHONUSERBASE ?? null,
		PYTHONSTARTUP: process.env.PYTHONSTARTUP ?? null,
		JULIA_DEPOT_PATH: process.env.JULIA_DEPOT_PATH ?? null,
		JULIA_LOAD_PATH: process.env.JULIA_LOAD_PATH ?? null,
		JULIA_PROJECT: process.env.JULIA_PROJECT ?? null,
		TCL_LIBRARY: process.env.TCL_LIBRARY ?? null,
		TCLLIBPATH: process.env.TCLLIBPATH ?? null,
		LUA_INIT: process.env.LUA_INIT ?? null,
		luaInitVersionedEnvironment: Object.fromEntries(
			${JSON.stringify(LUA_INIT_VERSIONED_ENV_KEYS)}.map(name => [name, process.env[name] ?? null]),
		),
		luaModulePathEnvironment: Object.fromEntries(
			${JSON.stringify(LUA_MODULE_PATH_ENV_KEYS)}.map(name => [name, process.env[name] ?? null]),
		),
		R_ENVIRON: process.env.R_ENVIRON ?? null,
		R_ENVIRON_USER: process.env.R_ENVIRON_USER ?? null,
		R_PROFILE: process.env.R_PROFILE ?? null,
		R_PROFILE_USER: process.env.R_PROFILE_USER ?? null,
		ELIXIR_ERL_OPTIONS: process.env.ELIXIR_ERL_OPTIONS ?? null,
		ERL_AFLAGS: process.env.ERL_AFLAGS ?? null,
		ERL_FLAGS: process.env.ERL_FLAGS ?? null,
		ERL_ZFLAGS: process.env.ERL_ZFLAGS ?? null,
		BUNDLER_SETUP: process.env.BUNDLER_SETUP ?? null,
		BUNDLE_GEMFILE: process.env.BUNDLE_GEMFILE ?? null,
		GEM_HOME: process.env.GEM_HOME ?? null,
		GEM_PATH: process.env.GEM_PATH ?? null,
		RUBYGEMS_GEMDEPS: process.env.RUBYGEMS_GEMDEPS ?? null,
		RUBYOPT: process.env.RUBYOPT ?? null,
		RUBYLIB: process.env.RUBYLIB ?? null,
		PERL5OPT: process.env.PERL5OPT ?? null,
		PERL5LIB: process.env.PERL5LIB ?? null,
		PERLLIB: process.env.PERLLIB ?? null,
		JAVA_HOME: process.env.JAVA_HOME ?? null,
		JAVA_TOOL_OPTIONS: process.env.JAVA_TOOL_OPTIONS ?? null,
		JDK_JAVA_OPTIONS: process.env.JDK_JAVA_OPTIONS ?? null,
		_JAVA_OPTIONS: process.env._JAVA_OPTIONS ?? null,
		CLASSPATH: process.env.CLASSPATH ?? null,
		PHPRC: process.env.PHPRC ?? null,
		PHP_INI_SCAN_DIR: process.env.PHP_INI_SCAN_DIR ?? null,
		DOTNET_STARTUP_HOOKS: process.env.DOTNET_STARTUP_HOOKS ?? null,
		OPENSSL_CONF: process.env.OPENSSL_CONF ?? null,
		OPENSSL_CONF_INCLUDE: process.env.OPENSSL_CONF_INCLUDE ?? null,
		OPENSSL_MODULES: process.env.OPENSSL_MODULES ?? null,
		OPENSSL_ENGINES: process.env.OPENSSL_ENGINES ?? null,
		dotnetRootEnvironment: Object.fromEntries(
			${JSON.stringify(DOTNET_ROOT_ENV_KEYS)}.map(name => [name, process.env[name] ?? null]),
		),
		profilerEnvironment: Object.fromEntries(
			${JSON.stringify(CLR_PROFILER_ENV_KEYS)}.map(name => [name, process.env[name] ?? null]),
		),
		GH_HOST: process.env.GH_HOST ?? null,
		GH_CONFIG_DIR: process.env.GH_CONFIG_DIR ?? null,
		GH_TOKEN: process.env.GH_TOKEN ?? null,
		GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? null,
		GH_ENTERPRISE_TOKEN: process.env.GH_ENTERPRISE_TOKEN ?? null,
		GITHUB_ENTERPRISE_TOKEN: process.env.GITHUB_ENTERPRISE_TOKEN ?? null,
		XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? null,
		HOME: process.env.HOME ?? null,
		USERPROFILE: process.env.USERPROFILE ?? null,
		APPDATA: process.env.APPDATA ?? null,
		HTTP_PROXY: process.env.HTTP_PROXY ?? null,
		HTTPS_PROXY: process.env.HTTPS_PROXY ?? null,
		ALL_PROXY: process.env.ALL_PROXY ?? null,
		NO_PROXY: process.env.NO_PROXY ?? null,
		http_proxy: process.env.http_proxy ?? null,
		https_proxy: process.env.https_proxy ?? null,
		all_proxy: process.env.all_proxy ?? null,
		no_proxy: process.env.no_proxy ?? null,
		SSL_CERT_FILE: process.env.SSL_CERT_FILE ?? null,
		SSL_CERT_DIR: process.env.SSL_CERT_DIR ?? null,
		LD_PRELOAD: process.env.LD_PRELOAD ?? null,
		LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH ?? null,
		LD_AUDIT: process.env.LD_AUDIT ?? null,
		DYLD_INSERT_LIBRARIES: process.env.DYLD_INSERT_LIBRARIES ?? null,
		DYLD_LIBRARY_PATH: process.env.DYLD_LIBRARY_PATH ?? null,
		DYLD_FRAMEWORK_PATH: process.env.DYLD_FRAMEWORK_PATH ?? null,
		DYLD_FALLBACK_LIBRARY_PATH: process.env.DYLD_FALLBACK_LIBRARY_PATH ?? null,
		DYLD_FALLBACK_FRAMEWORK_PATH: process.env.DYLD_FALLBACK_FRAMEWORK_PATH ?? null,
		DYLD_ROOT_PATH: process.env.DYLD_ROOT_PATH ?? null,
	}) + "\\n",
);
if (process.argv[2] === "auth") process.exit(0);
process.stdout.write("https://gist.github.com/example/abc123\\n");
`,
	);
	await fs.chmod(gh, 0o755);
	const open = path.join(binDir, "open");
	await Bun.write(open, "#!/bin/sh\nexit 0\n");
	await fs.chmod(open, 0o755);
}

async function share(options: {
	dotenv?: string;
	env?: Record<string, string>;
	moveAway?: boolean;
	launchFromFilesystemRoot?: boolean;
	nonCheckoutLaunch?: boolean;
	bunfigPreload?: boolean;
	autoload?: boolean;
	noSpawnError?: string;
	ghPathMode?:
		| "trusted"
		| "operator-only"
		| "checkout-relative"
		| "checkout-absolute"
		| "checkout-directory-symlink"
		| "checkout-executable-symlink"
		| "checkout-executable-symlink-fallback"
		| "moved-checkout"
		| "launch-directory";
}): Promise<GhSpawn[]> {
	const cwd = await tempDir("gjc-share-gh-env-");
	if (!options.nonCheckoutLaunch) await fs.mkdir(path.join(cwd, ".git"));
	const binDir = path.join(cwd, "bin");
	const operatorBinDir = await tempDir("gjc-share-gh-operator-bin-");
	const record = path.join(cwd, "spawns.ndjson");
	await writeGh(binDir, options.nonCheckoutLaunch ? "operator" : "checkout");
	await writeGh(operatorBinDir, "operator");
	const ghPathMode = options.ghPathMode ?? "trusted";
	if (ghPathMode === "checkout-directory-symlink") {
		await fs.rm(operatorBinDir, { recursive: true, force: true });
		await fs.symlink(binDir, operatorBinDir);
	} else if (ghPathMode === "checkout-executable-symlink" || ghPathMode === "checkout-executable-symlink-fallback") {
		await fs.rm(path.join(operatorBinDir, "gh"));
		await fs.symlink(path.join(binDir, "gh"), path.join(operatorBinDir, "gh"));
	}
	const fallbackBinDir =
		ghPathMode === "checkout-executable-symlink-fallback" ? await tempDir("gjc-share-gh-fallback-bin-") : undefined;
	if (fallbackBinDir) await writeGh(fallbackBinDir, "operator");
	const moveTo = options.moveAway ? await tempDir("gjc-share-gh-move-") : undefined;
	if (ghPathMode === "moved-checkout") {
		if (!moveTo) throw new Error("Moved-checkout PATH fixture was not created.");
		await fs.mkdir(path.join(moveTo, ".git"));
		await writeGh(path.join(moveTo, "bin"), "checkout");
	}

	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	for (const key of TRUST_KEYS) delete env[key];
	delete env.GJC_SHARE_EXPECT_HOST;
	delete env.GJC_SHARE_EXPECT_CONFIG;
	delete env.GJC_SHARE_MOVE_TO;
	delete env.GJC_SHARE_PROJECT_ROOT;
	delete env.GJC_SHARE_BUNFIG_MARKER;
	env.GJC_SHARE_GH_RECORD = record;
	env.GJC_SHARE_PROJECT_ROOT = cwd;
	if (options.bunfigPreload) env.GJC_SHARE_BUNFIG_MARKER = path.join(cwd, "bunfig-preload-ran");
	switch (ghPathMode) {
		case "checkout-relative":
			env.PATH = "bin";
			break;
		case "checkout-absolute":
			env.PATH = binDir;
			break;
		case "checkout-directory-symlink":
		case "checkout-executable-symlink":
			env.PATH = operatorBinDir;
			break;
		case "checkout-executable-symlink-fallback":
			if (!fallbackBinDir) throw new Error("Trusted fallback PATH fixture was not created.");
			env.PATH = `${operatorBinDir}${path.delimiter}${fallbackBinDir}${path.delimiter}${process.env.PATH ?? ""}`;
			break;
		case "moved-checkout":
			if (!moveTo) throw new Error("Moved-checkout PATH fixture was not created.");
			env.PATH = path.join(moveTo, "bin");
			break;
		case "operator-only":
			env.PATH = operatorBinDir;
			break;
		case "launch-directory":
			env.PATH = binDir;
			break;
		default:
			env.PATH = `${binDir}${path.delimiter}${operatorBinDir}${path.delimiter}${process.env.PATH ?? ""}`;
	}
	if (moveTo) env.GJC_SHARE_MOVE_TO = moveTo;
	env.GJC_SHARE_AGENT_DIR = path.join(cwd, "agent-dir");
	Object.assign(env, options.env);
	if (options.dotenv !== undefined) {
		await Bun.write(path.join(cwd, ".env"), options.dotenv);
	}

	const args = options.autoload ? [PROBE] : ["--no-env-file", PROBE];
	const proc = Bun.spawn([process.execPath, ...args], {
		cwd: options.launchFromFilesystemRoot ? path.parse(cwd).root : cwd,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`probe failed (${exitCode}): ${stderr || stdout}`);
	const recordFile = Bun.file(record);
	if (!(await recordFile.exists())) {
		if (options.noSpawnError && stderr.includes(options.noSpawnError)) return [];
		throw new Error(`probe produced no gh spawns: ${stderr || stdout}`);
	}
	const spawns = (await recordFile.text())
		.trim()
		.split("\n")
		.filter(line => line.length > 0)
		.map(line => JSON.parse(line) as GhSpawn);
	if (spawns.length !== 2) throw new Error(`expected auth and gist spawns, got ${JSON.stringify(spawns)} ${stderr}`);
	return spawns;
}

function expectDestination(
	spawns: GhSpawn[],
	expected: Partial<
		Pick<
			GhSpawn,
			| "GH_HOST"
			| "GH_CONFIG_DIR"
			| "GH_TOKEN"
			| "GITHUB_TOKEN"
			| "GH_ENTERPRISE_TOKEN"
			| "GITHUB_ENTERPRISE_TOKEN"
			| "XDG_CONFIG_HOME"
			| "HOME"
			| "USERPROFILE"
			| "APPDATA"
			| "BASH_ENV"
			| "BUN_OPTIONS"
			| "ENV"
			| "ZDOTDIR"
			| "NODE_OPTIONS"
			| "NODE_PATH"
			| "PYTHONHOME"
			| "PYTHONPATH"
			| "PYTHONUSERBASE"
			| "PYTHONSTARTUP"
			| "JULIA_DEPOT_PATH"
			| "JULIA_LOAD_PATH"
			| "JULIA_PROJECT"
			| "TCL_LIBRARY"
			| "TCLLIBPATH"
			| "LUA_INIT"
			| "R_ENVIRON"
			| "R_ENVIRON_USER"
			| "R_PROFILE"
			| "R_PROFILE_USER"
			| "ELIXIR_ERL_OPTIONS"
			| "ERL_AFLAGS"
			| "ERL_FLAGS"
			| "ERL_ZFLAGS"
			| "BUNDLER_SETUP"
			| "BUNDLE_GEMFILE"
			| "GEM_HOME"
			| "GEM_PATH"
			| "RUBYGEMS_GEMDEPS"
			| "RUBYOPT"
			| "RUBYLIB"
			| "PERL5OPT"
			| "PERL5LIB"
			| "PERLLIB"
			| "JAVA_HOME"
			| "JAVA_TOOL_OPTIONS"
			| "JDK_JAVA_OPTIONS"
			| "_JAVA_OPTIONS"
			| "CLASSPATH"
			| "PHPRC"
			| "PHP_INI_SCAN_DIR"
			| "DOTNET_STARTUP_HOOKS"
			| "OPENSSL_CONF"
			| "OPENSSL_CONF_INCLUDE"
			| "OPENSSL_MODULES"
			| "OPENSSL_ENGINES"
			| "HTTP_PROXY"
			| "HTTPS_PROXY"
			| "ALL_PROXY"
			| "NO_PROXY"
			| "http_proxy"
			| "https_proxy"
			| "all_proxy"
			| "no_proxy"
			| "SSL_CERT_FILE"
			| "SSL_CERT_DIR"
			| "LD_PRELOAD"
			| "LD_LIBRARY_PATH"
			| "LD_AUDIT"
			| "DYLD_INSERT_LIBRARIES"
			| "DYLD_LIBRARY_PATH"
			| "DYLD_FRAMEWORK_PATH"
			| "DYLD_FALLBACK_LIBRARY_PATH"
			| "DYLD_FALLBACK_FRAMEWORK_PATH"
			| "DYLD_ROOT_PATH"
		>
	> & {
		luaInitVersionedEnvironment?: Partial<GhSpawn["luaInitVersionedEnvironment"]>;
		luaModulePathEnvironment?: Partial<GhSpawn["luaModulePathEnvironment"]>;
		dotnetRootEnvironment?: Partial<GhSpawn["dotnetRootEnvironment"]>;
		profilerEnvironment?: Partial<GhSpawn["profilerEnvironment"]>;
	},
	allowPathsInsideLaunchDirectory = false,
): void {
	expect(spawns[0]?.args).toEqual(["auth", "status"]);
	expect(spawns[1]?.args.slice(0, 3)).toEqual(["gist", "create", "--public=false"]);
	for (const spawn of spawns) {
		expect(spawn.source).toBe("operator");
		expect(spawn.cwd).toBe(path.parse(spawn.projectRoot).root);
		const cwdRelative = path.relative(spawn.projectRoot, spawn.cwd);
		const cwdIsInsideProject =
			cwdRelative === "" ||
			(cwdRelative !== ".." && !cwdRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(cwdRelative));
		expect(cwdIsInsideProject).toBe(false);
		expect(spawn.bunfigPreloadExecuted).toBe(false);
		for (const directory of spawn.PATH.split(path.delimiter)) {
			const relative = path.relative(spawn.projectRoot, directory);
			const pathIsInsideLaunchDirectory =
				relative === "" ||
				(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
			expect(pathIsInsideLaunchDirectory).toBe(allowPathsInsideLaunchDirectory);
		}
		expect(spawn.GH_HOST).toBe(expected.GH_HOST ?? null);
		expect(spawn.GH_CONFIG_DIR).toBe(expected.GH_CONFIG_DIR ?? null);
		expect(spawn.GH_TOKEN).toBe(expected.GH_TOKEN ?? null);
		expect(spawn.GITHUB_TOKEN).toBe(expected.GITHUB_TOKEN ?? null);
		expect(spawn.GH_ENTERPRISE_TOKEN).toBe(expected.GH_ENTERPRISE_TOKEN ?? null);
		expect(spawn.GITHUB_ENTERPRISE_TOKEN).toBe(expected.GITHUB_ENTERPRISE_TOKEN ?? null);
		expect(spawn.XDG_CONFIG_HOME).toBe(expected.XDG_CONFIG_HOME ?? null);
		expect(spawn.HOME).toBe(expected.HOME ?? null);
		expect(spawn.USERPROFILE).toBe(expected.USERPROFILE ?? null);
		expect(spawn.APPDATA).toBe(expected.APPDATA ?? null);
		expect(spawn.BASH_ENV).toBe(expected.BASH_ENV ?? null);
		expect(spawn.BUN_OPTIONS).toBe(expected.BUN_OPTIONS ?? null);
		expect(spawn.ENV).toBe(expected.ENV ?? null);
		expect(spawn.ZDOTDIR).toBe(expected.ZDOTDIR ?? null);
		expect(spawn.NODE_OPTIONS).toBe(expected.NODE_OPTIONS ?? null);
		expect(spawn.NODE_PATH).toBe(expected.NODE_PATH ?? null);
		expect(spawn.PYTHONHOME).toBe(expected.PYTHONHOME ?? null);
		expect(spawn.PYTHONPATH).toBe(expected.PYTHONPATH ?? null);
		expect(spawn.PYTHONUSERBASE).toBe(expected.PYTHONUSERBASE ?? null);
		expect(spawn.PYTHONSTARTUP).toBe(expected.PYTHONSTARTUP ?? null);
		expect(spawn.JULIA_DEPOT_PATH).toBe(expected.JULIA_DEPOT_PATH ?? null);
		expect(spawn.JULIA_LOAD_PATH).toBe(expected.JULIA_LOAD_PATH ?? null);
		expect(spawn.JULIA_PROJECT).toBe(expected.JULIA_PROJECT ?? null);
		expect(spawn.TCL_LIBRARY).toBe(expected.TCL_LIBRARY ?? null);
		expect(spawn.TCLLIBPATH).toBe(expected.TCLLIBPATH ?? null);
		expect(spawn.LUA_INIT).toBe(expected.LUA_INIT ?? null);
		for (const name of LUA_INIT_VERSIONED_ENV_KEYS)
			expect(spawn.luaInitVersionedEnvironment[name]).toBe(expected.luaInitVersionedEnvironment?.[name] ?? null);
		for (const name of LUA_MODULE_PATH_ENV_KEYS)
			expect(spawn.luaModulePathEnvironment[name]).toBe(expected.luaModulePathEnvironment?.[name] ?? null);
		expect(spawn.R_ENVIRON).toBe(expected.R_ENVIRON ?? null);
		expect(spawn.R_ENVIRON_USER).toBe(expected.R_ENVIRON_USER ?? null);
		expect(spawn.R_PROFILE).toBe(expected.R_PROFILE ?? null);
		expect(spawn.R_PROFILE_USER).toBe(expected.R_PROFILE_USER ?? null);
		expect(spawn.ELIXIR_ERL_OPTIONS).toBe(expected.ELIXIR_ERL_OPTIONS ?? null);
		expect(spawn.ERL_AFLAGS).toBe(expected.ERL_AFLAGS ?? null);
		expect(spawn.ERL_FLAGS).toBe(expected.ERL_FLAGS ?? null);
		expect(spawn.ERL_ZFLAGS).toBe(expected.ERL_ZFLAGS ?? null);
		expect(spawn.BUNDLER_SETUP).toBe(expected.BUNDLER_SETUP ?? null);
		expect(spawn.BUNDLE_GEMFILE).toBe(expected.BUNDLE_GEMFILE ?? null);
		expect(spawn.GEM_HOME).toBe(expected.GEM_HOME ?? null);
		expect(spawn.GEM_PATH).toBe(expected.GEM_PATH ?? null);
		expect(spawn.RUBYGEMS_GEMDEPS).toBe(expected.RUBYGEMS_GEMDEPS ?? null);
		expect(spawn.RUBYOPT).toBe(expected.RUBYOPT ?? null);
		expect(spawn.RUBYLIB).toBe(expected.RUBYLIB ?? null);
		expect(spawn.PERL5OPT).toBe(expected.PERL5OPT ?? null);
		expect(spawn.PERL5LIB).toBe(expected.PERL5LIB ?? null);
		expect(spawn.PERLLIB).toBe(expected.PERLLIB ?? null);
		expect(spawn.JAVA_HOME).toBe(expected.JAVA_HOME ?? null);
		expect(spawn.JAVA_TOOL_OPTIONS).toBe(expected.JAVA_TOOL_OPTIONS ?? null);
		expect(spawn.JDK_JAVA_OPTIONS).toBe(expected.JDK_JAVA_OPTIONS ?? null);
		expect(spawn._JAVA_OPTIONS).toBe(expected._JAVA_OPTIONS ?? null);
		expect(spawn.CLASSPATH).toBe(expected.CLASSPATH ?? null);
		expect(spawn.PHPRC).toBe(expected.PHPRC ?? null);
		expect(spawn.PHP_INI_SCAN_DIR).toBe(expected.PHP_INI_SCAN_DIR ?? null);
		expect(spawn.DOTNET_STARTUP_HOOKS).toBe(expected.DOTNET_STARTUP_HOOKS ?? null);
		expect(spawn.OPENSSL_CONF).toBe(expected.OPENSSL_CONF ?? null);
		expect(spawn.OPENSSL_CONF_INCLUDE).toBe(expected.OPENSSL_CONF_INCLUDE ?? null);
		expect(spawn.OPENSSL_MODULES).toBe(expected.OPENSSL_MODULES ?? null);
		expect(spawn.OPENSSL_ENGINES).toBe(expected.OPENSSL_ENGINES ?? null);
		for (const name of DOTNET_ROOT_ENV_KEYS)
			expect(spawn.dotnetRootEnvironment[name]).toBe(expected.dotnetRootEnvironment?.[name] ?? null);
		for (const name of CLR_PROFILER_ENV_KEYS)
			expect(spawn.profilerEnvironment[name]).toBe(expected.profilerEnvironment?.[name] ?? null);
		expect(spawn.HTTP_PROXY).toBe(expected.HTTP_PROXY ?? null);
		expect(spawn.HTTPS_PROXY).toBe(expected.HTTPS_PROXY ?? null);
		expect(spawn.ALL_PROXY).toBe(expected.ALL_PROXY ?? null);
		expect(spawn.NO_PROXY).toBe(expected.NO_PROXY ?? null);
		expect(spawn.http_proxy).toBe(expected.http_proxy ?? null);
		expect(spawn.https_proxy).toBe(expected.https_proxy ?? null);
		expect(spawn.all_proxy).toBe(expected.all_proxy ?? null);
		expect(spawn.no_proxy).toBe(expected.no_proxy ?? null);
		expect(spawn.SSL_CERT_FILE).toBe(expected.SSL_CERT_FILE ?? null);
		expect(spawn.SSL_CERT_DIR).toBe(expected.SSL_CERT_DIR ?? null);
		expect(spawn.LD_PRELOAD).toBe(expected.LD_PRELOAD ?? null);
		expect(spawn.LD_LIBRARY_PATH).toBe(expected.LD_LIBRARY_PATH ?? null);
		expect(spawn.LD_AUDIT).toBe(expected.LD_AUDIT ?? null);
		expect(spawn.DYLD_INSERT_LIBRARIES).toBe(expected.DYLD_INSERT_LIBRARIES ?? null);
		expect(spawn.DYLD_LIBRARY_PATH).toBe(expected.DYLD_LIBRARY_PATH ?? null);
		expect(spawn.DYLD_FRAMEWORK_PATH).toBe(expected.DYLD_FRAMEWORK_PATH ?? null);
		expect(spawn.DYLD_FALLBACK_LIBRARY_PATH).toBe(expected.DYLD_FALLBACK_LIBRARY_PATH ?? null);
		expect(spawn.DYLD_FALLBACK_FRAMEWORK_PATH).toBe(expected.DYLD_FALLBACK_FRAMEWORK_PATH ?? null);
		expect(spawn.DYLD_ROOT_PATH).toBe(expected.DYLD_ROOT_PATH ?? null);
	}
}

// The recorder is a POSIX `env -S bun --no-env-file` script so it reports the
// environment `/share` passed in, instead of loading the project dotenv itself.
describe.skipIf(process.platform === "win32")("share gh destination trust", () => {
	it("omits a project dotenv host and config directory from both gh spawns", async () => {
		const spawns = await share({
			autoload: true,
			dotenv: "export GH_HOST=attacker-egress.example # note\nGH_CONFIG_DIR=attacker-config\n",
			env: {
				GH_TOKEN: "operator-token",
				GITHUB_TOKEN: "operator-github-token",
				GH_ENTERPRISE_TOKEN: "operator-enterprise-token",
				GITHUB_ENTERPRISE_TOKEN: "operator-enterprise-github-token",
				GJC_SHARE_EXPECT_HOST: "attacker-egress.example",
				GJC_SHARE_EXPECT_CONFIG: "attacker-config",
			},
		});
		expectDestination(spawns, {
			GH_HOST: null,
			GH_CONFIG_DIR: null,
			GH_TOKEN: "operator-token",
			GITHUB_TOKEN: "operator-github-token",
			GH_ENTERPRISE_TOKEN: "operator-enterprise-token",
			GITHUB_ENTERPRISE_TOKEN: "operator-enterprise-github-token",
		});
	});

	it("omits project dotenv GitHub CLI tokens from both gh spawns", async () => {
		const spawns = await share({
			autoload: true,
			dotenv: `GH_TOKEN=project-gh-token
GITHUB_TOKEN=project-github-token
GH_ENTERPRISE_TOKEN=project-enterprise-token
GITHUB_ENTERPRISE_TOKEN=project-enterprise-github-token
XDG_CONFIG_HOME=project-config
HOME=project-home
USERPROFILE=project-profile
APPDATA=project-appdata
`,
		});
		expectDestination(spawns, {});
	});

	it("omits project dotenv startup hooks and runtime paths from both gh spawns", async () => {
		const spawns = await share({
			autoload: true,
			dotenv: `BASH_ENV=/project/bash-startup
ENV=/project/shell-startup
ZDOTDIR=/project/zsh
NODE_OPTIONS=--no-warnings
NODE_PATH=/project/node-modules
PYTHONHOME=/project/python-home
PYTHONPATH=/project/python-path
PYTHONUSERBASE=/project/python-user-base
PYTHONSTARTUP=/project/python-startup.py
JULIA_DEPOT_PATH=/project/julia-depot
JULIA_LOAD_PATH=/project/julia-load-path
JULIA_PROJECT=/project/julia-project
TCL_LIBRARY=/project/tcl-library
TCLLIBPATH=/project/tcl-packages
LUA_INIT=@/project/lua-init.lua
LUA_INIT_5_1=@/project/lua-init-5.1.lua
LUA_INIT_5_2=@/project/lua-init-5.2.lua
LUA_INIT_5_3=@/project/lua-init-5.3.lua
LUA_INIT_5_4=@/project/lua-init-5.4.lua
LUA_INIT_5_5=@/project/lua-init-5.5.lua
LUA_PATH=/project/lua-path
LUA_CPATH=/project/lua-cpath
LUA_PATH_5_1=/project/lua-path-5.1
LUA_PATH_5_2=/project/lua-path-5.2
LUA_PATH_5_3=/project/lua-path-5.3
LUA_PATH_5_4=/project/lua-path-5.4
LUA_PATH_5_5=/project/lua-path-5.5
LUA_CPATH_5_1=/project/lua-cpath-5.1
LUA_CPATH_5_2=/project/lua-cpath-5.2
LUA_CPATH_5_3=/project/lua-cpath-5.3
LUA_CPATH_5_4=/project/lua-cpath-5.4
LUA_CPATH_5_5=/project/lua-cpath-5.5
R_ENVIRON=/project/site.Renviron
R_ENVIRON_USER=/project/user.Renviron
R_PROFILE=/project/site.Rprofile
R_PROFILE_USER=/project/user.Rprofile
ELIXIR_ERL_OPTIONS=-eval project-startup-elixir
ERL_AFLAGS=-eval project-startup-a
ERL_FLAGS=-eval project-startup-b
ERL_ZFLAGS=-eval project-startup-c
BUNDLER_SETUP=/project/bundler-setup.rb
BUNDLE_GEMFILE=/project/Gemfile
GEM_HOME=/project/gem-home
GEM_PATH=/project/gem-path
RUBYGEMS_GEMDEPS=/project/Gemfile
RUBYOPT=-r/project/ruby-startup.rb
RUBYLIB=/project/ruby-libraries
PERL5OPT=-MProject::Startup
PERL5LIB=/project/perl5-libraries
PERLLIB=/project/perl-libraries
JAVA_HOME=/project/jdk
JAVA_TOOL_OPTIONS=-javaagent:/project/java-agent.jar
JDK_JAVA_OPTIONS=-javaagent:/project/jdk-agent.jar
_JAVA_OPTIONS=-javaagent:/project/legacy-java-agent.jar
CLASSPATH=/project/classes
PHPRC=/project/php.ini
PHP_INI_SCAN_DIR=/project/php-conf.d
DOTNET_STARTUP_HOOKS=/project/dotnet-startup.dll
DOTNET_ROOT=/project/dotnet-root
DOTNET_ROOT_X86=/project/dotnet-root-x86
DOTNET_ROOT_X64=/project/dotnet-root-x64
DOTNET_ROOT_ARM=/project/dotnet-root-arm
DOTNET_ROOT_ARM64=/project/dotnet-root-arm64
CORECLR_ENABLE_PROFILING=1
DOTNET_ENABLE_PROFILING=1
CORECLR_PROFILER={12345678-1234-1234-1234-123456789012}
DOTNET_PROFILER={12345678-1234-1234-1234-123456789012}
CORECLR_PROFILER_PATH=/project/coreclr-profiler.so
CORECLR_PROFILER_PATH_32=/project/coreclr-profiler-32.so
CORECLR_PROFILER_PATH_64=/project/coreclr-profiler-64.so
CORECLR_PROFILER_PATH_ARM32=/project/coreclr-profiler-arm32.so
CORECLR_PROFILER_PATH_ARM64=/project/coreclr-profiler-arm64.so
DOTNET_PROFILER_PATH=/project/dotnet-profiler.so
DOTNET_PROFILER_PATH_32=/project/dotnet-profiler-32.so
DOTNET_PROFILER_PATH_64=/project/dotnet-profiler-64.so
DOTNET_PROFILER_PATH_ARM32=/project/dotnet-profiler-arm32.so
DOTNET_PROFILER_PATH_ARM64=/project/dotnet-profiler-arm64.so
OPENSSL_CONF=/project/openssl.cnf
OPENSSL_CONF_INCLUDE=/project/openssl-conf-include
OPENSSL_MODULES=/project/openssl-modules
OPENSSL_ENGINES=/project/openssl-engines
`,
		});
		expectDestination(spawns, {
			BASH_ENV: null,
			ENV: null,
			ZDOTDIR: null,
			NODE_OPTIONS: null,
			NODE_PATH: null,
			PYTHONHOME: null,
			PYTHONPATH: null,
			PYTHONUSERBASE: null,
			PYTHONSTARTUP: null,
			JULIA_DEPOT_PATH: null,
			TCL_LIBRARY: null,
			TCLLIBPATH: null,
			LUA_INIT: null,
			R_ENVIRON: null,
			R_ENVIRON_USER: null,
			R_PROFILE: null,
			R_PROFILE_USER: null,
			ELIXIR_ERL_OPTIONS: null,
			ERL_AFLAGS: null,
			ERL_FLAGS: null,
			ERL_ZFLAGS: null,
			BUNDLER_SETUP: null,
			BUNDLE_GEMFILE: null,
			GEM_HOME: null,
			GEM_PATH: null,
			RUBYGEMS_GEMDEPS: null,
			RUBYOPT: null,
			RUBYLIB: null,
			PERL5OPT: null,
			PERL5LIB: null,
			PERLLIB: null,
			JAVA_HOME: null,
			JAVA_TOOL_OPTIONS: null,
			JDK_JAVA_OPTIONS: null,
			_JAVA_OPTIONS: null,
			CLASSPATH: null,
			PHPRC: null,
			PHP_INI_SCAN_DIR: null,
			DOTNET_STARTUP_HOOKS: null,
			OPENSSL_CONF: null,
			OPENSSL_CONF_INCLUDE: null,
			OPENSSL_MODULES: null,
			OPENSSL_ENGINES: null,
		});
	});

	it("preserves operator-declared runtime settings", async () => {
		const juliaEnvironment = {
			JULIA_DEPOT_PATH: "/operator/julia-depot",
			JULIA_LOAD_PATH: "/operator/julia-load-path",
			JULIA_PROJECT: "/operator/julia-project",
		};
		const luaInitVersionedEnvironment = { LUA_INIT_5_4: "@/operator/lua-init-5.4.lua" };
		const luaModulePathEnvironment = Object.fromEntries(
			LUA_MODULE_PATH_ENV_KEYS.map(name => [name, `/operator/${name.toLowerCase()}`]),
		) as Record<LuaModulePathEnvironmentKey, string>;
		const dotnetRootEnvironment = Object.fromEntries(
			DOTNET_ROOT_ENV_KEYS.map(name => [name, `/operator/${name.toLowerCase()}`]),
		) as Record<DotnetRootEnvironmentKey, string>;
		const profilerEnvironment = Object.fromEntries(
			CLR_PROFILER_ENV_KEYS.map(name => [name, `operator-${name.toLowerCase()}`]),
		) as Record<ClrProfilerEnvironmentKey, string>;
		const spawns = await share({
			env: {
				NODE_OPTIONS: "--no-warnings",
				NODE_PATH: "/operator/node-modules",
				PYTHONHOME: "/operator/python-home",
				PYTHONPATH: "/operator/python-path",
				PYTHONUSERBASE: "/operator/python-user-base",
				PYTHONSTARTUP: "/operator/python-startup.py",
				...juliaEnvironment,
				TCL_LIBRARY: "/operator/tcl-library",
				TCLLIBPATH: "/operator/tcl-packages",
				LUA_INIT: "@/operator/lua-init.lua",
				...luaInitVersionedEnvironment,
				R_ENVIRON: "/operator/site.Renviron",
				R_ENVIRON_USER: "/operator/user.Renviron",
				R_PROFILE: "/operator/site.Rprofile",
				R_PROFILE_USER: "/operator/user.Rprofile",
				ELIXIR_ERL_OPTIONS: "-eval operator-startup-elixir",
				ERL_AFLAGS: "-eval operator-startup-a",
				ERL_FLAGS: "-eval operator-startup-b",
				ERL_ZFLAGS: "-eval operator-startup-c",
				BUNDLER_SETUP: "/operator/bundler-setup.rb",
				BUNDLE_GEMFILE: "/operator/Gemfile",
				GEM_HOME: "/operator/gem-home",
				GEM_PATH: "/operator/gem-path",
				RUBYGEMS_GEMDEPS: "/operator/Gemfile",
				RUBYOPT: "-r/operator/ruby-startup.rb",
				RUBYLIB: "/operator/ruby-libraries",
				PERL5OPT: "-MOperator::Startup",
				PERL5LIB: "/operator/perl5-libraries",
				PERLLIB: "/operator/perl-libraries",
				JAVA_HOME: "/operator/jdk",
				JAVA_TOOL_OPTIONS: "-javaagent:/operator/java-agent.jar",
				JDK_JAVA_OPTIONS: "-javaagent:/operator/jdk-agent.jar",
				_JAVA_OPTIONS: "-javaagent:/operator/legacy-java-agent.jar",
				CLASSPATH: "/operator/classes",
				PHPRC: "/operator/php.ini",
				PHP_INI_SCAN_DIR: "/operator/php-conf.d",
				DOTNET_STARTUP_HOOKS: "/operator/dotnet-startup.dll",
				OPENSSL_CONF: "/operator/openssl.cnf",
				OPENSSL_CONF_INCLUDE: "/operator/openssl-conf-include",
				OPENSSL_MODULES: "/operator/openssl-modules",
				OPENSSL_ENGINES: "/operator/openssl-engines",
				...luaModulePathEnvironment,
				...dotnetRootEnvironment,
				...profilerEnvironment,
			},
		});
		expectDestination(spawns, {
			NODE_OPTIONS: "--no-warnings",
			NODE_PATH: "/operator/node-modules",
			PYTHONHOME: "/operator/python-home",
			PYTHONPATH: "/operator/python-path",
			PYTHONUSERBASE: "/operator/python-user-base",
			PYTHONSTARTUP: "/operator/python-startup.py",
			...juliaEnvironment,
			TCL_LIBRARY: "/operator/tcl-library",
			TCLLIBPATH: "/operator/tcl-packages",
			LUA_INIT: "@/operator/lua-init.lua",
			luaInitVersionedEnvironment,
			R_ENVIRON: "/operator/site.Renviron",
			R_ENVIRON_USER: "/operator/user.Renviron",
			R_PROFILE: "/operator/site.Rprofile",
			R_PROFILE_USER: "/operator/user.Rprofile",
			ELIXIR_ERL_OPTIONS: "-eval operator-startup-elixir",
			ERL_AFLAGS: "-eval operator-startup-a",
			ERL_FLAGS: "-eval operator-startup-b",
			ERL_ZFLAGS: "-eval operator-startup-c",
			BUNDLER_SETUP: "/operator/bundler-setup.rb",
			BUNDLE_GEMFILE: "/operator/Gemfile",
			GEM_HOME: "/operator/gem-home",
			GEM_PATH: "/operator/gem-path",
			RUBYGEMS_GEMDEPS: "/operator/Gemfile",
			RUBYOPT: "-r/operator/ruby-startup.rb",
			RUBYLIB: "/operator/ruby-libraries",
			PERL5OPT: "-MOperator::Startup",
			PERL5LIB: "/operator/perl5-libraries",
			PERLLIB: "/operator/perl-libraries",
			JAVA_HOME: "/operator/jdk",
			JAVA_TOOL_OPTIONS: "-javaagent:/operator/java-agent.jar",
			JDK_JAVA_OPTIONS: "-javaagent:/operator/jdk-agent.jar",
			_JAVA_OPTIONS: "-javaagent:/operator/legacy-java-agent.jar",
			CLASSPATH: "/operator/classes",
			PHPRC: "/operator/php.ini",
			PHP_INI_SCAN_DIR: "/operator/php-conf.d",
			DOTNET_STARTUP_HOOKS: "/operator/dotnet-startup.dll",
			OPENSSL_CONF: "/operator/openssl.cnf",
			OPENSSL_CONF_INCLUDE: "/operator/openssl-conf-include",
			OPENSSL_MODULES: "/operator/openssl-modules",
			OPENSSL_ENGINES: "/operator/openssl-engines",
			luaModulePathEnvironment,
			dotnetRootEnvironment,
			profilerEnvironment,
		});
	});

	it("runs Bun-based gh wrappers outside project bunfig preloads", async () => {
		const spawns = await share({
			bunfigPreload: true,
			autoload: true,
			dotenv: "BUN_OPTIONS=--preload=/definitely-not-a-real-gjc-preload.ts",
		});
		expectDestination(spawns, { BUN_OPTIONS: null });
		expect(spawns.map(spawn => spawn.bunfigPreloadExecuted)).toEqual([false, false]);
	});

	it("omits project dotenv proxy and CA overrides from both gh spawns", async () => {
		const spawns = await share({
			autoload: true,
			dotenv: `HTTPS_PROXY=https://project-proxy.example
https_proxy=http://project-lower-proxy.example
SSL_CERT_FILE=project-ca.pem
SSL_CERT_DIR=project-ca-dir
`,
		});
		expectDestination(spawns, {});
	});

	it("omits project dotenv native-loader overrides from both gh spawns", async () => {
		const spawns = await share({
			autoload: true,
			dotenv: `LD_PRELOAD=/project/preload.so
LD_LIBRARY_PATH=/project/lib
LD_AUDIT=/project/audit.so
DYLD_INSERT_LIBRARIES=/project/injected.dylib
DYLD_LIBRARY_PATH=/project/dyld
DYLD_FRAMEWORK_PATH=/project/frameworks
DYLD_FALLBACK_LIBRARY_PATH=/project/fallback
DYLD_FALLBACK_FRAMEWORK_PATH=/project/fallback-frameworks
DYLD_ROOT_PATH=/project/root
`,
		});
		expectDestination(spawns, {});
	});

	it("refuses a project-only PATH instead of resolving gh from the checkout", async () => {
		const spawns = await share({
			autoload: true,
			dotenv: "PATH=/project/bin\n",
			env: { PATH: "/project/bin" },
			noSpawnError: "GitHub CLI (gh) is not installed on the trusted operator PATH",
		});
		expect(spawns).toEqual([]);
	});

	it("refuses a checkout-relative operator PATH instead of resolving gh from the checkout", async () => {
		const spawns = await share({
			autoload: true,
			dotenv: "OTHER=1\n",
			ghPathMode: "checkout-relative",
			noSpawnError: "GitHub CLI (gh) is not installed on the trusted operator PATH",
		});
		expect(spawns).toEqual([]);
	});

	it("uses an operator gh instead of an absolute checkout PATH entry", async () => {
		const spawns = await share({
			autoload: true,
			dotenv: "OTHER=1\n",
			ghPathMode: "trusted",
		});
		expectDestination(spawns, {});
	});

	it("refuses a checkout-only absolute operator PATH", async () => {
		const spawns = await share({
			autoload: true,
			dotenv: "OTHER=1\n",
			ghPathMode: "checkout-absolute",
			noSpawnError: "GitHub CLI (gh) is not installed on the trusted operator PATH",
		});
		expect(spawns).toEqual([]);
	});

	it("keeps operator PATH entries when launched from the filesystem root", async () => {
		const spawns = await share({
			moveAway: true,
			launchFromFilesystemRoot: true,
			ghPathMode: "operator-only",
		});
		expectDestination(spawns, {});
	});

	it("keeps a trusted gh install beneath a non-checkout launch directory", async () => {
		const spawns = await share({
			autoload: true,
			nonCheckoutLaunch: true,
			ghPathMode: "launch-directory",
		});
		expectDestination(spawns, {}, true);
		for (const spawn of spawns) {
			expect(spawn.PATH.split(path.delimiter)).toEqual([path.join(spawn.projectRoot, "bin")]);
		}
	});

	it("refuses a PATH directory symlink that resolves into the checkout", async () => {
		const spawns = await share({
			autoload: true,
			dotenv: "OTHER=1\n",
			ghPathMode: "checkout-directory-symlink",
			noSpawnError: "GitHub CLI (gh) is not installed on the trusted operator PATH",
		});
		expect(spawns).toEqual([]);
	});

	it("refuses an operator-path gh symlink that resolves into the checkout", async () => {
		const spawns = await share({
			autoload: true,
			dotenv: "OTHER=1\n",
			ghPathMode: "checkout-executable-symlink",
			noSpawnError: "GitHub CLI (gh) is not installed on the trusted operator PATH",
		});
		expect(spawns).toEqual([]);
	});

	it("skips a checkout-targeting gh symlink and selects a trusted fallback", async () => {
		const spawns = await share({
			autoload: true,
			dotenv: "OTHER=1\n",
			ghPathMode: "checkout-executable-symlink-fallback",
		});
		expectDestination(spawns, {});
	});

	it("keeps an operator host and config directory the project does not declare", async () => {
		const spawns = await share({
			dotenv: "OTHER=1\n",
			env: {
				GH_HOST: "ghe.example.com",
				GH_CONFIG_DIR: "operator-config",
				GH_TOKEN: "operator-token",
				GJC_SHARE_EXPECT_HOST: "ghe.example.com",
				GJC_SHARE_EXPECT_CONFIG: "operator-config",
				XDG_CONFIG_HOME: "operator-xdg-config",
			},
		});
		const launchRoot = spawns[0]?.projectRoot;
		if (!launchRoot) throw new Error("Share fixture did not record the launch root.");
		expectDestination(spawns, {
			GH_HOST: "ghe.example.com",
			GH_CONFIG_DIR: path.resolve(launchRoot, "operator-config"),
			GH_TOKEN: "operator-token",
			XDG_CONFIG_HOME: path.resolve(launchRoot, "operator-xdg-config"),
		});
	});

	it("anchors a preserved relative gh config directory to the launch root", async () => {
		const spawns = await share({
			autoload: true,
			dotenv: "OTHER=1\n",
			moveAway: true,
			env: {
				GH_CONFIG_DIR: "relative/gh",
				GJC_SHARE_EXPECT_CONFIG: "relative/gh",
			},
		});
		const launchRoot = spawns[0]?.projectRoot;
		if (!launchRoot) throw new Error("Share fixture did not record the launch root.");

		expectDestination(spawns, { GH_CONFIG_DIR: path.resolve(launchRoot, "relative/gh") });
		for (const spawn of spawns) expect(spawn.cwd).toBe(path.parse(launchRoot).root);
	});

	it("anchors a preserved relative XDG config home to the launch root", async () => {
		const spawns = await share({
			autoload: true,
			dotenv: "OTHER=1\n",
			moveAway: true,
			env: { XDG_CONFIG_HOME: "relative/xdg" },
		});
		const launchRoot = spawns[0]?.projectRoot;
		if (!launchRoot) throw new Error("Share fixture did not record the launch root.");

		expectDestination(spawns, { XDG_CONFIG_HOME: path.resolve(launchRoot, "relative/xdg") });
	});

	it("anchors relative operator certificate paths to the launch root", async () => {
		const absoluteCertDirectory = path.join(path.parse(process.cwd()).root, "operator", "certs");
		const spawns = await share({
			autoload: true,
			dotenv: "OTHER=1\n",
			moveAway: true,
			env: {
				SSL_CERT_FILE: "relative/certs/ca.pem",
				SSL_CERT_DIR: ["relative/certs/one", absoluteCertDirectory, "relative/certs/two"].join(path.delimiter),
			},
		});
		const launchRoot = spawns[0]?.projectRoot;
		if (!launchRoot) throw new Error("Share fixture did not record the launch root.");

		expectDestination(spawns, {
			SSL_CERT_FILE: path.resolve(launchRoot, "relative/certs/ca.pem"),
			SSL_CERT_DIR: [
				path.resolve(launchRoot, "relative/certs/one"),
				absoluteCertDirectory,
				path.resolve(launchRoot, "relative/certs/two"),
			].join(path.delimiter),
		});
	});

	it("keeps operator proxy and CA values that differ from project declarations", async () => {
		const spawns = await share({
			dotenv: `HTTPS_PROXY=https://project-proxy.example
SSL_CERT_FILE=project-ca.pem
`,
			env: {
				HTTPS_PROXY: "https://operator-proxy.example",
				SSL_CERT_FILE: "/operator/ca.pem",
			},
		});
		expectDestination(spawns, {
			HTTPS_PROXY: "https://operator-proxy.example",
			SSL_CERT_FILE: "/operator/ca.pem",
		});
	});

	it("keeps an operator host that differs from the project declaration", async () => {
		const spawns = await share({
			dotenv: "GH_HOST=attacker-egress.example\nGH_CONFIG_DIR=attacker-config\n",
			env: {
				GH_HOST: "ghe.example.com",
				GH_CONFIG_DIR: "operator-config",
				GH_TOKEN: "operator-token",
				GJC_SHARE_EXPECT_HOST: "ghe.example.com",
				GJC_SHARE_EXPECT_CONFIG: "operator-config",
			},
		});
		const launchRoot = spawns[0]?.projectRoot;
		if (!launchRoot) throw new Error("Share fixture did not record the launch root.");
		expectDestination(spawns, {
			GH_HOST: "ghe.example.com",
			GH_CONFIG_DIR: path.resolve(launchRoot, "operator-config"),
			GH_TOKEN: "operator-token",
		});
	});

	it("still omits the launch project host after the session cwd moves", async () => {
		const spawns = await share({
			dotenv: "GH_HOST=attacker-egress.example\nGH_CONFIG_DIR=attacker-config\n",
			moveAway: true,
			env: {
				GH_TOKEN: "operator-token",
				GJC_SHARE_EXPECT_HOST: "attacker-egress.example",
				GJC_SHARE_EXPECT_CONFIG: "attacker-config",
			},
		});
		expectDestination(spawns, { GH_HOST: null, GH_CONFIG_DIR: null, GH_TOKEN: "operator-token" });
	});

	it("refuses a PATH executable owned by the checkout after the session moves", async () => {
		const spawns = await share({
			autoload: true,
			moveAway: true,
			ghPathMode: "moved-checkout",
			dotenv: "OTHER=1\n",
			noSpawnError: "GitHub CLI (gh) is not installed on the trusted operator PATH",
		});
		expect(spawns).toEqual([]);
	});
	it("omits a dynamic project declaration even when the runtime value differs", async () => {
		const spawns = await share({
			autoload: true,
			dotenv: `GH_HOST=$${""}{GH_HOST_PLANTED}\nGH_CONFIG_DIR=$${""}{GH_CONFIG_PLANTED}\n`,
			env: {
				GH_HOST_PLANTED: "attacker-egress.example",
				GH_CONFIG_PLANTED: "attacker-config",
				GH_TOKEN: "operator-token",
				GJC_SHARE_EXPECT_HOST: "attacker-egress.example",
				GJC_SHARE_EXPECT_CONFIG: "attacker-config",
			},
		});
		expectDestination(spawns, { GH_HOST: null, GH_CONFIG_DIR: null, GH_TOKEN: "operator-token" });
	});
});
