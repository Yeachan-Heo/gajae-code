import { Command } from "@gajae-code/utils/cli";
import { runDoctorCli } from "../cli/doctor-cli";

export default class Doctor extends Command {
	static description = "Diagnose bootstrap, configuration, installation, plugins, and services";
	static strict = false;
	static examples = ["$ gjc doctor", "$ gjc doctor --json", "$ gjc doctor --dry-run --fix"];

	async run(): Promise<void> {
		const argv = process.argv.slice(3);
		await runDoctorCli(argv);
	}
}
