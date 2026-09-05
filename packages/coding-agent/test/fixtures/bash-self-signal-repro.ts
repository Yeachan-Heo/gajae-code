import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
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
	results.substitutionIdentity = await executeBash(
		`printf "%s|" "$$"; value=$(python3 -c "import os; print(f'{os.getsid(0)}|{os.getpgrp()}')"); printf "%s" "$value"`,
		{ cwd: process.cwd(), timeout: 5_000, sessionKey },
	);
	results.timeoutIdentity = await executeBash(
		`printf "%s|" "$$"; timeout 5 python3 -c "import os; print(f'{os.getsid(0)}|{os.getpgrp()}')"`,
		{ cwd: process.cwd(), timeout: 5_000, sessionKey },
	);
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
		["userSignal", "kill -USR1 $$"],
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

	const orphanPidFile = path.join(os.tmpdir(), `gjc-issue-5291-orphan-${process.pid}.pid`);
	results.descendantSignal = await executeBash(
		`python3 -c 'import time; time.sleep(30)' & echo $! > '${orphanPidFile}'; kill -KILL $$`,
		{
			cwd: process.cwd(),
			timeout: 5_000,
			sessionKey: `${sessionKey}-descendant`,
		},
	);
	const descendantPid = Number.parseInt(await Bun.file(orphanPidFile).text(), 10);
	let descendantGone = false;
	for (let attempt = 0; attempt < 40; attempt++) {
		try {
			process.kill(descendantPid, 0);
			await Bun.sleep(25);
		} catch {
			descendantGone = true;
			break;
		}
	}
	results.descendantPid = descendantPid;
	results.descendantGone = descendantGone;
	await fs.rm(orphanPidFile, { force: true });

	const alarmPidFile = path.join(os.tmpdir(), `gjc-issue-5291-alarm-${process.pid}.pid`);
	const alarmReadyFile = path.join(os.tmpdir(), `gjc-issue-5291-alarm-${process.pid}.ready`);
	results.alarmSignal = await executeBash(
		`python3 -c 'import os,signal,time; signal.signal(signal.SIGALRM, signal.SIG_IGN); open(${JSON.stringify(alarmPidFile)}, "w").write(str(os.getpid())); open(${JSON.stringify(alarmReadyFile)}, "w").write("ready"); time.sleep(30)' & while [ ! -s '${alarmReadyFile}' ]; do sleep 0.01; done; kill -ALRM 0`,
		{
			cwd: process.cwd(),
			timeout: 5_000,
			sessionKey: `${sessionKey}-alarm`,
		},
	);
	const alarmPid = Number.parseInt(await Bun.file(alarmPidFile).text(), 10);
	let alarmGone = false;
	for (let attempt = 0; attempt < 40; attempt++) {
		try {
			process.kill(alarmPid, 0);
			await Bun.sleep(25);
		} catch {
			alarmGone = true;
			break;
		}
	}
	results.alarmPid = alarmPid;
	results.alarmGone = alarmGone;
	await Promise.all([fs.rm(alarmPidFile, { force: true }), fs.rm(alarmReadyFile, { force: true })]);

	results.parentAlive = true;
	process.stdout.write(`${JSON.stringify(results)}\n`);
} finally {
	await disposeAllShellSessions();
}
