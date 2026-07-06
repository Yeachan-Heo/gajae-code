import { describe, expect, it } from "bun:test";
import { Args, type CliConfig, CliParseError, Command, type CommandEntry, Flags, run } from "../src/cli";

const CFG: CliConfig = { bin: "gjc", version: "1.0.0", commands: new Map() };

// A command with a constrained positional action and a constrained flag, mirroring
// the real `plugin` command that surfaced the crash (`gjc plugin help`).
class Demo extends Command {
	static description = "demo command";
	static args = {
		action: Args.string({ description: "action", required: false, options: ["build", "clean"] }),
	};
	static flags = {
		scope: Flags.string({ description: "scope", options: ["user", "project"] }),
	};
	async run(): Promise<void> {
		const { args } = await this.parse(Demo);
		sideEffect.ran = true;
		sideEffect.action = (args.action as string) ?? "(default)";
	}
}

class Boom extends Command {
	static description = "throws a non-parse error";
	async run(): Promise<void> {
		throw new Error("boom: genuine runtime failure");
	}
}

const sideEffect: { ran: boolean; action?: string } = { ran: false };
const commands: CommandEntry[] = [
	{ name: "demo", load: async () => Demo },
	{ name: "boom", load: async () => Boom },
];

/** Run the CLI while capturing stdout/stderr and isolating process.exitCode. */
async function runCapturing(
	argv: string[],
): Promise<{ out: string; err: string; exitCode: number | string | undefined }> {
	const origOut = process.stdout.write.bind(process.stdout);
	const origErr = process.stderr.write.bind(process.stderr);
	const origExit = process.exitCode;
	let out = "";
	let err = "";
	type Writer = { write: (s: string) => boolean };
	(process.stdout as unknown as Writer).write = (s: string) => {
		out += String(s);
		return true;
	};
	(process.stderr as unknown as Writer).write = (s: string) => {
		err += String(s);
		return true;
	};
	try {
		process.exitCode = 0; // clean baseline so "left unset by run()" reads back as 0
		await run({ bin: "gjc", version: "1.0.0", argv, commands });
		return { out, err, exitCode: process.exitCode };
	} finally {
		process.stdout.write = origOut;
		process.stderr.write = origErr;
		process.exitCode = origExit ?? 0; // Bun: `= undefined` is a no-op, so coerce to 0 to avoid leaking a numeric exitCode out of the test process
	}
}

describe("cli parse — CliParseError for invalid input", () => {
	it("throws CliParseError for a positional action outside its options", async () => {
		const cmd = new Demo(["help"], CFG); // e.g. `gjc plugin help`
		await expect(cmd.parse(Demo)).rejects.toBeInstanceOf(CliParseError);
		await expect(cmd.parse(Demo)).rejects.toThrow(/Expected action to be one of: build, clean; got "help"/);
	});

	it("throws CliParseError for a flag value outside its options", async () => {
		const cmd = new Demo(["build", "--scope", "porject"], CFG);
		await expect(cmd.parse(Demo)).rejects.toBeInstanceOf(CliParseError);
		await expect(cmd.parse(Demo)).rejects.toThrow(/Expected --scope to be one of: user, project/);
	});

	it("wraps node:util unknown-flag errors as CliParseError (strict command)", async () => {
		class Strict extends Command {
			static flags = { verbose: Flags.boolean({}) };
			async run(): Promise<void> {
				await this.parse(Strict);
			}
		}
		const cmd = new Strict(["--nope"], CFG);
		await expect(cmd.parse(Strict)).rejects.toBeInstanceOf(CliParseError);
	});

	it("accepts a valid action", async () => {
		const cmd = new Demo(["build"], CFG);
		const { args } = await cmd.parse(Demo);
		expect(args.action).toBe("build");
	});
});

describe("cli run — usage instead of uncaught crash", () => {
	it("renders usage + exits 2 (no throw) when a command gets an invalid action", async () => {
		sideEffect.ran = false;
		const { err, out, exitCode } = await runCapturing(["demo", "help"]);
		expect(err).toContain(`Expected action to be one of: build, clean; got "help"`);
		expect(out.toLowerCase()).toContain("usage"); // renderCommandHelp printed the command usage
		expect(exitCode).toBe(2);
		expect(sideEffect.ran).toBe(false); // command body never ran
	});

	it("runs the command normally for valid input and leaves exitCode unset", async () => {
		sideEffect.ran = false;
		const { exitCode } = await runCapturing(["demo", "build"]);
		expect(sideEffect.ran).toBe(true);
		expect(sideEffect.action).toBe("build");
		expect(exitCode).toBe(0);
	});

	it("still propagates genuine (non-parse) runtime errors", async () => {
		await expect(runCapturing(["boom"])).rejects.toThrow(/boom: genuine runtime failure/);
	});
});
