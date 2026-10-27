import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { output, success } from "../utils/output.js";
const INSTRUCTIONS = `
<mill>
Use \`markit\` to convert files and URLs to markdown. Supports PDF, DOCX, HTML, XLSX, CSV, JSON, and plain text.

<commands>
- \`markit <file-or-url>\` - convert to markdown (stdout)
- \`markit <file-or-url> -o output.md\` - convert to file
- \`markit formats\` - list supported formats
</commands>

<rules>
- Use \`--json\` flag to get structured output for parsing
- Use \`-q\` to get raw markdown without formatting
- Pipe output directly: \`markit report.pdf | other-tool\`
</rules>
</markit>
`.trim();
const MARKER = "<mill>";
export async function onboard(_args, options) {
    const cwd = process.cwd();
    const claudeMd = join(cwd, "CLAUDE.md");
    const agentsMd = join(cwd, "AGENTS.md");
    let targetFile;
    if (existsSync(claudeMd)) {
        targetFile = claudeMd;
    }
    else if (existsSync(agentsMd)) {
        targetFile = agentsMd;
    }
    else {
        targetFile = claudeMd;
    }
    let existingContent = "";
    if (existsSync(targetFile)) {
        existingContent = readFileSync(targetFile, "utf-8");
    }
    if (existingContent.includes(MARKER)) {
        output(options, {
            json: () => ({
                success: true,
                file: targetFile,
                message: "already_onboarded",
            }),
            human: () => success(`Already onboarded (${targetFile})`),
        });
        return;
    }
    if (existingContent) {
        writeFileSync(targetFile, `${existingContent.trimEnd()}\n\n${INSTRUCTIONS}\n`);
    }
    else {
        writeFileSync(targetFile, `${INSTRUCTIONS}\n`);
    }
    output(options, {
        json: () => ({ success: true, file: targetFile }),
        human: () => success(`Added markit instructions to ${targetFile}`),
    });
}
