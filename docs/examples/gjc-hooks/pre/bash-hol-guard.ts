interface HookApi {
	on(event: "tool_call", handler: (event: { toolName: string; input: { command: string; cwd?: string } }) => Promise<{ block: true; reason: string } | undefined>): void;
}

interface GuardResult {
	classification?: { explicitly_benign?: boolean };
	minimum_action?: string;
}

const GUARD_TIMEOUT_MS = 10_000;

/**
 * Optional project-local example: copy this file to .gjc/hooks/pre/bash.ts.
 * HOL Guard must be installed and available on PATH.
 */
export default function registerHolGuardPreflight(api: HookApi): void {
	api.on("tool_call", async event => {
		if (event.toolName !== "bash") return;
		const command = event.input.command;
		if (!command.trim()) return { block: true, reason: "HOL Guard requires non-empty command text." };

		const guard = Bun.spawn(["hol-guard", "command", "test", command, "--json"], {
			cwd: event.input.cwd ?? process.cwd(),
			stdout: "pipe",
			stderr: "pipe",
		});

		let timeoutId: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<{ timedOut: true }>(resolve => {
			timeoutId = setTimeout(() => {
				guard.kill();
				resolve({ timedOut: true });
			}, GUARD_TIMEOUT_MS);
		});
		const completed = Promise.all([
			new Response(guard.stdout).text(),
			new Response(guard.stderr).text(),
			guard.exited,
		]).then(([stdout, stderr, exitCode]) => ({ timedOut: false as const, stdout, stderr, exitCode }));

		const result = await Promise.race([completed, timeout]);
		if (timeoutId) clearTimeout(timeoutId);
		if (result.timedOut) return { block: true, reason: "HOL Guard command inspection timed out." };
		if (result.exitCode !== 0) return { block: true, reason: "HOL Guard command inspection failed." };

		let parsed: GuardResult;
		try {
			parsed = JSON.parse(result.stdout) as GuardResult;
		} catch {
			return { block: true, reason: "HOL Guard returned invalid JSON." };
		}

		if (parsed.classification?.explicitly_benign === true && parsed.minimum_action === "allow") return;
		return { block: true, reason: "HOL Guard requires review before this command can run." };
	});
}
