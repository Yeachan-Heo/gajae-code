/**
 * Generate shell completion specs for external completion engines.
 */
import { Args, Command, Flags } from "@gajae-code/utils/cli";
import { commands, RootHelpCommand } from "../cli";
import {
	buildGjcFigSpec,
	defaultInshellisenseSpecDir,
	type InstallGjcInshellisenseSpecResult,
	installGjcInshellisenseSpec,
	renderFigSpecModule,
} from "../cli/completion-cli";

const TARGETS = ["inshellisense", "fig"] as const;

type CompletionTarget = (typeof TARGETS)[number];

function normalizeTarget(target: CompletionTarget): "inshellisense" {
	return target === "fig" ? "inshellisense" : target;
}

function formatInstallResult(result: InstallGjcInshellisenseSpecResult, customDir: boolean): string {
	const lines = [
		"Installed GJC inshellisense completion spec:",
		`  spec:  ${result.specPath}`,
		`  index: ${result.indexPath} (${result.indexStatus})`,
	];
	if (customDir) {
		lines.push(
			"Add the install directory to inshellisense's [specs].path setting, then restart the inshellisense session.",
		);
	} else {
		lines.push("Restart the inshellisense session, or run `is reinit` if your shell integration needs a refresh.");
	}
	return `${lines.join("\n")}\n`;
}

export default class Completion extends Command {
	static description = "Generate shell completion specs";

	static args = {
		target: Args.string({
			description: "Completion format",
			required: false,
			options: TARGETS,
		}),
	};

	static flags = {
		install: Flags.boolean({ description: "Install the generated spec for inshellisense" }),
		dir: Flags.string({ description: "Install directory (defaults to ~/.fig/autocomplete/build)" }),
		force: Flags.boolean({ description: "Overwrite an existing non-GJC inshellisense index.js" }),
		json: Flags.boolean({ description: "Output JSON instead of JavaScript or status text" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Completion);
		const target = normalizeTarget((args.target ?? "inshellisense") as CompletionTarget);
		if (target !== "inshellisense") {
			process.stderr.write(`Unsupported completion target: ${target}\n`);
			process.exitCode = 1;
			return;
		}
		if ((flags.dir || flags.force) && !flags.install) {
			process.stderr.write("--dir and --force only apply with --install\n");
			process.exitCode = 1;
			return;
		}

		const spec = await buildGjcFigSpec(commands, RootHelpCommand);
		if (!flags.install) {
			process.stdout.write(flags.json ? `${JSON.stringify(spec, null, 2)}\n` : renderFigSpecModule(spec));
			return;
		}

		const directory = flags.dir ?? defaultInshellisenseSpecDir();
		const result = await installGjcInshellisenseSpec(spec, { dir: directory, force: flags.force });
		if (flags.json) {
			process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
			return;
		}
		process.stdout.write(formatInstallResult(result, flags.dir !== undefined));
	}
}
