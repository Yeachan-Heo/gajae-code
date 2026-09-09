import { parseDoctorArgs } from "./doctor/args";
import { DOCTOR_EXIT_CODES, renderDoctorJson, renderDoctorText } from "./doctor/report";
import { runSupervisedDoctor } from "./doctor-supervisor";

/**
 * Execute the boot-safe doctor parser and delegate collection to an owned,
 * verified-terminated child worker (`doctor-supervisor.ts`). Diagnostics and
 * repairs never run in this process: a `Promise.race` here cannot bound
 * synchronous fs/native work, so only the child-process boundary can.
 */
export async function runDoctorCli(argv: readonly string[]): Promise<void> {
	if (argv.includes("--help") || argv.includes("-h")) {
		process.stdout.write(doctorHelp());
		return;
	}
	const parsed = parseDoctorArgs(argv);
	if (parsed.error || !parsed.options) {
		const message = parsed.error ?? "invalid arguments";
		if (argv.includes("--json"))
			process.stdout.write(
				`${JSON.stringify({
					schemaVersion: 1,
					command: "doctor",
					error: { code: "invalid_arguments", message },
					summary: { verdict: "inconclusive", exitCode: DOCTOR_EXIT_CODES.usage },
				})}\n`,
			);
		else process.stderr.write(`gjc doctor: ${message}\n`);
		process.exitCode = DOCTOR_EXIT_CODES.usage;
		return;
	}
	try {
		const report = await runSupervisedDoctor({
			argv,
			options: {
				...parsed.options,
				cwd: process.cwd(),
				tty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
			},
		});
		process.stdout.write(parsed.options.json ? renderDoctorJson(report) : renderDoctorText(report));
		process.exitCode = report.summary.exitCode;
	} catch {
		// The supervisor itself synthesizes bounded reports for every abnormal
		// ending; reaching here means something outside its own contract threw
		// (e.g. a module load failure), so degrade to the same sanitized envelope
		// used elsewhere rather than surfacing a raw exception.
		const envelope = {
			schemaVersion: 1,
			command: "doctor",
			error: { code: "doctor_supervisor_failure", message: "Doctor diagnostics could not be completed." },
			summary: { verdict: "inconclusive", exitCode: DOCTOR_EXIT_CODES.incomplete },
		};
		if (parsed.options.json) process.stdout.write(`${JSON.stringify(envelope)}\n`);
		else process.stderr.write("gjc doctor: Doctor diagnostics could not be completed.\n");
		process.exitCode = DOCTOR_EXIT_CODES.incomplete;
	}
}

function doctorHelp(): string {
	return `Usage: gjc doctor [options]\n\nRead-only bootstrap diagnostics and explicitly targeted repairs.\n\nOptions:\n  --json                         Emit machine-readable JSON\n  --fix --repair <action>        Apply one approved repair action\n  --dry-run                      Preview repair candidates without mutation\n  --target <stable-id>           Select the exact report target\n  --check <id>                   Select a check (repeatable)\n  --scope <user|project>         Constrain target scope\n  --set-value-json <true|false>  Boolean value for config/MCP repairs\n  --ref <candidate-ref>          Select a repair candidate\n  --sha256 <hex>                 Pin an artifact by digest\n  --allow-risk <class>           Approve a required risk class (repeatable)\n  --yes                          Skip interactive confirmation\n  --timeout-ms <n>               Bound diagnostic work\n  --drain                        Drain before service restart\n`;
}
