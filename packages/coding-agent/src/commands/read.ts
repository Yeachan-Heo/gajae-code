/**
 * Show what the read tool will return for a given path.
 */
import { Args, Command, Flags } from "@gajae-code/utils/cli";
import { type ReadCommandArgs, runReadCommand } from "../cli/read-cli";
import { initTheme } from "../modes/theme/theme";

export default class Read extends Command {
	static description = "Show what the read tool will return for a path or URL";

	static args = {
		path: Args.string({
			description: "Path or URL to read (append :sel for line ranges or raw mode, e.g. src/foo.ts:50-100)",
			required: true,
		}),
	};

	static flags = {
		truncation: Flags.string({
			options: ["head", "last", "both"],
			description: "Which end of an over-budget result to keep",
		}),
	};

	static examples = [
		"gjc read src/foo.ts",
		"gjc read src/foo.ts --truncation head",
		"gjc read src/foo.ts:50-100",
		"gjc read src/foo.ts:raw",
		"gjc read https://example.com",
		"gjc read path/to/archive.zip:dir/file.ts",
		"gjc read path/to/db.sqlite:users:42",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Read);
		const cmd: ReadCommandArgs = {
			path: args.path ?? "",
			truncation: flags.truncation as ReadCommandArgs["truncation"],
		};
		await initTheme();
		await runReadCommand(cmd);
	}
}
