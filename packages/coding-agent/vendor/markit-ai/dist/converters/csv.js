const EXTENSIONS = [".csv", ".tsv"];
const MIMETYPES = ["text/csv", "text/tab-separated-values"];
export class CsvConverter {
    name = "csv";
    accepts(streamInfo) {
        if (streamInfo.extension && EXTENSIONS.includes(streamInfo.extension)) {
            return true;
        }
        if (streamInfo.mimetype &&
            MIMETYPES.some((m) => streamInfo.mimetype?.startsWith(m))) {
            return true;
        }
        return false;
    }
    async convert(input, streamInfo) {
        const text = new TextDecoder(streamInfo.charset || "utf-8").decode(input);
        const delimiter = streamInfo.extension === ".tsv" ? "\t" : ",";
        const rows = this.parseRows(text, delimiter);
        if (rows.length === 0) {
            return { markdown: "" };
        }
        const [header, ...body] = rows;
        const lines = [];
        // Header
        lines.push(`| ${header.join(" | ")} |`);
        lines.push(`| ${header.map(() => "---").join(" | ")} |`);
        // Body
        for (const row of body) {
            // Pad row to match header length
            while (row.length < header.length)
                row.push("");
            lines.push(`| ${row.join(" | ")} |`);
        }
        return { markdown: lines.join("\n") };
    }
    parseRows(text, delimiter) {
        const rows = [];
        let current = [];
        let cell = "";
        let inQuotes = false;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (inQuotes) {
                if (ch === '"' && text[i + 1] === '"') {
                    cell += '"';
                    i++;
                }
                else if (ch === '"') {
                    inQuotes = false;
                }
                else {
                    cell += ch;
                }
            }
            else if (ch === '"') {
                inQuotes = true;
            }
            else if (ch === delimiter) {
                current.push(cell.trim());
                cell = "";
            }
            else if (ch === "\n" || (ch === "\r" && text[i + 1] === "\n")) {
                current.push(cell.trim());
                if (current.some((c) => c.length > 0))
                    rows.push(current);
                current = [];
                cell = "";
                if (ch === "\r")
                    i++;
            }
            else {
                cell += ch;
            }
        }
        // Last row
        if (cell || current.length > 0) {
            current.push(cell.trim());
            if (current.some((c) => c.length > 0))
                rows.push(current);
        }
        return rows;
    }
}
