import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { checkTmuxSelfInjection } from "../src/tools/tmux-self-injection-guard";

const env = {
	TMUX: `/tmp/tmux-${typeof process.getuid === "function" ? process.getuid() : 0}/default,12345,0`,
	TMUX_PANE: "%47",
	TMUX_TMPDIR: "/tmp",
	PWD: "/tmp",
};

function resolver(target: string): string | undefined {
	if (target === "demo" || target === "demo:19.0" || target === "self" || target === ".") return "%47";
	return "%99";
}

const options = {
	env,
	cwd: "/tmp",
	resolvePaneId: async ({ target }: { target: string }) => resolver(target),
};

describe("tmux self-injection guard", () => {
	it("blocks a direct current pane id", async () => {
		await expect(checkTmuxSelfInjection("tmux send-keys -t %47 x", options)).resolves.toMatchObject({ block: true });
	});

	it("blocks a session/window/pane target resolving to the current pane", async () => {
		await expect(checkTmuxSelfInjection("tmux paste-buffer -t demo:19.0", options)).resolves.toMatchObject({
			block: true,
		});
	});

	it("blocks the current-session alias after resolution", async () => {
		await expect(checkTmuxSelfInjection("tmux send-prefix -t .", options)).resolves.toMatchObject({ block: true });
	});

	it("blocks an unqualified input verb because tmux defaults to the current pane", async () => {
		await expect(checkTmuxSelfInjection("tmux send-keys x Enter", options)).resolves.toMatchObject({ block: true });
	});

	it("allows a foreign pane and preserves cross-session orchestration", async () => {
		await expect(checkTmuxSelfInjection("tmux send-keys -t other:0.0 x Enter", options)).resolves.toEqual({
			block: false,
		});
	});

	it("fails closed when a current-server target cannot be resolved", async () => {
		const unresolvedOptions = {
			...options,
			resolvePaneId: async () => undefined,
		};
		await expect(checkTmuxSelfInjection("tmux send-keys -t unknown x", unresolvedOptions)).resolves.toMatchObject({
			block: true,
		});
	});

	it("allows a different explicit socket", async () => {
		await expect(checkTmuxSelfInjection("tmux -S /tmp/other-tmux.sock send-keys -t %47 x", options)).resolves.toEqual(
			{ block: false },
		);
	});

	it("allows a different socket selected by an inline TMUX assignment", async () => {
		await expect(
			checkTmuxSelfInjection("TMUX=/tmp/other-tmux.sock tmux send-keys -t demo x", options),
		).resolves.toEqual({
			block: false,
		});
	});

	it("allows a different socket selected by an inline TMUX_TMPDIR assignment", async () => {
		await expect(
			checkTmuxSelfInjection("TMUX_TMPDIR=/tmp/other-tmux-dir tmux -L default send-keys -t %47 x", options),
		).resolves.toEqual({ block: false });
	});

	it("uses env's effective socket environment when resolving named targets", async () => {
		for (const [command, expectedTmpdir] of [
			["env -u TMUX_TMPDIR tmux -L default send-keys -t self x", undefined],
			["env -i tmux -L default send-keys -t demo x", undefined],
			["env TMUX_TMPDIR=/tmp tmux -L default send-keys -t demo x", "/tmp"],
		] as const) {
			let resolvedTmpdir: string | undefined;
			const localOptions = {
				...options,
				env: { ...env, TMUX_TMPDIR: "/tmp/foreign" },
				resolvePaneId: async ({ target, env: resolverEnv }: { target: string; env: Record<string, string> }) => {
					resolvedTmpdir = resolverEnv.TMUX_TMPDIR;
					return resolver(target);
				},
			};
			await expect(checkTmuxSelfInjection(command, localOptions)).resolves.toMatchObject({ block: true });
			expect(resolvedTmpdir).toBe(expectedTmpdir);
		}
	});

	it("fails closed when shell expansion makes socket selection unknown", async () => {
		const socketDir = env.TMUX.split(",")[0].substring(0, env.TMUX.split(",")[0].lastIndexOf("/"));
		for (const command of [
			`env -C "$(printf '%s' '${socketDir}')" tmux -S default send-keys -t %47 x`,
			`TMUX_TMPDIR="$(printf '%s' /tmp/other)" tmux -L default send-keys -t %47 x`,
			`tmux -S "$TMUX_SOCKET" send-keys -t %47 x`,
		]) {
			await expect(checkTmuxSelfInjection(command, options)).resolves.toMatchObject({ block: true });
		}
	});

	it("blocks the current server selected with -L", async () => {
		await expect(checkTmuxSelfInjection("tmux -L default send-keys -t %47 x", options)).resolves.toMatchObject({
			block: true,
		});
	});

	it("blocks the current server selected with an explicit -S path", async () => {
		await expect(
			checkTmuxSelfInjection(`tmux -S ${env.TMUX.split(",")[0]} send-keys -t %47 x`, options),
		).resolves.toMatchObject({
			block: true,
		});
	});

	describe("tmux global option parsing", () => {
		it("finds input verbs after global options with operands", async () => {
			for (const command of ["tmux -f /dev/null send-keys -t %47 x", "tmux -T 256 send-keys -t %47 x"]) {
				await expect(checkTmuxSelfInjection(command, options)).resolves.toMatchObject({ block: true });
			}
		});

		it("finds input verbs after attached and bundled global options", async () => {
			for (const command of ["tmux -f/dev/null send-keys -t %47 x", "tmux -2f /dev/null send-keys -t %47 x"]) {
				await expect(checkTmuxSelfInjection(command, options)).resolves.toMatchObject({ block: true });
			}
		});

		it("inspects shell commands passed through tmux -c", async () => {
			await expect(checkTmuxSelfInjection("tmux -c 'tmux send-keys -t %47 x'", options)).resolves.toMatchObject({
				block: true,
			});
		});

		it("uses only the final tmux -c payload", async () => {
			await expect(checkTmuxSelfInjection("tmux -c 'tmux send-keys -t %47 x' -c ':'", options)).resolves.toEqual({
				block: false,
			});
			await expect(
				checkTmuxSelfInjection("tmux -c ':' -c 'tmux send-keys -t %47 x'", options),
			).resolves.toMatchObject({ block: true });
		});

		it("allows tmux help and version modes", async () => {
			for (const option of ["-h", "-V"]) {
				await expect(checkTmuxSelfInjection(`tmux ${option} send-keys -t %47 x`, options)).resolves.toEqual({
					block: false,
				});
			}
		});

		it("allows read-only commands after a configuration-file option", async () => {
			await expect(checkTmuxSelfInjection("tmux -f /dev/null list-panes -t demo", options)).resolves.toEqual({
				block: false,
			});
		});
	});

	it("finds injection hidden behind a shell wrapper", async () => {
		await expect(checkTmuxSelfInjection("sh -c 'tmux send-keys -t %47 x'", options)).resolves.toMatchObject({
			block: true,
		});
	});

	it("inspects executable command substitutions in ordinary shell words", async () => {
		for (const command of [
			'tmux send-keys -t %99 "$(tmux send-keys -t %47 x)"',
			"tmux send-keys -t %99 $(tmux send-keys -t %47 x)",
			'tmux send-keys -t %99 "`tmux send-keys -t %47 x`"',
		]) {
			await expect(checkTmuxSelfInjection(command, options)).resolves.toMatchObject({ block: true });
		}
		for (const command of [
			"tmux send-keys -t %99 '$(tmux send-keys -t %47 x)'",
			'tmux send-keys -t %99 "\\$(tmux send-keys -t %47 x)"',
		]) {
			await expect(checkTmuxSelfInjection(command, options)).resolves.toEqual({ block: false });
		}
	});

	it("skips here-document bodies when matching command-substitution ends", async () => {
		await expect(checkTmuxSelfInjection("echo \"$(cat <<'EOF'\n)\nEOF\n)\"", options)).resolves.toEqual({
			block: false,
		});
		await expect(
			checkTmuxSelfInjection("echo \"$(cat <<'EOF'\n)\nEOF\ntmux send-keys -t %47 x\n)\"", options),
		).resolves.toMatchObject({ block: true });
	});

	it("decodes ANSI-C-quoted Bash command strings", async () => {
		for (const command of [
			"bash -c $'tmux send-keys -t %47 x'",
			"bash -c $'\\x74mux send-keys -t %47 x'",
			"bash -c $'\\164mux send-keys -t %47 x'",
		]) {
			await expect(checkTmuxSelfInjection(command, options)).resolves.toMatchObject({ block: true });
		}
		await expect(checkTmuxSelfInjection("printf $'tmux send-keys -t %47 x'", options)).resolves.toEqual({
			block: false,
		});
	});

	it("finds injection through path-qualified shell runners", async () => {
		for (const command of [
			"/bin/bash -c 'tmux send-keys -t %47 x'",
			"/usr/bin/busybox sh -c 'tmux send-keys -t %47 x'",
			"busybox ash -c 'tmux send-keys -t %47 x'",
			"busybox hush -c 'tmux send-keys -t %47 x'",
		]) {
			await expect(checkTmuxSelfInjection(command, options)).resolves.toMatchObject({ block: true });
		}
	});

	it("finds injection in a shell script passed to bash by name or path", async () => {
		const scriptPath = "/tmp/gjc-5039-injection.sh";
		await Bun.write(scriptPath, "tmux send-keys -t %47 x\n");
		try {
			for (const runner of ["bash", "/bin/bash"]) {
				await expect(checkTmuxSelfInjection(`${runner} ${scriptPath}`, options)).resolves.toMatchObject({
					block: true,
				});
			}
		} finally {
			await Bun.file(scriptPath).delete();
		}
	});

	it("inspects relative and PATH-resolved shell-runner scripts", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-tmux-shell-runner-path-"));
		const subdirectory = path.join(cwd, "sub");
		const fakeBin = path.join(cwd, "fake-bin");
		await Promise.all([fs.mkdir(subdirectory), fs.mkdir(fakeBin)]);
		await Bun.write(path.join(subdirectory, "bash"), "#!/bin/sh\ntmux send-keys -t %47 x\n");
		await Bun.write(path.join(fakeBin, "bash"), "#!/bin/sh\ntmux send-keys -t %47 x\n");
		await Promise.all([
			fs.chmod(path.join(subdirectory, "bash"), 0o755),
			fs.chmod(path.join(fakeBin, "bash"), 0o755),
		]);
		const localOptions = { ...options, cwd, env: { ...env, FAKE_BIN: fakeBin, PATH: process.env.PATH ?? "" } };
		const pathOptions = { ...localOptions, env: { ...localOptions.env, PATH: fakeBin } };
		try {
			for (const command of [
				`sub/bash`,
				`PATH=${fakeBin} bash`,
				'PATH="$FAKE_BIN" bash',
				`env PATH=${fakeBin} bash`,
				'env PATH="$FAKE_BIN" bash',
			]) {
				await expect(checkTmuxSelfInjection(command, localOptions)).resolves.toMatchObject({ block: true });
			}
			await expect(checkTmuxSelfInjection("bash", pathOptions)).resolves.toMatchObject({ block: true });
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("uses an explicit execution PATH when resolving shell-runner scripts", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-tmux-shell-runner-execution-path-"));
		const fakeBin = path.join(cwd, "fake-bin");
		await fs.mkdir(fakeBin);
		await Bun.write(path.join(fakeBin, "bash"), "#!/bin/sh\ntmux send-keys -t %47 x\n");
		await fs.chmod(path.join(fakeBin, "bash"), 0o755);
		try {
			await expect(
				checkTmuxSelfInjection("bash", { ...options, cwd, executionEnv: { PATH: fakeBin } }),
			).resolves.toMatchObject({ block: true });
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("fails closed when a shell runner PATH override cannot be resolved", async () => {
		for (const command of ['PATH="$UNKNOWN_BIN" bash', 'env PATH="$UNKNOWN_BIN" bash']) {
			await expect(checkTmuxSelfInjection(command, options)).resolves.toMatchObject({
				block: true,
				reason: expect.stringContaining("PATH override contains an unresolved shell expansion"),
			});
		}
	});

	it("finds injection in a command chain", async () => {
		await expect(checkTmuxSelfInjection("printf safe; tmux send-keys -t %47 x", options)).resolves.toMatchObject({
			block: true,
		});
	});

	it("does not treat read-only inspection as injection", async () => {
		await expect(checkTmuxSelfInjection("tmux list-panes -t demo", options)).resolves.toEqual({ block: false });
	});

	// Tests for wrapper commands (issue #6563)
	describe("wrapper commands", () => {
		it("should block env wrapper with option taking argument", async () => {
			await expect(checkTmuxSelfInjection("env -u FOO tmux send-keys -t %47 x", options)).resolves.toMatchObject({
				block: true,
			});
		});

		it("should block env when an argv0 option precedes the command", async () => {
			for (const command of [
				"env -a disguise tmux send-keys -t %47 x",
				"env --argv0 disguise tmux send-keys -t %47 x",
			]) {
				await expect(checkTmuxSelfInjection(command, options)).resolves.toMatchObject({ block: true });
			}
		});

		it("blocks a relative explicit socket after env changes the command directory", async () => {
			const socketDir = env.TMUX.split(",")[0];
			const tempDir = socketDir.substring(0, socketDir.lastIndexOf("/"));
			await expect(
				checkTmuxSelfInjection(`env -C ${tempDir} tmux -S default send-keys -t %47 x`, options),
			).resolves.toMatchObject({ block: true });
		});

		it("uses env chdir options after earlier command segments", async () => {
			const socketPath = env.TMUX.split(",")[0];
			const socketDir = socketPath.substring(0, socketPath.lastIndexOf("/"));
			await expect(
				checkTmuxSelfInjection(`true; env -C ${socketDir} tmux -S default send-keys -t %47 x`, options),
			).resolves.toMatchObject({ block: true });
		});

		it("finds env chdir options after argv0 operands", async () => {
			const socketPath = env.TMUX.split(",")[0];
			const socketDir = socketPath.substring(0, socketPath.lastIndexOf("/"));
			for (const command of [
				`env -a disguise -C ${socketDir} tmux -S default send-keys -t %47 x`,
				`env --argv0 disguise --chdir=${socketDir} tmux -S default send-keys -t %47 x`,
			]) {
				await expect(checkTmuxSelfInjection(command, options)).resolves.toMatchObject({ block: true });
			}
		});

		it("resolves shell scripts after env changes the working directory", async () => {
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-tmux-env-script-cwd-"));
			const originalCwd = path.join(tempDir, "original");
			const targetCwd = path.join(tempDir, "target");
			await fs.mkdir(originalCwd);
			await fs.mkdir(targetCwd);
			await Bun.write(path.join(targetCwd, "payload.sh"), "tmux send-keys -t %47 x\n");
			await Bun.write(path.join(targetCwd, "bash"), "tmux send-keys -t %47 x\n");
			await fs.chmod(path.join(targetCwd, "bash"), 0o755);
			const localOptions = {
				...options,
				cwd: originalCwd,
				env: { ...env, TMUX_TARGET: targetCwd, PWD: originalCwd },
			};
			try {
				await expect(
					checkTmuxSelfInjection(`env -C ${targetCwd} bash payload.sh`, localOptions),
				).resolves.toMatchObject({ block: true });
				await expect(
					checkTmuxSelfInjection('env -C "$TMUX_TARGET" bash payload.sh', localOptions),
				).resolves.toMatchObject({ block: true });
				await expect(checkTmuxSelfInjection(`env -C ${targetCwd} ./bash`, localOptions)).resolves.toMatchObject({
					block: true,
				});
			} finally {
				await fs.rm(tempDir, { recursive: true, force: true });
			}
		});

		it("resolves env chdir paths from known environment values", async () => {
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-tmux-env-known-cwd-"));
			const originalCwd = path.join(tempDir, "original");
			const targetCwd = path.join(tempDir, "target");
			await Promise.all([fs.mkdir(originalCwd), fs.mkdir(targetCwd)]);
			await Bun.write(path.join(targetCwd, "safe.sh"), "printf safe\n");
			const localOptions = {
				...options,
				cwd: originalCwd,
				env: { ...env, TMUX_TARGET: targetCwd, PWD: originalCwd },
			};
			try {
				await expect(checkTmuxSelfInjection('env -C "$TMUX_TARGET" bash safe.sh', localOptions)).resolves.toEqual({
					block: false,
				});
				await expect(
					checkTmuxSelfInjection('env -C "$UNKNOWN_TARGET" bash safe.sh', localOptions),
				).resolves.toMatchObject({ block: true });
			} finally {
				await fs.rm(tempDir, { recursive: true, force: true });
			}
		});

		it("expands env chdir paths from the effective execution environment", async () => {
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-tmux-env-execution-cwd-"));
			const originalCwd = path.join(tempDir, "original");
			const foreignCwd = path.join(tempDir, "foreign");
			const currentCwd = path.join(tempDir, "current");
			await Promise.all([fs.mkdir(originalCwd), fs.mkdir(foreignCwd), fs.mkdir(currentCwd)]);
			const localOptions = {
				...options,
				cwd: originalCwd,
				env: { ...env, TMUX: `${path.join(currentCwd, "tmux.sock")},12345,0`, TARGET: foreignCwd },
				executionEnv: {
					...env,
					TMUX: `${path.join(foreignCwd, "tmux.sock")},12345,0`,
					TMUX_PANE: "%99",
					TARGET: currentCwd,
				},
			};
			try {
				await expect(
					checkTmuxSelfInjection("env -C $TARGET tmux -S tmux.sock send-keys -t %47 x", localOptions),
				).resolves.toMatchObject({ block: true });
			} finally {
				await fs.rm(tempDir, { recursive: true, force: true });
			}
		});

		it("propagates env working directories into nested shell payloads", async () => {
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-tmux-nested-env-cwd-"));
			const originalCwd = path.join(tempDir, "original");
			const targetCwd = path.join(tempDir, "target");
			await fs.mkdir(originalCwd);
			await fs.mkdir(targetCwd);
			const localOptions = {
				...options,
				cwd: originalCwd,
				env: {
					...env,
					TMUX: `${path.join(targetCwd, "tmux.sock")},12345,0`,
					TMUX_TARGET: targetCwd,
					PWD: originalCwd,
				},
			};
			try {
				for (const command of [
					`env -C ${targetCwd} bash -c 'tmux -S tmux.sock send-keys -t %47 x'`,
					`env -C "$TMUX_TARGET" bash -c 'tmux -S tmux.sock send-keys -t %47 x'`,
					`env -C ${targetCwd} env -S 'tmux -S tmux.sock send-keys -t %47 x'`,
					`env -C "$TMUX_TARGET" env -S 'tmux -S tmux.sock send-keys -t %47 x'`,
					`env --ch ${targetCwd} tmux -S tmux.sock send-keys -t %47 x`,
					`env --ch=${targetCwd} env -S 'tmux -S tmux.sock send-keys -t %47 x'`,
				]) {
					await expect(checkTmuxSelfInjection(command, localOptions)).resolves.toMatchObject({ block: true });
				}
			} finally {
				await fs.rm(tempDir, { recursive: true, force: true });
			}
		});

		it("should block sudo wrapper with option taking argument", async () => {
			await expect(checkTmuxSelfInjection("sudo -u root tmux send-keys -t %47 x", options)).resolves.toMatchObject({
				block: true,
			});
		});

		it("should block sudo with -E flag", async () => {
			await expect(checkTmuxSelfInjection("sudo -E tmux send-keys -t %47 x", options)).resolves.toMatchObject({
				block: true,
			});
		});

		it("should block timeout wrapper", async () => {
			await expect(checkTmuxSelfInjection("timeout 5 tmux send-keys -t %47 x", options)).resolves.toMatchObject({
				block: true,
			});
		});

		it("should block nice wrapper", async () => {
			await expect(checkTmuxSelfInjection("nice tmux send-keys -t %47 x", options)).resolves.toMatchObject({
				block: true,
			});
		});

		it("should block nice wrapper with -n option", async () => {
			await expect(checkTmuxSelfInjection("nice -n 10 tmux send-keys -t %47 x", options)).resolves.toMatchObject({
				block: true,
			});
		});

		it("should block GNU time with short and long format operands", async () => {
			for (const command of [
				"/usr/bin/time -f '%E' tmux send-keys -t %47 x",
				"/usr/bin/time --format '%E' tmux send-keys -t %47 x",
			]) {
				await expect(checkTmuxSelfInjection(command, options)).resolves.toMatchObject({ block: true });
			}
		});

		it("allows nice and time help/version modes", async () => {
			for (const command of [
				"nice --help tmux send-keys -t %47 x",
				"nice --version tmux send-keys -t %47 x",
				"timeout --help tmux send-keys -t %47 x",
				"timeout --version tmux send-keys -t %47 x",
				"time --help tmux send-keys -t %47 x",
				"time --version tmux send-keys -t %47 x",
			]) {
				await expect(checkTmuxSelfInjection(command, options)).resolves.toEqual({ block: false });
			}
		});

		it("should block xargs wrapper", async () => {
			await expect(checkTmuxSelfInjection("xargs tmux send-keys -t %47 <<< x", options)).resolves.toMatchObject({
				block: true,
			});
		});

		it("should block stdbuf wrapper", async () => {
			await expect(checkTmuxSelfInjection("stdbuf -o line tmux send-keys -t %47 x", options)).resolves.toMatchObject(
				{
					block: true,
				},
			);
		});

		it("should block setsid wrapper", async () => {
			await expect(checkTmuxSelfInjection("setsid tmux send-keys -t %47 x", options)).resolves.toMatchObject({
				block: true,
			});
		});

		it("allows informational modes of command wrappers", async () => {
			for (const command of [
				"nohup --help tmux send-keys -t %47 x",
				"nohup --version tmux send-keys -t %47 x",
				"nohup --ver tmux send-keys -t %47 x",
				"setsid --help tmux send-keys -t %47 x",
				"setsid --ver tmux send-keys -t %47 x",
				"setsid -h tmux send-keys -t %47 x",
				"setsid -V tmux send-keys -t %47 x",
				"nice --ver tmux send-keys -t %47 x",
				"xargs --version tmux send-keys -t %47 x",
				"stdbuf --help tmux send-keys -t %47 x",
				"stdbuf --ver tmux send-keys -t %47 x",
				"sudo -K tmux send-keys -t %47 x",
				"sudo --remove-timestamp tmux send-keys -t %47 x",
			]) {
				await expect(checkTmuxSelfInjection(command, options)).resolves.toEqual({ block: false });
			}
		});

		it("should block path-qualified env wrapper", async () => {
			// Issue: /usr/bin/env FOO=x tmux send-keys -t %47 x
			// Path-qualified wrapper should be recognized and checked
			await expect(
				checkTmuxSelfInjection("/usr/bin/env FOO=x tmux send-keys -t %47 x", options),
			).resolves.toMatchObject({
				block: true,
			});
		});
	});

	// Tests for bundled shell options (issue #6563)
	describe("bundled shell options", () => {
		it("should block bash with bundled -ce option", async () => {
			await expect(checkTmuxSelfInjection("bash -ce 'tmux send-keys -t %47 x'", options)).resolves.toMatchObject({
				block: true,
			});
		});

		it("should block bash with bundled -ec option", async () => {
			await expect(checkTmuxSelfInjection("bash -ec 'tmux send-keys -t %47 x'", options)).resolves.toMatchObject({
				block: true,
			});
		});

		it("should block bash with separate -c and -e options", async () => {
			await expect(checkTmuxSelfInjection("bash -c -e 'tmux send-keys -t %47 x'", options)).resolves.toMatchObject({
				block: true,
			});
		});
	});

	// Tests for command -v lookups (issue #6563)
	describe("command -v lookups", () => {
		it("should allow command -v lookup", async () => {
			await expect(checkTmuxSelfInjection("command -v tmux send-keys", options)).resolves.toEqual({
				block: false,
			});
		});

		it("should allow command -V lookup", async () => {
			await expect(checkTmuxSelfInjection("command -V tmux send-keys", options)).resolves.toEqual({
				block: false,
			});
		});

		it("allows bundled command lookup flags", async () => {
			await expect(checkTmuxSelfInjection("command -pv tmux send-keys", options)).resolves.toEqual({
				block: false,
			});
		});

		it("allows multiple lookup operands even when an earlier operand is a wrapper", async () => {
			await expect(checkTmuxSelfInjection("command -v env tmux send-keys -t %47 x", options)).resolves.toEqual({
				block: false,
			});
		});

		it("only recognizes lookup options before command's command operand", async () => {
			await expect(checkTmuxSelfInjection("command env -v tmux send-keys -t %47 x", options)).resolves.toMatchObject(
				{ block: true },
			);
		});
	});

	// Tests for must-stay-allowed cases (issue #6563)
	describe("must-stay-allowed cases", () => {
		it("should allow env -u tmux where tmux is the unset variable", async () => {
			await expect(checkTmuxSelfInjection("env -u tmux send-keys -t %47 x", options)).resolves.toEqual({
				block: false,
			});
		});

		it("allows env --unset tmux where tmux is the unset variable", async () => {
			await expect(checkTmuxSelfInjection("env --unset tmux send-keys -t %47 x", options)).resolves.toEqual({
				block: false,
			});
		});

		it("consumes the BSD env search-path operand", async () => {
			await expect(checkTmuxSelfInjection('env -P "$PATH" tmux send-keys -t %47 x', options)).resolves.toMatchObject(
				{
					block: true,
				},
			);
		});

		it("preserves quoted wrapper-option operands", async () => {
			for (const [command, block] of [
				["env '-u' tmux send-keys -t %47 x", false],
				["env '-u' FOO tmux send-keys -t %47 x", true],
				["sudo '-u' tmux send-keys -t %47 x", false],
				["sudo '-u' root tmux send-keys -t %47 x", true],
			] as const) {
				await expect(checkTmuxSelfInjection(command, options)).resolves.toMatchObject({ block });
			}
		});

		it("should allow sudo -u tmux where tmux is a user name", async () => {
			await expect(checkTmuxSelfInjection("sudo -u tmux send-keys -t %47 x", options)).resolves.toEqual({
				block: false,
			});
		});

		it("allows sudo listing, validation, and version modes without treating arguments as commands", async () => {
			for (const option of ["-l", "--list", "-v", "--validate", "-V", "--version"]) {
				await expect(checkTmuxSelfInjection(`sudo ${option} tmux send-keys -t %47 x`, options)).resolves.toEqual({
					block: false,
				});
			}
		});

		it("allows sudo list mode with an end-of-options marker", async () => {
			await expect(checkTmuxSelfInjection("sudo -l -- tmux send-keys -t %47 x", options)).resolves.toEqual({
				block: false,
			});
		});

		it("allows sudo edit mode without treating file operands as commands", async () => {
			for (const option of ["-e", "--edit"]) {
				await expect(checkTmuxSelfInjection(`sudo ${option} -- tmux send-keys -t %47 x`, options)).resolves.toEqual(
					{
						block: false,
					},
				);
			}
		});

		it("allows builtin with an external executable name", async () => {
			await expect(checkTmuxSelfInjection("builtin tmux send-keys -t %47 x", options)).resolves.toEqual({
				block: false,
			});
		});

		it("blocks an external command dispatched through the builtin command wrapper", async () => {
			await expect(
				checkTmuxSelfInjection("builtin command tmux send-keys -t %47 x", options),
			).resolves.toMatchObject({
				block: true,
			});
		});

		it("does not discover commands after invalid shell builtin options", async () => {
			for (const command of [
				"builtin -x tmux send-keys -t %47 x",
				"builtin --not-a-builtin-option tmux send-keys -t %47 x",
				"command --help tmux send-keys -t %47 x",
				"exec -x tmux send-keys -t %47 x",
				"eval -x tmux send-keys -t %47 x",
			]) {
				await expect(checkTmuxSelfInjection(command, options)).resolves.toEqual({ block: false });
			}
			await expect(
				checkTmuxSelfInjection("command --help tmux send-keys -t %47 x; tmux send-keys -t %47 x", options),
			).resolves.toMatchObject({ block: true });
		});

		it("should allow bash script with -ce after operand", async () => {
			const scriptPath = "/tmp/gjc-6563-safe.sh";
			await Bun.write(scriptPath, "echo safe\n");
			try {
				await expect(
					checkTmuxSelfInjection(`bash ${scriptPath} -ce 'tmux send-keys -t %47 x'`, options),
				).resolves.toEqual({
					block: false,
				});
			} finally {
				await Bun.file(scriptPath).delete();
			}
		});

		it("should allow quoted text sent to different pane", async () => {
			await expect(
				checkTmuxSelfInjection("tmux send-keys -t %99 \"echo '; tmux send-keys -t %47'\"", options),
			).resolves.toEqual({
				block: false,
			});
		});
	});

	// Regression tests for fix-pr-6564 blocking issues
	describe("regression: lookup suppression boundary (issue #6564-1)", () => {
		it("should block tmux after command -v sh with separator", async () => {
			// Issue: lookup suppression survived simple-command boundary
			// In `command -v sh; tmux send-keys -t %47 x`, the earlier `-v` should not suppress the tmux check
			await expect(checkTmuxSelfInjection("command -v sh; tmux send-keys -t %47 x", options)).resolves.toMatchObject(
				{
					block: true,
				},
			);
		});

		it("should block tmux after command -v sh with pipeline", async () => {
			// Pipeline is also a separator
			await expect(
				checkTmuxSelfInjection("command -v sh | tmux send-keys -t %47 x", options),
			).resolves.toMatchObject({
				block: true,
			});
		});
	});

	describe("regression: env assignments with wrappers (issue #6564-2)", () => {
		it("should block tmux after env assignment", async () => {
			// Issue: env FOO=bar tmux send-keys -t %47 x treated FOO=bar as wrapped command
			await expect(checkTmuxSelfInjection("env FOO=bar tmux send-keys -t %47 x", options)).resolves.toMatchObject({
				block: true,
			});
		});

		it("should block tmux after nested env assignments", async () => {
			// Nested wrapper: env sudo -E tmux ...
			await expect(
				checkTmuxSelfInjection("env MYVAR=x sudo -E tmux send-keys -t %47 x", options),
			).resolves.toMatchObject({
				block: true,
			});
		});
	});

	describe("regression: flag-only options (issue #6564-3)", () => {
		it("should block tmux after setsid -w (flag-only, not argument-taking)", async () => {
			// Issue: setsid -w tmux send-keys -t %47 x treated tmux as argument to -w
			await expect(checkTmuxSelfInjection("setsid -w tmux send-keys -t %47 x", options)).resolves.toMatchObject({
				block: true,
			});
		});

		it("should block tmux after setsid -c (flag-only, not argument-taking)", async () => {
			await expect(checkTmuxSelfInjection("setsid -c tmux send-keys -t %47 x", options)).resolves.toMatchObject({
				block: true,
			});
		});

		it("should block tmux after sudo -s (flag-only, not argument-taking)", async () => {
			// sudo -s starts a login shell and shouldn't consume the next arg
			await expect(checkTmuxSelfInjection("sudo -s tmux send-keys -t %47 x", options)).resolves.toMatchObject({
				block: true,
			});
		});

		it("should block tmux after sudo -i (flag-only, not argument-taking)", async () => {
			// sudo -i starts a login shell and shouldn't consume the next arg
			await expect(checkTmuxSelfInjection("sudo -i tmux send-keys -t %47 x", options)).resolves.toMatchObject({
				block: true,
			});
		});

		it("should block tmux after xargs with flag-only options", async () => {
			// xargs -0, -t, -x are flag-only options that don't consume the next argument
			// In 'xargs -t tmux send-keys -t %47 x', tmux is executed as a command with arguments
			await expect(checkTmuxSelfInjection("xargs -t tmux send-keys -t %47 x", options)).resolves.toMatchObject({
				block: true, // tmux IS executed, targeting the current pane
			});
		});
	});

	describe("regression: shell option operands (issue #6564-4)", () => {
		it("should block bash -O extglob -c with injection", async () => {
			// Issue: bash -O extglob -c 'tmux send-keys -t %47 x' stopped at extglob, never checked payload
			await expect(
				checkTmuxSelfInjection("bash -O extglob -c 'tmux send-keys -t %47 x'", options),
			).resolves.toMatchObject({
				block: true,
			});
		});

		it("should block bash -o with option name and -c with injection", async () => {
			await expect(
				checkTmuxSelfInjection("bash -o pipefail -c 'tmux send-keys -t %47 x'", options),
			).resolves.toMatchObject({
				block: true,
			});
		});

		it("should block bash with multiple shell options", async () => {
			await expect(
				checkTmuxSelfInjection("bash -O extglob -o pipefail -c 'tmux send-keys -t %47 x'", options),
			).resolves.toMatchObject({
				block: true,
			});
		});

		it("finds command payloads after mixed option bundles containing -O or -o", async () => {
			for (const command of [
				"bash -eO extglob -c 'tmux send-keys -t %47 x'",
				"bash -eo pipefail -c 'tmux send-keys -t %47 x'",
			]) {
				await expect(checkTmuxSelfInjection(command, options)).resolves.toMatchObject({ block: true });
			}
		});

		it("should block bash with bundled -Oc option", async () => {
			// Issue: bash -Oc extglob 'tmux send-keys -t %47 x'
			// -Oc means -O c (shopt option 'c') and -c (command) bundled
			// extglob is the operand for -O, and the quoted string is the command
			await expect(
				checkTmuxSelfInjection("bash -Oc extglob 'tmux send-keys -t %47 x'", options),
			).resolves.toMatchObject({
				block: true,
			});
		});

		it("should block bash with bundled -oc option", async () => {
			await expect(
				checkTmuxSelfInjection("bash -oc nounset 'tmux send-keys -t %47 x'", options),
			).resolves.toMatchObject({ block: true });
		});
	});

	// Regression tests for remaining blocking issues
	describe("regression: busybox applet handling (issue #6564-5)", () => {
		it("should block tmux in busybox shell with -c", async () => {
			// Issue: busybox sh -c 'tmux send-keys -t %47 x' didn't reach payload checking
			// because sh was treated as script filename, not as a shell applet
			await expect(
				checkTmuxSelfInjection("busybox sh -c 'tmux send-keys -t %47 x'", options),
			).resolves.toMatchObject({
				block: true,
			});
		});

		it("should block tmux in busybox dash with -c", async () => {
			await expect(
				checkTmuxSelfInjection("busybox dash -c 'tmux send-keys -t %47 x'", options),
			).resolves.toMatchObject({
				block: true,
			});
		});
	});

	describe("regression: wrapper option arities (issue #6564-4b)", () => {
		it("should block timeout with flag-only -v option", async () => {
			// Issue: timeout -v is flag-only but was treated as taking an argument
			// In 'timeout -v 5 tmux send-keys', -v shouldn't consume 5
			await expect(checkTmuxSelfInjection("timeout -v 5 tmux send-keys -t %47 x", options)).resolves.toMatchObject({
				block: true,
			});
		});

		it("stops timeout option parsing after its duration", async () => {
			for (const command of [
				"timeout 1 -v tmux send-keys -t %47 x",
				"timeout --signal TERM 5 -v tmux send-keys -t %47 x",
			]) {
				await expect(checkTmuxSelfInjection(command, options)).resolves.toEqual({ block: false });
			}
			for (const command of [
				"timeout 1 env tmux send-keys -t %47 x",
				"timeout --signal TERM 5 env tmux send-keys -t %47 x",
			]) {
				await expect(checkTmuxSelfInjection(command, options)).resolves.toMatchObject({ block: true });
			}
		});
	});

	describe("regression: negative numbers in options (issue #6564-3b)", () => {
		it("should block tmux after nice -n -5 with negative adjustment", async () => {
			// Issue: nice -n -5 tmux should block because -5 is the adjustment value, not an option
			// The -n option takes an argument, and -5 is a negative number (the argument)
			await expect(checkTmuxSelfInjection("nice -n -5 tmux send-keys -t %47 x", options)).resolves.toMatchObject({
				block: true,
			});
		});
	});

	describe("regression: long-option arities for timeout/nice/stdbuf (issue #6564-3)", () => {
		it("should block tmux after timeout with --signal long option", async () => {
			// Issue: timeout --signal TERM 5 tmux send-keys
			// --signal takes TERM as argument, 5 is the duration, tmux should be checked
			await expect(
				checkTmuxSelfInjection("timeout --signal TERM 5 tmux send-keys -t %47 x", options),
			).resolves.toMatchObject({
				block: true,
			});
		});

		it("should block tmux after timeout with --signal=SIGNAL format", async () => {
			// Issue: timeout --signal=TERM 5 tmux send-keys
			await expect(
				checkTmuxSelfInjection("timeout --signal=TERM 5 tmux send-keys -t %47 x", options),
			).resolves.toMatchObject({
				block: true,
			});
		});

		it("should block tmux after nice with --adjustment long option", async () => {
			// Issue: nice --adjustment 5 tmux ...
			// --adjustment takes 5 as argument, tmux should be checked
			await expect(
				checkTmuxSelfInjection("nice --adjustment 5 tmux send-keys -t %47 x", options),
			).resolves.toMatchObject({
				block: true,
			});
		});

		it("should block tmux after stdbuf with --output long option", async () => {
			// Issue: stdbuf --output L tmux ...
			// --output takes L as argument, tmux should be checked
			await expect(
				checkTmuxSelfInjection("stdbuf --output L tmux send-keys -t %47 x", options),
			).resolves.toMatchObject({
				block: true,
			});
		});

		it("should block tmux after stdbuf with --output=MODE format", async () => {
			await expect(
				checkTmuxSelfInjection("stdbuf --output=L tmux send-keys -t %47 x", options),
			).resolves.toMatchObject({
				block: true,
			});
		});
	});

	describe("regression: socket override through wrapper assignments (issue #6564-6)", () => {
		it("should allow TMUX assignment before wrapper to override socket", async () => {
			// Issue: TMUX=/tmp/other env FOO=x tmux send-keys -t %47 x
			// Should NOT block because TMUX=/tmp/other points to a different socket
			await expect(
				checkTmuxSelfInjection("TMUX=/tmp/other env FOO=x tmux send-keys -t %47 x", options),
			).resolves.toEqual({
				block: false,
			});
		});

		it("should allow TMUX assignment before nested wrappers", async () => {
			await expect(
				checkTmuxSelfInjection("TMUX=/tmp/other env sudo -E tmux send-keys -t %47 x", options),
			).resolves.toEqual({
				block: false,
			});
		});
	});

	// Regression tests for command -v lookup boundary (issue #6564-1)
	describe("regression: command -v lookup boundary (issue #6564-1)", () => {
		it("should block tmux after empty lookup with semicolon", async () => {
			// Issue: `command -v; tmux send-keys -t %47 x`
			// The lookup has no operand (empty), so tmux is a new command after separator
			// The tmux command should be checked for injection, not suppressed
			await expect(checkTmuxSelfInjection("command -v; tmux send-keys -t %47 x", options)).resolves.toMatchObject({
				block: true,
			});
		});

		it("should block tmux after empty lookup with pipe", async () => {
			// Issue: `command -v | tmux send-keys -t %47 x`
			// Similar to semicolon - the lookup has no operand, so tmux is a separate command
			await expect(checkTmuxSelfInjection("command -v | tmux send-keys -t %47 x", options)).resolves.toMatchObject({
				block: true,
			});
		});

		it("should block tmux after assignment-shaped lookup operand", async () => {
			// Issue: `command -v FOO=bar; tmux send-keys -t %47 x`
			// FOO=bar looks like an assignment but is the operand of command -v
			// After the separator, tmux is a new command and should be checked
			await expect(
				checkTmuxSelfInjection("command -v FOO=bar; tmux send-keys -t %47 x", options),
			).resolves.toMatchObject({
				block: true,
			});
		});

		it("should suppress tmux when it's the actual operand of command -v", async () => {
			// Issue: `command -v tmux` where tmux is an actual command lookup operand
			// This should still be suppressed because tmux is not executed
			await expect(checkTmuxSelfInjection("command -v tmux send-keys -t %47 x", options)).resolves.toEqual({
				block: false,
			});
		});
	});

	// Regression tests for shell payload selection with long options (issue #6564-7)
	describe("regression: shell payload selection with long bash options (issue #6564-7)", () => {
		it("should find injection with bash --rcfile option before -c", async () => {
			// Issue: bash --rcfile /dev/null -c 'tmux send-keys -t %47 x'
			// The old code treated /dev/null as the payload instead of the quoted string after -c
			await expect(
				checkTmuxSelfInjection("bash --rcfile /dev/null -c 'tmux send-keys -t %47 x'", options),
			).resolves.toMatchObject({
				block: true,
			});
		});

		it("should find injection with bash --init-file option before -c", async () => {
			// Similar to --rcfile
			await expect(
				checkTmuxSelfInjection("bash --init-file /tmp/bashrc -c 'tmux send-keys -t %47 x'", options),
			).resolves.toMatchObject({
				block: true,
			});
		});

		it("should find injection with bash --norc option before -c", async () => {
			// Issue: bash --norc -c 'tmux send-keys -t %47 x' should find the injection
			// The old code may have had issues with long flag-only options
			await expect(
				checkTmuxSelfInjection("bash --norc -c 'tmux send-keys -t %47 x'", options),
			).resolves.toMatchObject({
				block: true,
			});
		});

		it("should find injection with bash --noprofile option before -c", async () => {
			// Similar to --norc
			await expect(
				checkTmuxSelfInjection("bash --noprofile -c 'tmux send-keys -t %47 x'", options),
			).resolves.toMatchObject({
				block: true,
			});
		});

		it("conservatively scans shell syntax in a dash-prefixed quoted -c argument", async () => {
			await expect(
				checkTmuxSelfInjection("bash -c '-x || tmux send-keys -t %47 x'", options),
			).resolves.toMatchObject({
				block: true,
			});
		});

		it("scans a dash-prefixed command string after Bash's -- terminator", async () => {
			await expect(
				checkTmuxSelfInjection("bash -c -- '-x || tmux send-keys -t %47 x'", options),
			).resolves.toMatchObject({ block: true });
		});

		it("should find injection in script file with long option", async () => {
			// Issue: bash --norc 'script.sh' should not treat script.sh as a payload
			const scriptPath = "/tmp/gjc-6564-7-injection.sh";
			await Bun.write(scriptPath, "tmux send-keys -t %47 x\n");
			try {
				await expect(checkTmuxSelfInjection(`bash --norc ${scriptPath}`, options)).resolves.toMatchObject({
					block: true,
				});
				await expect(checkTmuxSelfInjection(`bash +O extglob ${scriptPath}`, options)).resolves.toMatchObject({
					block: true,
				});
			} finally {
				await Bun.file(scriptPath).delete();
			}
		});

		it("should handle long option with equals syntax", async () => {
			// bash --rcfile=/dev/null -c 'tmux send-keys -t %47 x'
			await expect(
				checkTmuxSelfInjection("bash --rcfile=/dev/null -c 'tmux send-keys -t %47 x'", options),
			).resolves.toMatchObject({
				block: true,
			});
		});
	});

	// Regression tests for blocking findings from probepark review
	describe("regression: blocking findings from probepark review (head 8d536c8)", () => {
		// Issue 1: P2 — Payload selection for bash -c
		it("blocks bash -c with true followed by quoted tmux command", async () => {
			// Issue: bash -c true 'tmux send-keys -t %47 x'
			// bash executes 'true', not the quoted tmux command
			// Guard should check 'true' as the actual command
			await expect(checkTmuxSelfInjection("bash -c true 'tmux send-keys -t %47 x'", options)).resolves.toMatchObject(
				{ block: false },
			); // 'true' is not tmux, so no injection
		});

		it("blocks bash -c with quoted tmux command", async () => {
			// Issue: bash -c 'tmux send-keys -t %47 x'
			// Guard should check the quoted string as the payload
			await expect(checkTmuxSelfInjection("bash -c 'tmux send-keys -t %47 x'", options)).resolves.toMatchObject({
				block: true,
			});
		});

		// Issue 2: P1 — Long wrapper arities for xargs
		it("blocks xargs --null with tmux", async () => {
			// Issue: printf z | xargs --null tmux send-keys -t %47 x
			// --null is flag-only, tmux is the command
			await expect(
				checkTmuxSelfInjection("printf z | xargs --null tmux send-keys -t %47 x", options),
			).resolves.toMatchObject({ block: true });
		});

		it("blocks xargs --max-args with proper operand", async () => {
			// Issue: printf z | xargs --max-args 1 tmux send-keys -t %47 x
			// --max-args takes argument 1, tmux is the command
			await expect(
				checkTmuxSelfInjection("printf z | xargs --max-args 1 tmux send-keys -t %47 x", options),
			).resolves.toMatchObject({ block: true });
		});

		it("blocks xargs --arg-file with proper file operand", async () => {
			// Issue: xargs --arg-file tmux send-keys -t %47 x
			// --arg-file takes argument (filename), tmux is the command
			await expect(
				checkTmuxSelfInjection("xargs --arg-file /tmp/args tmux send-keys -t %47 x", options),
			).resolves.toMatchObject({ block: true });
		});

		it("does not treat xargs --arg-file operands as TMUX assignments", async () => {
			await expect(
				checkTmuxSelfInjection("xargs --arg-file TMUX=other tmux send-keys -t %47 x", options),
			).resolves.toMatchObject({ block: true });
		});

		// Issue 3: P1 — env -S split-string payload
		it("blocks env -S with tmux in split string", async () => {
			// Issue: env -S 'tmux send-keys -t %47 x'
			// -S splits the string and executes the command
			await expect(checkTmuxSelfInjection("env -S 'tmux send-keys -t %47 x'", options)).resolves.toMatchObject({
				block: true,
			});
		});

		it("blocks env -S when argv0 options precede tmux", async () => {
			for (const command of [
				"env -S '-a disguise tmux send-keys -t %47 x'",
				"env -S '--argv0 disguise tmux send-keys -t %47 x'",
			]) {
				await expect(checkTmuxSelfInjection(command, options)).resolves.toMatchObject({ block: true });
			}
		});

		it("blocks env --split-string with tmux in split string", async () => {
			// Long form of -S
			await expect(
				checkTmuxSelfInjection("env --split-string='tmux send-keys -t %47 x'", options),
			).resolves.toMatchObject({ block: true });
		});

		it("blocks env --split-string with a separated payload", async () => {
			await expect(
				checkTmuxSelfInjection("env --split-string 'tmux send-keys -t %47 x'", options),
			).resolves.toMatchObject({ block: true });
		});

		it("blocks env -u FOO -S with tmux in split string", async () => {
			// Issue: env -u FOO -S 'tmux send-keys -t %47 x'
			// The -u option takes FOO as operand; should continue to -S
			await expect(
				checkTmuxSelfInjection("env -u FOO -S 'tmux send-keys -t %47 x'", options),
			).resolves.toMatchObject({ block: true });
		});

		it("blocks env --split-string with equals-form containing tmux", async () => {
			// Issue: env --split-string='FOO=x tmux send-keys -t %47 x'
			// The full value after = should be used, not just up to the second =
			await expect(
				checkTmuxSelfInjection("env --split-string='FOO=x tmux send-keys -t %47 x'", options),
			).resolves.toMatchObject({ block: true });
		});

		it("decodes escaped quotes in nested env split strings", async () => {
			await expect(
				checkTmuxSelfInjection('env -S \'env -S "env -S \\"tmux send-keys -t %47 x\\""\'', options),
			).resolves.toMatchObject({ block: true });
		});

		it("recognizes unambiguous long-option abbreviations for wrappers", async () => {
			for (const command of [
				"env --uns FOO tmux send-keys -t %47 x",
				"env --spl 'tmux send-keys -t %47 x'",
				"timeout --sig TERM 5 tmux send-keys -t %47 x",
				"nice --adj 1 tmux send-keys -t %47 x",
			]) {
				await expect(checkTmuxSelfInjection(command, options)).resolves.toMatchObject({ block: true });
			}
		});

		it("recognizes GNU env split-string abbreviations recursively", async () => {
			await expect(
				checkTmuxSelfInjection(`env -S '--spl "tmux send-keys -t %47 x"'`, options),
			).resolves.toMatchObject({ block: true });
		});

		it("preserves env split-string argv for nested shell payloads", async () => {
			await expect(
				checkTmuxSelfInjection(`env -S 'bash -c "tmux send-keys -t %47 x"'`, options),
			).resolves.toMatchObject({ block: true });
		});

		it("does not parse quoted env split-string arguments as commands", async () => {
			await expect(checkTmuxSelfInjection(`env -S 'printf "tmux send-keys -t %47 x"'`, options)).resolves.toEqual({
				block: false,
			});
		});

		it("keeps words after env split strings as arguments to the split command", async () => {
			await expect(checkTmuxSelfInjection("env -S 'printf <%s>' tmux send-keys -t %47 x", options)).resolves.toEqual(
				{ block: false },
			);
			await expect(
				checkTmuxSelfInjection("env -S 'bash -c' 'tmux send-keys -t %47 x'", options),
			).resolves.toMatchObject({ block: true });
		});

		// Issue 4: P1 — Socket backtracking across command boundaries
		it("allows tmux after semicolon-separated TMUX assignment", async () => {
			// Issue: TMUX=/tmp/other env FOO=x; tmux send-keys -t %47 x
			// TMUX=/tmp/other belongs to env, semicolon creates boundary
			// This tmux is not affected by that assignment
			await expect(
				checkTmuxSelfInjection("TMUX=/tmp/other env FOO=x; tmux send-keys -t %47 x", options),
			).resolves.toMatchObject({ block: true }); // Uses current pane, not overridden socket
		});

		it("blocks tmux with correct TMUX assignment in same invocation", async () => {
			// TMUX=/tmp/other should affect the tmux command in the same invocation
			await expect(checkTmuxSelfInjection("TMUX=/tmp/other tmux send-keys -t %47 x", options)).resolves.toEqual({
				block: false,
			}); // Different socket
		});

		// Issue 5: P1 — Short bundle parsing with argument-taking options
		it("blocks env -iu FOO with tmux as wrapped command", async () => {
			// Issue: env -iu FOO tmux send-keys -t %47 x
			// -i (flag-only), -u FOO (takes argument)
			// tmux is the wrapped command
			await expect(checkTmuxSelfInjection("env -iu FOO tmux send-keys -t %47 x", options)).resolves.toMatchObject({
				block: true,
			});
		});

		it("blocks env -uFOO (bundled) with tmux as wrapped command", async () => {
			// -u FOO bundled without space
			await expect(checkTmuxSelfInjection("env -uFOO tmux send-keys -t %47 x", options)).resolves.toMatchObject({
				block: true,
			});
		});

		// Issue 6: P1 — Pending operands before option classification
		it("blocks xargs -I with -X replacement string and tmux command", async () => {
			// Issue: xargs -I -X tmux send-keys -t %47 x
			// -I takes argument, next token -X is the replacement string
			// tmux is the command
			await expect(
				checkTmuxSelfInjection("printf x | xargs -I -X tmux send-keys -t %47 x", options),
			).resolves.toMatchObject({ block: true });
		});
	});

	// Regression tests for the three blocking findings from probepark review (head dcf0c87)
	describe("regression: blocking findings from probepark review (head dcf0c87)", () => {
		it("blocks env -S with option prefix before command", async () => {
			// Finding 1: env -S '-i tmux send-keys -t %47 x'
			// env -S splits the string, -i is env option, tmux should be detected as injection target
			await expect(checkTmuxSelfInjection("env -S '-i tmux send-keys -t %47 x'", options)).resolves.toMatchObject({
				block: true,
			});
		});

		it("allows xargs -I with TMUX operand (not socket override)", async () => {
			// Finding 2: printf x | xargs -I TMUX=/tmp/other tmux send-keys -t %47 x
			// TMUX=/tmp/other is the -I replacement operand, not an env assignment
			// Socket should not be overridden, tmux targets current pane and should be blocked
			await expect(
				checkTmuxSelfInjection("printf x | xargs -I TMUX=/tmp/other tmux send-keys -t %47 x", options),
			).resolves.toMatchObject({ block: true });
		});

		it("respects bundled xargs -rI operand arity during socket lookup", async () => {
			await expect(
				checkTmuxSelfInjection("printf x | xargs -rI TMUX=/tmp/other tmux send-keys -t %47 x", options),
			).resolves.toMatchObject({ block: true });
		});

		it("blocks env --chdir with tmux after directory argument", async () => {
			// Finding 3: env --chdir /tmp tmux send-keys -t %47 x
			// --chdir takes an argument (/tmp), tmux is the actual command
			await expect(
				checkTmuxSelfInjection("env --chdir /tmp tmux send-keys -t %47 x", options),
			).resolves.toMatchObject({ block: true });
		});

		it("blocks xargs --max-lines with count argument", async () => {
			// Finding 3: xargs --max-lines 1 tmux send-keys -t %47 x
			// --max-lines takes a numeric argument (1), tmux is the command
			await expect(
				checkTmuxSelfInjection("printf x | xargs --max-lines 1 tmux send-keys -t %47 x", options),
			).resolves.toMatchObject({ block: true });
		});
	});

	describe("regression: wrapper and shell parsing boundaries", () => {
		it("blocks attached env split-string payloads", async () => {
			for (const command of ["env '-Stmux send-keys -t %47 x'", "env -vS 'tmux send-keys -t %47 x'"]) {
				await expect(checkTmuxSelfInjection(command, options)).resolves.toMatchObject({ block: true });
			}
		});

		it("keeps xargs --eof's optional value attached-only", async () => {
			await expect(checkTmuxSelfInjection("xargs --eof tmux send-keys -t %47 x", options)).resolves.toMatchObject({
				block: true,
			});
		});

		it("consumes sudo short and long chroot operands", async () => {
			for (const command of [
				"sudo -R / tmux send-keys -t %47 x",
				"sudo --chroot / tmux send-keys -t %47 x",
				"sudo --user root tmux send-keys -t %47 x",
			]) {
				await expect(checkTmuxSelfInjection(command, options)).resolves.toMatchObject({ block: true });
			}
		});

		it("consumes an empty env split-string operand without hiding the command", async () => {
			await expect(checkTmuxSelfInjection("env -S '' tmux send-keys -t %47 x", options)).resolves.toMatchObject({
				block: true,
			});
		});

		it("decodes env split-string escaped separators", async () => {
			await expect(
				checkTmuxSelfInjection("env -S 'tmux\\_send-keys\\_-t\\_%47\\_x'", options),
			).resolves.toMatchObject({ block: true });
		});

		it("keeps shell redirections from ending wrapper parsing", async () => {
			for (const command of [
				"env > /tmp/log tmux send-keys -t %47 x",
				"env >/tmp/log tmux send-keys -t %47 x",
				"env 2>/tmp/log tmux send-keys -t %47 x",
				"env </dev/null tmux send-keys -t %47 x",
			]) {
				await expect(checkTmuxSelfInjection(command, options)).resolves.toMatchObject({ block: true });
			}
		});

		it("does not treat here-document text as an executed command", async () => {
			await expect(
				checkTmuxSelfInjection(`bash -c 'cat <<EOF\ntmux send-keys -t %47 x\nEOF'`, options),
			).resolves.toEqual({ block: false });
		});

		it("inspects here-document bodies executed from shell stdin", async () => {
			const script = "tmux send-keys -t %47 x";
			for (const command of [
				`bash <<'EOF'\n${script}\nEOF`,
				`( bash ) <<'EOF'\n${script}\nEOF`,
				`bash <<'EOF' 0<&0\n${script}\nEOF`,
				`bash <<'EOF' 0<&00\n${script}\nEOF`,
				`bash /dev/stdin <<'EOF'\n${script}\nEOF`,
				`bash -- /dev/stdin <<'EOF'\n${script}\nEOF`,
				`bash -s <<'EOF'\n${script}\nEOF`,
				`bash -- - <<'EOF'\n${script}\nEOF`,
				`bash -c bash <<'EOF'\n${script}\nEOF`,
				`cat <<'EOF' | bash\n${script}\nEOF`,
				`cat <<'EOF' | (bash)\n${script}\nEOF`,
				`cat <<'EOF' |\nbash\n${script}\nEOF`,
				`cat <<'EOF' |\\\nbash\n${script}\nEOF`,
				`bash -c 'bash 3<<INNER\n:\nINNER\n' <<'OUTER'\n${script}\nOUTER`,
				`bash -c '. /dev/stdin' <<'EOF'\n${script}\nEOF`,
				`bash -c 'source /dev/stdin' <<'EOF'\n${script}\nEOF`,
				`bash -c 'source /proc/$$/fd/0' <<'EOF'\n${script}\nEOF`,
				`env bash <<'EOF'\n${script}\nEOF`,
				`env -S 'bash -s' <<'EOF'\n${script}\nEOF`,
				`busybox sh <<'EOF'\n${script}\nEOF`,
			]) {
				await expect(checkTmuxSelfInjection(command, options)).resolves.toMatchObject({ block: true });
			}
		});

		it("carries wrapper working directories into here-document shell payloads", async () => {
			const targetCwd = "/tmp/target";
			const localOptions = {
				...options,
				cwd: "/tmp/original",
				env: { ...env, TMUX: `${targetCwd}/tmux.sock,12345,0` },
			};
			await expect(
				checkTmuxSelfInjection(
					`env -C ${targetCwd} bash <<'EOF'\ntmux -S tmux.sock send-keys -t %47 x\nEOF`,
					localOptions,
				),
			).resolves.toMatchObject({ block: true });
		});

		it("resolves nested scripts from env chdir in executable stdin", async () => {
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-tmux-env-stdin-script-cwd-"));
			const originalCwd = path.join(tempDir, "original");
			const targetCwd = path.join(tempDir, "target");
			await Promise.all([fs.mkdir(originalCwd), fs.mkdir(targetCwd)]);
			await Bun.write(path.join(targetCwd, "nested.sh"), "tmux send-keys -t %47 x\n");
			const localOptions = { ...options, cwd: originalCwd, env: { ...env, PWD: originalCwd } };
			try {
				await expect(
					checkTmuxSelfInjection(`env -C ${targetCwd} bash -s <<'EOF'\nsh ./nested.sh\nEOF`, localOptions),
				).resolves.toMatchObject({ block: true });
			} finally {
				await fs.rm(tempDir, { recursive: true, force: true });
			}
		});

		it("inspects here-documents used as non-stdin shell script files", async () => {
			const script = "tmux send-keys -t %47 x";
			for (const scriptPath of ["/dev/fd/3", "/proc/self/fd/3", "/proc/thread-self/fd/3", "/proc/$$/fd/3"]) {
				const command = `bash ${scriptPath} 3<<'EOF'\n${script}\nEOF`;
				await expect(checkTmuxSelfInjection(command, options)).resolves.toMatchObject({ block: true });
			}
		});

		it("inspects here-documents duplicated onto script and source descriptors", async () => {
			const script = "tmux send-keys -t %47 x";
			for (const command of [
				`bash /dev/fd/4 3<<'EOF' 4<&3\n${script}\nEOF`,
				`source /dev/fd/3 3<<'EOF'\n${script}\nEOF`,
				`source /dev/fd/4 3<<'EOF' 4<&3\n${script}\nEOF`,
				`bash -c 'source /dev/fd/3' 3<<'EOF'\n${script}\nEOF`,
				`bash -c 'source /dev/fd/4' 3<<'EOF' 4<&3\n${script}\nEOF`,
			]) {
				await expect(checkTmuxSelfInjection(command, options)).resolves.toMatchObject({ block: true });
			}
		});

		it("inspects a here-document script that sources a second here-document", async () => {
			const command =
				"bash /dev/fd/3 3<<'OUTER' 4<<'INNER' 5<&4\nsource /dev/fd/5\nOUTER\ntmux send-keys -t %47 x\nINNER";
			await expect(checkTmuxSelfInjection(command, options)).resolves.toMatchObject({ block: true });
		});

		it("finds nested stdin scripts that source a second here-document", async () => {
			const command =
				"bash /dev/fd/3 3<<'OUTER' 4<<'INNER' 5<&4\nbash -s <<'NESTED'\nsource /dev/fd/5\nNESTED\nOUTER\ntmux send-keys -t %47 x\nINNER";
			await expect(checkTmuxSelfInjection(command, options)).resolves.toMatchObject({ block: true });
		});

		it("allows nested stdin scripts after the source descriptor is closed", async () => {
			const command =
				"bash /dev/fd/3 3<<'OUTER' 4<<'INNER' 5<&4\nexec 5<&-\nbash -s <<'NESTED'\nsource /dev/fd/5\nNESTED\nOUTER\ntmux send-keys -t %47 x\nINNER";
			await expect(checkTmuxSelfInjection(command, options)).resolves.toEqual({ block: false });
		});

		it("keeps descriptors live when a conditional exec close may be skipped", async () => {
			const commands = [
				"bash /dev/fd/3 3<<'OUTER' 4<<'INNER' 5<&4\nif false; then exec 5<&-; fi\nsource /dev/fd/5\nOUTER\ntmux send-keys -t %47 x\nINNER",
				"bash /dev/fd/3 3<<'OUTER' 4<<'INNER' 5<&4\nfalse && exec 5<&-\nsource /dev/fd/5\nOUTER\ntmux send-keys -t %47 x\nINNER",
			];
			for (const command of commands) {
				await expect(checkTmuxSelfInjection(command, options)).resolves.toMatchObject({ block: true });
			}
		});

		it("keeps descriptor-backed scripts live when a subshell closes its copy", async () => {
			const command =
				"bash /dev/fd/3 3<<'OUTER' 4<<'INNER' 5<&4\n( exec 5<&- )\nbash -s <<'NESTED'\nsource /dev/fd/5\nNESTED\nOUTER\ntmux send-keys -t %47 x\nINNER";
			await expect(checkTmuxSelfInjection(command, options)).resolves.toMatchObject({ block: true });
		});

		it("inspects here-documents duplicated onto shell stdin", async () => {
			const script = "tmux send-keys -t %47 x";
			await expect(checkTmuxSelfInjection(`bash -s 3<<'EOF' 0<&3\n${script}\nEOF`, options)).resolves.toMatchObject({
				block: true,
			});
			await expect(
				checkTmuxSelfInjection(`bash -c 'cat <&0' 3<<'EOF' 0<&3\n${script}\nEOF`, options),
			).resolves.toEqual({ block: false });
		});

		it("inspects shell here-strings but not data-only here-strings", async () => {
			await expect(checkTmuxSelfInjection("bash <<< 'tmux send-keys -t %47 x'", options)).resolves.toMatchObject({
				block: true,
			});
			await expect(checkTmuxSelfInjection("cat <<< 'tmux send-keys -t %47 x'", options)).resolves.toEqual({
				block: false,
			});
			await expect(checkTmuxSelfInjection("cat <<< '$(tmux send-keys -t %47 x)'", options)).resolves.toMatchObject({
				block: false,
			});
			for (const command of ["cat <<< $(tmux send-keys -t %47 x)", 'cat <<< "$(tmux send-keys -t %47 x)"']) {
				await expect(checkTmuxSelfInjection(command, options)).resolves.toMatchObject({ block: true });
			}
		});

		it("leaves non-stdin here-documents alone when they are data or superseded", async () => {
			const document = "tmux send-keys -t %47 x";
			for (const command of [
				`bash -c 'cat <&3' 3<<'EOF'\n${document}\nEOF`,
				`bash /dev/fd/4 3<<'EOF'\n${document}\nEOF`,
				`bash /dev/fd/3 3<<'EOF' 3</dev/null\n${document}\nEOF`,
				`bash -c 'cat <&4' 3<<'EOF' 4<&3\n${document}\nEOF`,
				`bash /dev/fd/4 3<<'EOF' 4<&3 4</dev/null\n${document}\nEOF`,
			]) {
				await expect(checkTmuxSelfInjection(command, options)).resolves.toEqual({ block: false });
			}
		});

		it("inspects command substitutions in unquoted here-documents", async () => {
			const substitution = "tmux send-keys -t %47 x";
			for (const command of [
				`cat <<EOF\n$(${substitution})\nEOF`,
				`bash -n <<EOF\n$(${substitution})\nEOF`,
				`cat <<EOF\n\`${substitution}\`\nEOF`,
				`cat <<EOF\n$\\\n(${substitution})\nEOF`,
				"cat <<EOF\n$(echo \"$(tmux send-keys -t '%47' x)\")\nEOF",
				"cat <<EOF\n$(case x in x) tmux send-keys -t %47 x ;; esac)\nEOF",
				"cat <<EOF\n`echo \\`tmux send-keys -t %47 x\\``\nEOF",
			]) {
				await expect(checkTmuxSelfInjection(command, options)).resolves.toMatchObject({ block: true });
			}
		});

		it("does not treat a pipe in a shell comment as a continued pipeline", async () => {
			await expect(
				checkTmuxSelfInjection("cat <<'EOF' # |\nEOF\ntmux send-keys -t %47 x", options),
			).resolves.toMatchObject({ block: true });
		});

		it("keeps here-document data and non-stdin redirects out of shell analysis", async () => {
			const document = "tmux send-keys -t %47 x";
			for (const command of [
				`cat <<'EOF'\n${document}\nEOF`,
				`cat <<EOF\n${document}\nEOF`,
				`cat <<'EOF'\n$(${document})\nEOF`,
				`cat <<EOF\n\\$(${document})\nEOF`,
				`cat <<'EOF' | cat\n${document}\nEOF`,
				`( echo safe ) <<'EOF' | bash\n${document}\nEOF`,
				`bash -c cat <<'EOF'\n${document}\nEOF`,
				`bash -c 'bash <<INNER\n:\nINNER\n' <<'OUTER'\n${document}\nOUTER`,
				`bash -s -c ':' <<'EOF'\n${document}\nEOF`,
				`bash /tmp/script.sh <<'EOF'\n${document}\nEOF`,
				`bash <<'EOF' < /dev/null\n${document}\nEOF`,
				`bash -c 'bash </dev/null' <<'EOF'\n${document}\nEOF`,
				`xargs bash -c bash <<'EOF'\n${document}\nEOF`,
				`bash 3<<'EOF'\n${document}\nEOF`,
			]) {
				await expect(checkTmuxSelfInjection(command, options)).resolves.toEqual({ block: false });
			}
		});

		it("uses the last stdin redirection for a shell here-document", async () => {
			const document = "tmux send-keys -t %47 x";
			await expect(
				checkTmuxSelfInjection(`bash < /dev/null <<'EOF'\n${document}\nEOF`, options),
			).resolves.toMatchObject({
				block: true,
			});
		});

		it("follows moved and output-duplicated here-document descriptors", async () => {
			const document = "tmux send-keys -t %47 x";
			for (const command of [
				`bash /dev/fd/3 4<<'EOF' 3<&4-\n${document}\nEOF`,
				`bash /dev/fd/3 <<'EOF' 3>&0\n${document}\nEOF`,
				`bash /proc/thread-self/fd/0 <<'EOF'\n${document}\nEOF`,
			]) {
				await expect(checkTmuxSelfInjection(command, options)).resolves.toMatchObject({ block: true });
			}
		});

		it("does not confuse xargs input with shell stdin", async () => {
			const document = "tmux send-keys -t %47 x";
			await expect(checkTmuxSelfInjection(`xargs bash <<EOF\n${document}\nEOF`, options)).resolves.toEqual({
				block: false,
			});
			await expect(
				checkTmuxSelfInjection(`xargs -a /dev/null bash <<EOF\n${document}\nEOF`, options),
			).resolves.toMatchObject({ block: true });
			await expect(
				checkTmuxSelfInjection(`xargs -a /dev/null bash -c bash <<EOF\n${document}\nEOF`, options),
			).resolves.toMatchObject({ block: true });
		});

		it("inspects standard input sourced through builtin dispatch", async () => {
			await expect(
				checkTmuxSelfInjection("builtin source /dev/stdin <<'EOF'\ntmux send-keys -t %47 x\nEOF", options),
			).resolves.toMatchObject({ block: true });
		});

		it("consumes exec's alternate-name operand", async () => {
			await expect(
				checkTmuxSelfInjection("exec -a disguise tmux send-keys -t %47 x", options),
			).resolves.toMatchObject({ block: true });
		});

		it("recognizes positive Bash option operands before -c", async () => {
			for (const command of [
				"bash +O extglob -c 'tmux send-keys -t %47 x'",
				"bash +o pipefail -c 'tmux send-keys -t %47 x'",
				"bash +eo pipefail -c 'tmux send-keys -t %47 x'",
				"bash +eO extglob -c 'tmux send-keys -t %47 x'",
				"bash +i -c 'tmux send-keys -t %47 x'",
				"bash +l -c 'tmux send-keys -t %47 x'",
				"bash +r -c 'tmux send-keys -t %47 x'",
				"bash +s -c 'tmux send-keys -t %47 x'",
				"bash +ei -c 'tmux send-keys -t %47 x'",
			]) {
				await expect(checkTmuxSelfInjection(command, options)).resolves.toMatchObject({ block: true });
			}
		});

		it("does not inspect Bash payloads that are read but not executed", async () => {
			const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-tmux-noexec-"));
			const scriptPath = path.join(cwd, "payload.sh");
			await Bun.write(scriptPath, "tmux send-keys -t %47 x\n");
			try {
				for (const command of [
					"bash -nc 'tmux send-keys -t %47 x'",
					"bash -D -c 'tmux send-keys -t %47 x'",
					"bash -o noexec -c 'tmux send-keys -t %47 x'",
					"bash --dump-strings -c 'tmux send-keys -t %47 x'",
					"bash --dump-po-strings -c 'tmux send-keys -t %47 x'",
					`bash -n ${scriptPath}`,
					`bash -o noexec ${scriptPath}`,
					`bash --dump-strings ${scriptPath}`,
					`bash --dump-po-strings ${scriptPath}`,
					"bash --help 'tmux send-keys -t %47 x'",
				]) {
					await expect(checkTmuxSelfInjection(command, { ...options, cwd })).resolves.toEqual({ block: false });
				}
				for (const command of [`bash -n +n ${scriptPath}`, `bash -o noexec +o noexec ${scriptPath}`]) {
					await expect(checkTmuxSelfInjection(command, { ...options, cwd })).resolves.toMatchObject({
						block: true,
					});
				}
			} finally {
				await fs.rm(cwd, { recursive: true, force: true });
			}
		});

		it("honors the final Bash no-exec option state", async () => {
			const document = "tmux send-keys -t %47 x";
			for (const command of [
				"bash -n +n -c 'tmux send-keys -t %47 x'",
				"bash -o noexec +o noexec -c 'tmux send-keys -t %47 x'",
				`bash -n +n <<'EOF'\n${document}\nEOF`,
				`bash -n +n -s scriptarg <<'EOF'\n${document}\nEOF`,
			]) {
				await expect(checkTmuxSelfInjection(command, options)).resolves.toMatchObject({ block: true });
			}
			for (const command of [
				`bash -n <<'EOF'\n${document}\nEOF`,
				`bash -n -s scriptarg <<'EOF'\n${document}\nEOF`,
				"bash -n -c 'tmux send-keys -t %47 x'",
			]) {
				await expect(checkTmuxSelfInjection(command, options)).resolves.toEqual({ block: false });
			}
		});

		it("does not parse eval payloads passed to env as shell builtins", async () => {
			await expect(
				checkTmuxSelfInjection("env PATH=/nonexistent eval 'tmux send-keys -t %47 x'", options),
			).resolves.toEqual({ block: false });
			for (const command of ["command eval 'tmux send-keys -t %47 x'", "builtin eval 'tmux send-keys -t %47 x'"]) {
				await expect(checkTmuxSelfInjection(command, options)).resolves.toMatchObject({ block: true });
			}
		});

		it("inspects assignments inside eval command strings", async () => {
			for (const command of [
				"eval FOO=x tmux -L default send-keys -t %47 x",
				"eval 'FOO=x tmux -L default send-keys -t %47 x'",
			]) {
				await expect(checkTmuxSelfInjection(command, options)).resolves.toMatchObject({ block: true });
			}
		});

		it("consumes Bash option operands bundled after -c", async () => {
			for (const command of [
				"bash -cO extglob 'tmux send-keys -t %47 x'",
				"bash -co pipefail 'tmux send-keys -t %47 x'",
			]) {
				await expect(checkTmuxSelfInjection(command, options)).resolves.toMatchObject({ block: true });
			}
		});

		it("resets builtin parsing at a newline", async () => {
			await expect(
				checkTmuxSelfInjection("builtin\nbash -c 'tmux send-keys -t %47 x'", options),
			).resolves.toMatchObject({ block: true });
			await expect(checkTmuxSelfInjection("builtin -- tmux send-keys -t %47 x", options)).resolves.toEqual({
				block: false,
			});
		});

		it("does not inspect a shell that is only a command lookup operand", async () => {
			await expect(checkTmuxSelfInjection("command -v bash -c 'tmux send-keys -t %47 x'", options)).resolves.toEqual(
				{ block: false },
			);
		});

		it("allows env terminal modes without treating following words as commands", async () => {
			for (const option of ["--help", "--version"]) {
				await expect(checkTmuxSelfInjection(`env ${option} tmux send-keys -t %47 x`, options)).resolves.toEqual({
					block: false,
				});
			}
		});
	});

	describe("regression: follow-up review findings", () => {
		it("continues scanning env options after a bundled -iu operand", async () => {
			await expect(
				checkTmuxSelfInjection("env -iu FOO -S 'tmux send-keys -t %47 x'", options),
			).resolves.toMatchObject({ block: true });
		});

		it("does not use a TMUX assignment cleared by env -u", async () => {
			for (const command of [
				"TMUX=/tmp/foreign env -u TMUX tmux send-keys -t %47 x",
				"TMUX=/tmp/foreign env --unset=TMUX tmux send-keys -t %47 x",
				"TMUX=/tmp/foreign env --unset=FOO --unset=TMUX tmux send-keys -t %47 x",
				"TMUX=/tmp/foreign env -iu FOO tmux send-keys -t %47 x",
			]) {
				await expect(checkTmuxSelfInjection(command, options)).resolves.toMatchObject({ block: true });
			}
		});

		it("uses the default TMUX_TMPDIR after env unsets it", async () => {
			const envOptions = { ...options, env: { ...options.env, TMUX_TMPDIR: "/tmp/foreign" } };
			await expect(
				checkTmuxSelfInjection(
					"TMUX_TMPDIR=/tmp/outer env -u TMUX_TMPDIR tmux -L default send-keys -t %47 x",
					envOptions,
				),
			).resolves.toMatchObject({ block: true });
		});

		it("uses the default TMUX_TMPDIR when an inline assignment is empty", async () => {
			await expect(
				checkTmuxSelfInjection("TMUX_TMPDIR= tmux -L default send-keys -t %47 x", options),
			).resolves.toMatchObject({ block: true });
		});

		it("does not inspect env split strings that are command lookup operands", async () => {
			await expect(checkTmuxSelfInjection("command -v env -S 'tmux send-keys -t %47 x'", options)).resolves.toEqual({
				block: false,
			});
		});

		it("honors a shell option terminator before the script argument", async () => {
			const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-tmux-shell-option-end-"));
			const localOptions = { ...options, cwd };
			try {
				await expect(checkTmuxSelfInjection("bash -- -c 'tmux send-keys -t %47 x'", localOptions)).resolves.toEqual(
					{
						block: false,
					},
				);
				await Bun.write(path.join(cwd, "-c"), "tmux send-keys -t %47 x\n");
				await expect(checkTmuxSelfInjection("bash -- -c", localOptions)).resolves.toMatchObject({ block: true });
				for (const scriptName of ["-n", "--help"]) {
					await Bun.write(path.join(cwd, scriptName), "tmux send-keys -t %47 x\n");
					await expect(checkTmuxSelfInjection(`bash -- ${scriptName}`, localOptions)).resolves.toMatchObject({
						block: true,
					});
				}
			} finally {
				await fs.rm(cwd, { recursive: true, force: true });
			}
		});

		it("consumes env split-string option terminators", async () => {
			await expect(checkTmuxSelfInjection("env -S '-- tmux send-keys -t %47 x'", options)).resolves.toMatchObject({
				block: true,
			});
		});

		it("preserves TMUX assignments from env split strings", async () => {
			await expect(
				checkTmuxSelfInjection("env -S 'TMUX=/tmp/other tmux send-keys -t %47 x'", options),
			).resolves.toEqual({ block: false });
		});

		it("ends wrapper option parsing at --", async () => {
			await expect(checkTmuxSelfInjection("env -- -x tmux send-keys -t %47 x", options)).resolves.toEqual({
				block: false,
			});
			await expect(checkTmuxSelfInjection("env -- tmux send-keys -t %47 x", options)).resolves.toMatchObject({
				block: true,
			});
			await expect(checkTmuxSelfInjection("env -- FOO=x tmux send-keys -t %47 x", options)).resolves.toMatchObject({
				block: true,
			});
			await expect(
				checkTmuxSelfInjection("env -- env FOO=x tmux send-keys -t %47 x", options),
			).resolves.toMatchObject({ block: true });
			await expect(
				checkTmuxSelfInjection("env -- TMUX=/tmp/other tmux send-keys -t %47 x", options),
			).resolves.toEqual({ block: false });
		});

		it("re-enters nested wrapper parsing after a command terminator", async () => {
			await expect(checkTmuxSelfInjection("command -- env tmux send-keys -t %47 x", options)).resolves.toMatchObject(
				{ block: true },
			);
		});

		it("treats assignments after the shell time keyword as environment assignments", async () => {
			await expect(checkTmuxSelfInjection("time FOO=x tmux send-keys -t %47 x", options)).resolves.toMatchObject({
				block: true,
			});
			await expect(checkTmuxSelfInjection("/usr/bin/time FOO=x tmux send-keys -t %47 x", options)).resolves.toEqual({
				block: false,
			});
			await expect(checkTmuxSelfInjection("time -f format tmux send-keys -t %47 x", options)).resolves.toEqual({
				block: false,
			});
		});

		it("finds xargs option operands across long option lists", async () => {
			await expect(
				checkTmuxSelfInjection("printf x | xargs -t -x -0 -r -I TMUX=/tmp/other tmux send-keys -t %47 x", options),
			).resolves.toMatchObject({ block: true });
		});

		it("recursively processes nested env split strings", async () => {
			await expect(
				checkTmuxSelfInjection("env -S \"-S 'tmux send-keys -t %47 x'\"", options),
			).resolves.toMatchObject({ block: true });
			await expect(
				checkTmuxSelfInjection("env -S '-iu FOO tmux send-keys -t %47 x'", options),
			).resolves.toMatchObject({ block: true });
		});

		it("preserves empty argv entries in env split strings", async () => {
			await expect(
				checkTmuxSelfInjection(`env -S "bash -c '' 'tmux send-keys -t %47 x'"`, options),
			).resolves.toEqual({ block: false });
		});

		it("consumes GNU env signal options in split strings", async () => {
			for (const option of [
				"-",
				"--block-signal",
				"--default-signal=TERM",
				"--ignore-signal=TERM",
				"--list-signal-handling",
			]) {
				await expect(
					checkTmuxSelfInjection(`env -S '${option} tmux send-keys -t %47 x'`, options),
				).resolves.toMatchObject({ block: true });
			}
		});

		it("does not discover commands after env null-output modes", async () => {
			for (const command of [
				"env -0 tmux send-keys -t %47 x",
				"env -i0 tmux send-keys -t %47 x",
				"env --null tmux send-keys -t %47 x",
				"env --nu tmux send-keys -t %47 x",
				"env -S '-0 tmux send-keys -t %47 x'",
				"env -S '--null tmux send-keys -t %47 x'",
				"env -S '-i0 tmux send-keys -t %47 x'",
				"env -S '-i -0 tmux send-keys -t %47 x'",
				"env -S '-0' tmux send-keys -t %47 x",
				"env -S '--null' tmux send-keys -t %47 x",
			]) {
				await expect(checkTmuxSelfInjection(command, options)).resolves.toEqual({ block: false });
			}
		});

		it("still discovers commands when env -0 is an option operand", async () => {
			for (const command of ["env -u -0 tmux send-keys -t %47 x", "env -S '-u -0 tmux send-keys -t %47 x'"]) {
				await expect(checkTmuxSelfInjection(command, options)).resolves.toMatchObject({ block: true });
			}
		});

		it("does not discover commands after non-executing GNU env modes", async () => {
			for (const command of [
				"env --help tmux send-keys -t %47 x",
				"env --he tmux send-keys -t %47 x",
				"env --version tmux send-keys -t %47 x",
				"env --ver tmux send-keys -t %47 x",
			]) {
				await expect(checkTmuxSelfInjection(command, options)).resolves.toEqual({ block: false });
			}
			await expect(
				checkTmuxSelfInjection("env -0 tmux send-keys -t %47 x; tmux send-keys -t %47 x", options),
			).resolves.toMatchObject({ block: true });
		});

		it("does not discover commands after non-executing sudo modes", async () => {
			for (const command of [
				"sudo -K tmux send-keys -t %47 x",
				"sudo --remove-timestamp tmux send-keys -t %47 x",
				"sudo -l tmux send-keys -t %47 x",
				"sudo -v tmux send-keys -t %47 x",
			]) {
				await expect(checkTmuxSelfInjection(command, options)).resolves.toEqual({ block: false });
			}
			await expect(
				checkTmuxSelfInjection("sudo -K tmux send-keys -t %47 x; tmux send-keys -t %47 x", options),
			).resolves.toMatchObject({ block: true });
		});

		it("recognizes positive shell options around -c", async () => {
			for (const command of ["bash +e -c 'tmux send-keys -t %47 x'", "bash -c +e 'tmux send-keys -t %47 x'"]) {
				await expect(checkTmuxSelfInjection(command, options)).resolves.toMatchObject({ block: true });
			}
		});
	});
});
