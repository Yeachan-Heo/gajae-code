const EXTENSIONS = [".ipynb"];
export class IpynbConverter {
    name = "ipynb";
    accepts(streamInfo) {
        if (streamInfo.extension && EXTENSIONS.includes(streamInfo.extension))
            return true;
        return false;
    }
    async convert(input, _streamInfo) {
        const text = new TextDecoder("utf-8").decode(input);
        const notebook = JSON.parse(text);
        const sections = [];
        let title;
        for (const cell of notebook.cells ?? []) {
            const source = Array.isArray(cell.source)
                ? cell.source.join("")
                : (cell.source ?? "");
            if (cell.cell_type === "markdown") {
                sections.push(source);
                // Extract first heading as title
                if (!title) {
                    const match = source.match(/^# (.+)$/m);
                    if (match)
                        title = match[1].trim();
                }
            }
            else if (cell.cell_type === "code") {
                // Detect language from kernel
                const lang = notebook.metadata?.kernelspec?.language ||
                    notebook.metadata?.language_info?.name ||
                    "python";
                sections.push(`\`\`\`${lang}\n${source}\n\`\`\``);
                // Include text outputs
                const outputs = [];
                for (const out of cell.outputs ?? []) {
                    if (out.output_type === "stream") {
                        const text = Array.isArray(out.text)
                            ? out.text.join("")
                            : (out.text ?? "");
                        if (text.trim())
                            outputs.push(text.trim());
                    }
                    else if (out.output_type === "execute_result" ||
                        out.output_type === "display_data") {
                        const data = out.data;
                        if (data?.["text/plain"]) {
                            const plain = Array.isArray(data["text/plain"])
                                ? data["text/plain"].join("")
                                : data["text/plain"];
                            if (plain.trim())
                                outputs.push(plain.trim());
                        }
                    }
                    else if (out.output_type === "error") {
                        const tb = (out.traceback ?? []).join("\n");
                        if (tb.trim())
                            outputs.push(`Error: ${out.ename}: ${out.evalue}`);
                    }
                }
                if (outputs.length > 0) {
                    sections.push(`\`\`\`\n${outputs.join("\n")}\n\`\`\``);
                }
            }
            else if (cell.cell_type === "raw") {
                sections.push(`\`\`\`\n${source}\n\`\`\``);
            }
        }
        // Check metadata for title
        title = notebook.metadata?.title ?? title;
        return {
            markdown: sections.join("\n\n").trim(),
            title,
        };
    }
}
