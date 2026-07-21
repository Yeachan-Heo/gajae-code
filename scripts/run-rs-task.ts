#!/usr/bin/env bun

import { $ } from "bun";
import * as path from "node:path";

const RUST_AFFECTING_FILE_NAMES = [
	"Cargo.toml",
	"Cargo.lock",
	"build.rs",
	"rust-toolchain",
	"rust-toolchain.toml",
	"clippy.toml",
	".clippy.toml",
	"rustfmt.toml",
	".rustfmt.toml",
] as const satisfies readonly string[];
const TASK_COMMANDS = {
	"check:rs": [
		["cargo", "fmt", "--all", "--", "--check"],
		["cargo", "clippy", "--workspace", "--", "-D", "warnings"],
	],
	"fix:rs": [
		["cargo", "fmt", "--all"],
		[
			"cargo",
			"clippy",
			"--workspace",
			"--fix",
			"--allow-dirty",
			"--no-deps",
			"--allow-staged",
			"--allow-no-vcs",
		],
	],
	"fmt:rs": [["cargo", "fmt", "--all"]],
	"lint:rs": [["cargo", "clippy", "--workspace", "--", "-D", "warnings"]],
	"test:rs": [["cargo", "nextest", "run", "--workspace", "--status-level=fail", "--final-status-level=fail"]],
} as const satisfies Record<string, readonly (readonly string[])[]>;

type RustTaskName = keyof typeof TASK_COMMANDS;

const repoRoot = path.join(import.meta.dir, "..");
const cargoBinary = await resolveCargoBinary();
const taskName = process.argv[2];

if (!isRustTaskName(taskName)) {
	console.error(`Unknown Rust task: ${taskName ?? "(missing)"}`);
	process.exit(1);
}

if (taskName === "check:rs") {
	const rustScopeExitCode = await runCommand(["bun", "scripts/check-rust-scope.ts"]);
	if (rustScopeExitCode !== 0) {
		process.exit(rustScopeExitCode);
	}
}

if (taskName !== "fmt:rs" && !(isCI() || (await hasRustAffectingChanges()))) {
	console.log(`Skipping ${taskName} (not in CI and no Rust-affecting changes were found).`);
	process.exit(0);
}

for (const command of TASK_COMMANDS[taskName]) {
	const exitCode = await runCommand(withPartition(taskName, withCiProfile(taskName, command)));
	if (exitCode !== 0) {
		process.exit(exitCode);
	}
}

// Main CI splits rust-test into nextest partitions. An optional `count:i/N`
// third argument shards the test set for `test:rs` by appending
// `--partition count:i/N` to the nextest invocation. Other tasks ignore it.
function withPartition(task: RustTaskName, command: readonly string[]): readonly string[] {
	const partition = process.argv[3]?.trim();
	if (task !== "test:rs" || !partition) {
		return command;
	}
	if (!/^count:\d+\/\d+$/.test(partition)) {
		console.error(`Invalid rust-test partition '${partition}'; expected count:<i>/<N>.`);
		process.exit(1);
	}
	if (command[1] !== "nextest") {
		return command;
	}
	return [...command, "--partition", partition];
}

function withCiProfile(task: RustTaskName, command: readonly string[]): readonly string[] {
	if (task !== "test:rs" || !isCI() || command[1] !== "nextest") {
		return command;
	}
	return [...command.filter(arg => arg !== "--status-level=fail" && arg !== "--final-status-level=fail"), "--profile", "ci"];
}

function isRustTaskName(value: string | undefined): value is RustTaskName {
	return value != null && value in TASK_COMMANDS;
}

function isCI(): boolean {
	const value = Bun.env.CI;
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	return normalized !== "" && normalized !== "0" && normalized !== "false";
}

async function hasRustAffectingChanges(): Promise<boolean> {
	const result = await $`git status --porcelain -z`.cwd(repoRoot).quiet().nothrow();
	if (result.exitCode !== 0) {
		const stderr = result.stderr.toString().trim();
		const suffix = stderr === "" ? `exit ${result.exitCode}` : stderr;
		console.warn(`Warning: failed to inspect git status: ${suffix}. Running ${taskName} conservatively.`);
		return true;
	}
	return getChangedPathsFromPorcelain(result.stdout).some(isRustAffectingPath);
}

function getChangedPathsFromPorcelain(buf: Uint8Array): string[] {
	const entries = new TextDecoder().decode(buf).split("\0").filter(Boolean);
	const changedPaths: string[] = [];

	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		if (entry.length < 4) continue;

		const status = entry.slice(0, 2);
		const changedPath = entry.slice(3);
		if (changedPath !== "") {
			changedPaths.push(changedPath);
		}

		if (status.includes("R") || status.includes("C")) {
			const renamedPath = entries[index + 1];
			if (renamedPath) {
				changedPaths.push(renamedPath);
				index += 1;
			}
		}
	}

	return changedPaths;
}

function isRustAffectingPath(changedPath: string): boolean {
	const normalized = changedPath.replace(/\\/g, "/");
	const fileName = normalized.slice(normalized.lastIndexOf("/") + 1);
	return (
		normalized.endsWith(".rs") ||
		normalized.startsWith(".cargo/") ||
		isOneOf(fileName, RUST_AFFECTING_FILE_NAMES)
	);
}

function isOneOf<T extends string>(value: string, values: readonly T[]): value is T {
	return values.some(entry => entry === value);
}

async function resolveCargoBinary(): Promise<string> {
	// On macOS runners, Homebrew's `rustup-init` binary is on PATH before the
	// rustup proxies in `$CARGO_HOME/bin`, and invoking it as `cargo` falls
	// through to its installer mode ("unexpected argument 'nextest' found").
	// Ask rustup directly for the cargo binary in the active toolchain.
	const result = await $`rustup which cargo`.cwd(repoRoot).quiet().nothrow();
	if (result.exitCode === 0) {
		const resolved = result.stdout.toString().trim();
		if (resolved !== "") return resolved;
	}
	return "cargo";
}

async function runCommand(command: readonly string[]): Promise<number> {
	const [head, ...rest] = command;
	const isCargo = head === "cargo";
	const argv = isCargo ? [cargoBinary, ...rest] : [head, ...rest];
	const env: Record<string, string> = { ...(process.env as Record<string, string>) };
	if (isCargo) {
		// Cargo subprocesses (notably `rustc -vV` from `cargo metadata`) resolve
		// via PATH; ensure the active toolchain bin dir wins over Homebrew's
		// rustup-init shadow on macOS runners.
		const toolchainBin = path.dirname(cargoBinary);
		const pathSep = process.platform === "win32" ? ";" : ":";
		const currentPath = env.PATH ?? env.Path ?? "";
		env.PATH = currentPath === "" ? toolchainBin : `${toolchainBin}${pathSep}${currentPath}`;
	}
	const proc = Bun.spawn(argv, {
		cwd: repoRoot,
		env,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	return proc.exited;
}
