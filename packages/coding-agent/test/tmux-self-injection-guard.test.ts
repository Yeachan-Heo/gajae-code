import { describe, expect, it } from "bun:test";
import { checkTmuxSelfInjection } from "../src/tools/tmux-self-injection-guard";

const env = {
	TMUX: `/tmp/tmux-${typeof process.getuid === "function" ? process.getuid() : 0}/default,12345,0`,
	TMUX_PANE: "%47",
	TMUX_TMPDIR: "/tmp",
	PWD: "/tmp",
};

function resolver(target: string): string | undefined {
	if (target === "demo" || target === "demo:19.0" || target === ".") return "%47";
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

	it("finds injection hidden behind a shell wrapper", async () => {
		await expect(checkTmuxSelfInjection("sh -c 'tmux send-keys -t %47 x'", options)).resolves.toMatchObject({
			block: true,
		});
	});

	it("finds injection in a shell script passed to bash", async () => {
		const scriptPath = "/tmp/gjc-5039-injection.sh";
		await Bun.write(scriptPath, "tmux send-keys -t %47 x\n");
		try {
			await expect(checkTmuxSelfInjection(`bash ${scriptPath}`, options)).resolves.toMatchObject({ block: true });
		} finally {
			await Bun.file(scriptPath).delete();
		}
	});

	it("finds injection in a shell script passed to bash", async () => {
		const scriptPath = "/tmp/gjc-5039-injection.sh";
		await Bun.write(scriptPath, "tmux send-keys -t %47 x\n");
		try {
			await expect(checkTmuxSelfInjection(`bash ${scriptPath}`, options)).resolves.toMatchObject({ block: true });
		} finally {
			await Bun.file(scriptPath).delete();
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
	});

	// Tests for must-stay-allowed cases (issue #6563)
	describe("must-stay-allowed cases", () => {
		it("should allow env -u tmux where tmux is the unset variable", async () => {
			await expect(checkTmuxSelfInjection("env -u tmux send-keys -t %47 x", options)).resolves.toEqual({
				block: false,
			});
		});

		it("should allow sudo -u tmux where tmux is a user name", async () => {
			await expect(checkTmuxSelfInjection("sudo -u tmux send-keys -t %47 x", options)).resolves.toEqual({
				block: false,
			});
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
	});
});
