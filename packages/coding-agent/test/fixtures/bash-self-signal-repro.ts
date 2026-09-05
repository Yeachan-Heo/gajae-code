import { disposeAllShellSessions, executeBash } from "../../src/exec/bash-executor";

const sessionKey = "issue-5291-self-signal";
const results: Record<string, unknown> = {};

try {
	results.hostPid = process.pid;
	results.identity = await executeBash('printf "%s|%s" "$$" "$BASHPID"', {
		cwd: process.cwd(),
		timeout: 5_000,
		sessionKey,
	});
	await executeBash("export ISSUE5291_STATE=preserved", {
		cwd: process.cwd(),
		timeout: 5_000,
		sessionKey,
	});
	results.persistent = await executeBash('printf "%s" "$ISSUE5291_STATE"', {
		cwd: process.cwd(),
		timeout: 5_000,
		sessionKey,
	});

	for (const [name, command] of [
		["builtinTrap", "kill -TRAP $$"],
		["externalTrap", "/bin/kill -TRAP $$"],
		["processGroupTerm", "kill -TERM 0"],
		["uncatchableKill", "kill -KILL $$"],
	] as const) {
		let finalized = false;
		try {
			results[name] = await executeBash(command, {
				cwd: process.cwd(),
				timeout: 5_000,
				sessionKey: `${sessionKey}-${name}`,
			});
		} finally {
			finalized = true;
		}
		results[`${name}Finalized`] = finalized;
		results[`${name}Recovery`] = await executeBash("printf recovered", {
			cwd: process.cwd(),
			timeout: 5_000,
			sessionKey: `${sessionKey}-${name}`,
		});
	}

	results.parentAlive = true;
	process.stdout.write(`${JSON.stringify(results)}\n`);
} finally {
	await disposeAllShellSessions();
}
