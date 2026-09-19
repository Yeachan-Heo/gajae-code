import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { Markit } from "../markit.js";
import { loadAllPlugins } from "../plugins/loader.js";
import { createLlmFunctions, registerProvider } from "../providers/index.js";
import { EXIT_ERROR, EXIT_UNSUPPORTED } from "../utils/exit-codes.js";
import { dim, error, output, success } from "../utils/output.js";
async function readStdin() {
    const chunks = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}
export async function convert(source, options) {
    const config = loadConfig();
    const plugins = await loadAllPlugins();
    // Register any providers from plugins
    for (const plugin of plugins) {
        for (const provider of plugin.providers) {
            registerProvider(provider);
        }
    }
    const llmFunctions = createLlmFunctions(config, options.prompt);
    const markit = new Markit(llmFunctions, plugins);
    // Auto-create a temp dir for images if not explicitly provided
    const imageDir = options.imageDir || mkdtempSync(join(tmpdir(), "markit-images-"));
    try {
        let result;
        const isStdin = source === "-";
        const isUrl = source.startsWith("http:") ||
            source.startsWith("https:") ||
            source.startsWith("file:");
        if (isStdin) {
            // Check if stdin is a TTY (no piped input)
            if (process.stdin.isTTY) {
                error("No input on stdin. Pipe a file: cat report.pdf | markit -");
                process.exit(EXIT_ERROR);
            }
            const buffer = await readStdin();
            result = await markit.convert(buffer, { imageDir });
        }
        else if (isUrl) {
            // Progress hint for URL fetches (stderr so it doesn't pollute piped output)
            if (!options.json && !options.quiet) {
                process.stderr.write(`ℹ Fetching ${source}...\n`);
            }
            result = await markit.convertUrl(source);
        }
        else {
            result = await markit.convertFile(source, { imageDir });
        }
        const label = isStdin ? "stdin" : source;
        // Write to file or stdout
        if (options.output) {
            writeFileSync(options.output, result.markdown);
            output(options, {
                json: () => ({
                    success: true,
                    source: label,
                    output: options.output,
                    title: result.title,
                    length: result.markdown.length,
                }),
                human: () => {
                    success(`Converted → ${options.output}`);
                    if (result.title)
                        console.log(dim(`  title: ${result.title}`));
                    console.log(dim(`  ${result.markdown.length} chars`));
                },
            });
        }
        else {
            output(options, {
                json: () => ({
                    success: true,
                    source: label,
                    title: result.title,
                    markdown: result.markdown,
                }),
                quiet: () => process.stdout.write(result.markdown),
                human: () => process.stdout.write(result.markdown),
            });
        }
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("Unsupported format")) {
            output(options, {
                json: () => ({ success: false, error: msg }),
                human: () => {
                    error(msg);
                    console.log(dim("  Run 'markit formats' to see supported formats."));
                },
            });
            process.exit(EXIT_UNSUPPORTED);
        }
        if (msg.includes("ENOENT") || msg.includes("no such file")) {
            output(options, {
                json: () => ({ success: false, error: `File not found: ${source}` }),
                human: () => error(`File not found: ${source}`),
            });
            process.exit(EXIT_ERROR);
        }
        output(options, {
            json: () => ({ success: false, error: msg }),
            human: () => error(msg),
        });
        process.exit(EXIT_ERROR);
    }
}
