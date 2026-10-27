#!/usr/bin/env node
import { createRequire } from "node:module";
import { Command } from "commander";
import { configGet, configSet, configShow } from "./commands/config.js";
import { convert } from "./commands/convert.js";
import { formats } from "./commands/formats.js";
import { init } from "./commands/init.js";
import { onboard } from "./commands/onboard.js";
import { pluginInstall, pluginList, pluginRemove } from "./commands/plugin.js";
const require = createRequire(import.meta.url);
const { version } = require("../package.json");
const program = new Command();
program
    .name("markit")
    .description("Convert anything to markdown.")
    .version(`markit ${version}`, "-V, --version")
    .option("--json", "Output as JSON")
    .option("-q, --quiet", "Raw markdown only, no decoration")
    .option("-p, --prompt <text>", "Extra instructions for image description")
    .option("-o, --output <file>", "Write to file instead of stdout")
    .option("-i, --image-dir <dir>", "Extract images to this directory")
    .addHelpText("after", `
Examples:
  $ markit report.pdf                  Convert a PDF to markdown
  $ markit document.docx -o doc.md     Convert DOCX, write to file
  $ markit https://example.com         Convert a web page
  $ markit photo.jpg                    Extract EXIF + AI description
  $ markit recording.mp3               Metadata + transcription
  $ cat file.pdf | markit -            Read from stdin
  $ markit init                        Create .markit/ config
  $ markit config show                 Show LLM settings

Docs: https://github.com/Michaelliv/markit`);
program
    .command("convert")
    .alias("c")
    .description("Convert a file or URL to markdown")
    .argument("<source>", "File path, URL, or - for stdin")
    .option("-o, --output <file>", "Write to file instead of stdout")
    .action(async (source, opts, cmd) => {
    const globals = cmd.optsWithGlobals();
    await convert(source, {
        json: globals.json,
        quiet: globals.quiet,
        output: opts.output,
        prompt: globals.prompt,
        imageDir: globals.imageDir,
    });
});
program
    .command("init")
    .description("Create .markit/ config directory")
    .action(async (_opts, cmd) => {
    const globals = cmd.optsWithGlobals();
    await init([], { json: globals.json, quiet: globals.quiet });
});
const configCmd = program
    .command("config")
    .description("Manage markit configuration");
configCmd
    .command("show")
    .description("Show current configuration")
    .action(async (_opts, cmd) => {
    const globals = cmd.optsWithGlobals();
    await configShow([], { json: globals.json, quiet: globals.quiet });
});
configCmd
    .command("get <key>")
    .description("Get a config value")
    .action(async (key, _opts, cmd) => {
    const globals = cmd.optsWithGlobals();
    await configGet(key, { json: globals.json, quiet: globals.quiet });
});
configCmd
    .command("set <key> [value]")
    .description("Set a config value (secrets read from stdin if no value given)")
    .action(async (key, value, _opts, cmd) => {
    const globals = cmd.optsWithGlobals();
    await configSet(key, value, { json: globals.json, quiet: globals.quiet });
});
const pluginCmd = program.command("plugin").description("Manage plugins");
pluginCmd
    .command("install <source>")
    .description("Install a plugin (npm:pkg, git:url, or local path)")
    .action(async (source, _opts, cmd) => {
    const globals = cmd.optsWithGlobals();
    await pluginInstall(source, { json: globals.json, quiet: globals.quiet });
});
pluginCmd
    .command("remove <name>")
    .description("Remove an installed plugin")
    .action(async (name, _opts, cmd) => {
    const globals = cmd.optsWithGlobals();
    await pluginRemove(name, { json: globals.json, quiet: globals.quiet });
});
pluginCmd
    .command("list")
    .description("List installed plugins")
    .action(async (_opts, cmd) => {
    const globals = cmd.optsWithGlobals();
    await pluginList({ json: globals.json, quiet: globals.quiet });
});
program
    .command("formats")
    .description("List supported formats")
    .action(async (_opts, cmd) => {
    const globals = cmd.optsWithGlobals();
    await formats([], { json: globals.json, quiet: globals.quiet });
});
program
    .command("onboard")
    .description("Add markit instructions to CLAUDE.md or AGENTS.md")
    .action(async (_opts, cmd) => {
    const globals = cmd.optsWithGlobals();
    await onboard([], { json: globals.json, quiet: globals.quiet });
});
// Default behavior: if first arg isn't a known subcommand, treat it as a source to convert
program.on("command:*", async (args) => {
    const source = args[0];
    if (!source) {
        program.help();
        return;
    }
    // Check for typos against known subcommands
    const commands = [
        "convert",
        "formats",
        "onboard",
        "help",
        "init",
        "config",
        "plugin",
    ];
    const close = commands.filter((c) => levenshtein(source, c) <= 2 && source !== c);
    if (close.length > 0 &&
        !source.includes("/") &&
        !source.includes(".") &&
        !source.startsWith("http")) {
        const { error } = await import("./utils/output.js");
        error(`Unknown command '${source}'. Did you mean '${close[0]}'?`);
        process.exit(1);
    }
    const globals = program.opts();
    await convert(source, {
        json: globals.json,
        quiet: globals.quiet,
        output: globals.output,
        prompt: globals.prompt,
        imageDir: globals.imageDir,
    });
});
// No args → show concise help
if (process.argv.length <= 2) {
    console.log(`markit — convert anything to markdown

Usage:  markit <file-or-url> [options]

Examples:
  $ markit report.pdf
  $ markit document.docx -o doc.md
  $ markit https://example.com

Commands:
  markit init        Create .markit/ config directory
  markit config      Manage settings (LLM, API keys)
  markit formats     List supported formats
  markit onboard     Add instructions to CLAUDE.md

Run markit --help for all options.
Docs: https://github.com/Michaelliv/markit`);
    process.exit(0);
}
program.parseAsync(process.argv).catch((err) => {
    console.error("Fatal error:", err.message);
    process.exit(1);
});
function levenshtein(a, b) {
    const m = a.length;
    const n = b.length;
    const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++)
        dp[i][0] = i;
    for (let j = 0; j <= n; j++)
        dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0));
        }
    }
    return dp[m][n];
}
