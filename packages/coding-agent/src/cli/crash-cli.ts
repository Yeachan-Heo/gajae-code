/**
 * Terminal adapter for `gjc crash`.
 *
 * Keeps all I/O concerns (readline, TTY detection, stdout) out of the flow in
 * `crash/report.ts`, which is the part that carries the consent contract and is
 * therefore tested against stubbed boundaries.
 */

import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { getCrashIndexPath } from "@gajae-code/utils";
import { compactCrashIndex, listCrashSignatures, resolveCrashStatePaths } from "../crash/index-store";
import { type CrashReportIo, type CrashReportOutcome, runCrashReportFlow } from "../crash/report";
import { runGhDefault } from "../utils/gh";

function createIo(): CrashReportIo {
	const write = (text: string) => {
		process.stdout.write(text);
	};
	const ask = async (question: string): Promise<string> => {
		const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
		try {
			return (await rl.question(question)).trim();
		} finally {
			rl.close();
		}
	};
	return {
		print: write,
		input: prompt => ask(`${prompt}: `),
		confirm: async prompt => {
			const answer = (await ask(`${prompt} [y/N] `)).toLowerCase();
			return answer === "y" || answer === "yes";
		},
		select: async (prompt, options) => {
			write(`\n${prompt}\n`);
			for (const [index, option] of options.entries()) write(`  ${index + 1}) ${option}\n`);
			const answer = await ask(`Choice [1-${options.length}] `);
			const choice = Number.parseInt(answer, 10);
			if (!Number.isInteger(choice) || choice < 1 || choice > options.length) return undefined;
			return choice - 1;
		},
	};
}

export async function runCrashReportCommand(): Promise<CrashReportOutcome> {
	const paths = resolveCrashStatePaths();
	return runCrashReportFlow({
		io: createIo(),
		paths,
		snapshotDir: path.dirname(getCrashIndexPath()),
		runGh: runGhDefault,
		interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
	});
}

export async function runCrashListCommand(json: boolean): Promise<void> {
	const paths = resolveCrashStatePaths();
	const index = await compactCrashIndex({ paths });
	const signatures = listCrashSignatures(index);
	if (json) {
		process.stdout.write(`${JSON.stringify({ overflow: index.overflow, signatures }, null, 2)}\n`);
		return;
	}
	if (signatures.length === 0) {
		process.stdout.write("No crash signatures recorded.\n");
		return;
	}
	if (index.overflow) process.stdout.write("warning: crash index is full; new signatures are not being recorded.\n");
	for (const signature of signatures) {
		const state = signature.reportedAt !== undefined ? "reported" : "unreported";
		process.stdout.write(
			`${signature.fingerprint}  fpv:${signature.fpv}  ${signature.lifetimeCount}x  ` +
				`${new Date(signature.firstSeen).toISOString().slice(0, 10)}→${new Date(signature.lastSeen).toISOString().slice(0, 10)}  ` +
				`${state}\n    ${signature.errorName}: ${signature.messageClass.slice(0, 120)}\n`,
		);
	}
}
