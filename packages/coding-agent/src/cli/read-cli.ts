/**
 * Read CLI command handler.
 *
 * Handles `gjc read` — invokes the `read` agent tool against a path/URL and
 * prints the resulting content blocks exactly as the model would receive them
 * (including truncation/limit notices appended by the meta-notice wrapper).
 */
import { getProjectDir } from "@gajae-code/utils";
import chalk from "chalk";
import { createCmuxInvocationPresentation } from "../cmux/integration";
import { Settings } from "../config/settings";
import type { ToolSession } from "../tools";
import { wrapToolWithMetaNotice } from "../tools/output-meta";
import { ReadTool } from "../tools/read";
import { renderError } from "../tools/tool-errors";

export interface ReadCommandArgs {
	path: string;
}

export async function runReadCommand(cmd: ReadCommandArgs): Promise<void> {
	if (!cmd.path) {
		process.stderr.write(chalk.red("error: path is required\n"));
		process.exit(1);
	}

	const cwd = getProjectDir();
	const settings = await Settings.init({ cwd });

	const presentation = createCmuxInvocationPresentation();
	const session: ToolSession = {
		cwd,
		hasUI: false,
		settings,
		presentation: presentation.presentation,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	};

	const tool = wrapToolWithMetaNotice(new ReadTool(session));

	try {
		const result = await tool.execute("gjc-read", { path: cmd.path });

		for (const block of result.content) {
			if (block.type === "text") {
				process.stdout.write(block.text);
				if (!block.text.endsWith("\n")) process.stdout.write("\n");
			} else if (block.type === "image") {
				const decodedBytes = Buffer.from(block.data, "base64").byteLength;
				process.stdout.write(
					chalk.dim(`[image content: ${block.mimeType}, ${decodedBytes} bytes base64-decoded]\n`),
				);
			}
		}
	} catch (err) {
		process.stderr.write(`${chalk.red(renderError(err))}\n`);
		process.exit(1);
	} finally {
		presentation.dispose();
	}
}
