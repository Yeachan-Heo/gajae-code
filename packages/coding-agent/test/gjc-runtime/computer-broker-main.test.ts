import { afterEach, expect, it } from "bun:test";
import { runCli } from "@gajae-code/coding-agent/cli";
import { parseArgs } from "@gajae-code/coding-agent/cli/args";
import { COMPUTER_BROKER_CLI_FLAG } from "@gajae-code/coding-agent/gjc-runtime/computer-broker";
import { runRootCommand } from "@gajae-code/coding-agent/main";

afterEach(() => {
	process.exitCode = 0;
});

it("acquires the managed computer broker lease before root-command routing", async () => {
	const events: string[] = [];
	await runRootCommand(parseArgs(["--resume"]), [], {
		acquireComputerBrokerLease: async () => {
			events.push("acquire");
		},
		isResumePickerTerminal: () => {
			events.push("route");
			return false;
		},
		suppressProcessExit: true,
	});
	expect(events).toEqual(["acquire", "route"]);
});

it("continues root routing after an ordinary ambient broker failure", async () => {
	const events: string[] = [];
	await runRootCommand(parseArgs(["--resume"]), [], {
		acquireComputerBrokerLease: async () => {
			events.push("acquire");
			throw Object.assign(new Error("unavailable"), { code: "COMPUTER_BROKER_UNAVAILABLE" });
		},
		isResumePickerTerminal: () => {
			events.push("route");
			return false;
		},
		suppressProcessExit: true,
	});
	expect(events).toEqual(["acquire", "route"]);
});

it("propagates ambient computer broker cleanup failures before root routing", async () => {
	const cleanupError = Object.assign(new Error("cleanup failed"), { code: "COMPUTER_BROKER_CLEANUP_FAILED" });
	let routed = false;
	await expect(
		runRootCommand(parseArgs(["--resume"]), [], {
			acquireComputerBrokerLease: async () => {
				throw cleanupError;
			},
			isResumePickerTerminal: () => {
				routed = true;
				return false;
			},
			suppressProcessExit: true,
		}),
	).rejects.toBe(cleanupError);
	expect(routed).toBe(false);
});

it("dispatches only the exact hidden computer broker selector", async () => {
	let runs = 0;
	const previousExitCode = process.exitCode;
	try {
		process.exitCode = undefined;
		await runCli([COMPUTER_BROKER_CLI_FLAG], {
			runComputerBrokerFromEnvironment: async () => {
				runs++;
			},
		});
		expect(runs).toBe(1);
		expect(process.exitCode).not.toBe(1);

		await runCli([COMPUTER_BROKER_CLI_FLAG, "extra"], {
			runComputerBrokerFromEnvironment: async () => {
				runs++;
			},
		});
		expect(runs).toBe(1);
		expect(Number(process.exitCode)).toBe(1);
	} finally {
		process.exitCode = previousExitCode;
	}
});

it("fails the hidden broker closed when malloc scrub re-exec is unavailable", async () => {
	const previousMalloc = process.env.MallocStackLogging;
	const previousMarker = process.env.GJC_MALLOC_ENV_REEXEC;
	const previousExitCode = process.exitCode;
	let reexecs = 0;
	let runs = 0;
	try {
		process.env.MallocStackLogging = "1";
		delete process.env.GJC_MALLOC_ENV_REEXEC;
		process.exitCode = undefined;
		await runCli([COMPUTER_BROKER_CLI_FLAG], {
			reexecWithScrubbedMallocEnv: async () => {
				reexecs++;
				return null;
			},
			runComputerBrokerFromEnvironment: async () => {
				runs++;
			},
		});
		expect(reexecs).toBe(1);
		expect(runs).toBe(0);
		expect(Number(process.exitCode)).toBe(1);
	} finally {
		if (previousMalloc === undefined) delete process.env.MallocStackLogging;
		else process.env.MallocStackLogging = previousMalloc;
		if (previousMarker === undefined) delete process.env.GJC_MALLOC_ENV_REEXEC;
		else process.env.GJC_MALLOC_ENV_REEXEC = previousMarker;
		process.exitCode = previousExitCode;
	}
});
