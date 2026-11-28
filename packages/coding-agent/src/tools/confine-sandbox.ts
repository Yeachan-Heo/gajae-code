import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const UNSAFE_PROFILE_PATH = /[\u0000-\u001f"()#]/;

/**
 * macOS Seatbelt profile for a confined session.
 *
 * The shell process and everything it spawns may read the system (so compilers
 * and interpreters keep working) but may not read or write anything beside or
 * above the session root. Writes are limited to that root. This is a process
 * boundary, not a promise about other host processes the user starts themselves.
 */
export function confineSandboxProfile(root: string): string {
	const confinedRoot = seatbeltPath(root);
	return [
		"(version 1)",
		"(allow default)",
		'(deny file-read* (subpath "/"))',
		'(deny file-read* (require-all (subpath "/") (vnode-type SYMLINK)))',
		`(allow file-read* (subpath ${quote(confinedRoot)}))`,
		// git and realpath(3) stat every ancestor of the working directory. Metadata
		// only: listing or reading an ancestor stays denied.
		...ancestorsOf(confinedRoot).map(dir => `(allow file-read-metadata (literal ${quote(dir)}))`),
		'(allow file-read* (literal "/"))',
		'(allow file-read* (subpath "/bin"))',
		'(allow file-read* (subpath "/usr"))',
		'(allow file-read* (subpath "/System"))',
		'(allow file-read* (subpath "/Library"))',
		'(allow file-read* (subpath "/Applications"))',
		'(allow file-read* (subpath "/dev"))',
		'(allow file-read* (literal "/opt"))',
		'(allow file-read* (subpath "/opt/homebrew"))',
		// System configuration (git's /etc/gitconfig, TLS roots, resolver files), reached
		// through the root-owned `/etc` link.
		'(allow file-read* (literal "/etc"))',
		'(allow file-read* (subpath "/private/etc"))',
		// Root-owned selector links: `/bin/sh` reads `/private/var/select/sh` to pick its
		// shell, and the `/usr/bin` developer-tool shims (git, cc, make) resolve
		// `/var/select/developer_dir` through the `/var` link.
		'(allow file-read* (literal "/var"))',
		'(allow file-read* (subpath "/private/var/select"))',
		'(allow file-read* (literal "/private/var/db/xcode_select_link"))',
		...userGitConfigReadRules(),
		"(deny file-write*)",
		`(allow file-write* (subpath ${quote(confinedRoot)}))`,
		// Character devices that hold no data: `> /dev/null`, git's stdio setup, and
		// interactive prompts need them writable.
		'(allow file-write* (literal "/dev/null"))',
		'(allow file-write* (literal "/dev/zero"))',
		'(allow file-write* (literal "/dev/tty"))',
		'(allow file-write* (literal "/dev/stdout"))',
		'(allow file-write* (literal "/dev/stderr"))',
		'(allow file-write* (subpath "/dev/fd"))',
		// The /usr/bin developer-tool shims (git, cc, make) cache their lookup in the
		// per-user temp directory and print an error on every call when they cannot.
		// Only that cache file is opened there.
		'(allow file-read* file-write* (regex #"^/private/var/folders/[^/]+/[^/]+/T/xcrun_db"))',
	].join("\n");
}

/**
 * Read-only access to the user's git configuration. git aborts on an unreadable
 * `~/.gitconfig` instead of skipping it, so without these rules no git command runs
 * in a confined shell. Only the two config locations are opened, never the home
 * directory itself; a home path the profile cannot express gets no rule.
 */
function userGitConfigReadRules(): string[] {
	let home: string;
	try {
		home = fs.realpathSync(os.homedir());
	} catch {
		return [];
	}
	if (UNSAFE_PROFILE_PATH.test(home)) return [];
	return [
		...ancestorsOf(home).map(dir => `(allow file-read-metadata (literal ${quote(dir)}))`),
		`(allow file-read-metadata (literal ${quote(home)}))`,
		`(allow file-read* (literal ${quote(path.join(home, ".gitconfig"))}))`,
		`(allow file-read* (subpath ${quote(path.join(home, ".config", "git"))}))`,
	];
}

/** Every directory above `dir`, excluding `/` itself. */
function ancestorsOf(dir: string): string[] {
	const ancestors: string[] = [];
	for (let parent = path.dirname(dir); parent !== path.dirname(parent); parent = path.dirname(parent)) {
		ancestors.push(parent);
	}
	return ancestors;
}

const TRUSTED_SANDBOX_EXEC = "/usr/bin/sandbox-exec";

function trustedSandboxExec(): string {
	if (!fs.existsSync(TRUSTED_SANDBOX_EXEC)) {
		throw new Error(`Confined sessions require ${TRUSTED_SANDBOX_EXEC}.`);
	}
	return TRUSTED_SANDBOX_EXEC;
}

export function sandboxExecAvailable(): boolean {
	return process.platform === "darwin" && fs.existsSync(TRUSTED_SANDBOX_EXEC);
}

/**
 * Run `command` inside the confined-session sandbox.
 * The wrapper is a single quoted argument, so metacharacters in the command
 * stay inside the sandboxed process instead of being parsed by the outer shell.
 */
export function sandboxedShellCommand(command: string, root: string): string {
	if (!sandboxExecAvailable()) {
		throw new Error(
			`Confined sessions require a process sandbox, which this build only provides on macOS (got ${process.platform}).`,
		);
	}
	return `${trustedSandboxExec()} -p ${shellQuote(confineSandboxProfile(root))} /bin/sh -c ${shellQuote(command)}`;
}

function seatbeltPath(value: string): string {
	let resolved = path.resolve(value);
	try {
		resolved = fs.realpathSync(value);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (UNSAFE_PROFILE_PATH.test(resolved)) {
		throw new Error(`Confined session root cannot be expressed in a sandbox profile: ${resolved}`);
	}
	return resolved;
}

function quote(value: string): string {
	return JSON.stringify(value);
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}
