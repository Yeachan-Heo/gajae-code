import { XMLParser } from "fast-xml-parser";
import JSZip from "jszip";
const EXTENSIONS = [".xlsx"];
const MIMETYPES = [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];
export class XlsxConverter {
    name = "xlsx";
    accepts(streamInfo) {
        if (streamInfo.extension && EXTENSIONS.includes(streamInfo.extension))
            return true;
        if (streamInfo.mimetype &&
            MIMETYPES.some((m) => streamInfo.mimetype?.startsWith(m)))
            return true;
        return false;
    }
    async convert(input, _streamInfo) {
        const zip = await JSZip.loadAsync(input);
        const parser = new XMLParser({
            ignoreAttributes: false,
            attributeNamePrefix: "@_",
            textNodeName: "#text",
            processEntities: { maxTotalExpansions: 1_000_000 },
        });
        // Parse shared strings
        const ssXml = await zip.file("xl/sharedStrings.xml")?.async("string");
        const ss = ssXml ? parser.parse(ssXml) : null;
        const siList = ss?.sst?.si;
        const shared = toArray(siList);
        // Parse workbook for sheet names
        const wbXml = await zip.file("xl/workbook.xml")?.async("string");
        if (!wbXml)
            throw new Error("Invalid XLSX: missing workbook.xml");
        const wb = parser.parse(wbXml);
        const sheets = toArray(wb.workbook?.sheets?.sheet);
        // Parse workbook rels to map rIds to sheet files
        const relsXml = await zip
            .file("xl/_rels/workbook.xml.rels")
            ?.async("string");
        const rels = relsXml ? parser.parse(relsXml) : null;
        const relList = toArray(rels?.Relationships?.Relationship);
        const relMap = new Map();
        for (const r of relList) {
            relMap.set(r["@_Id"], r["@_Target"]);
        }
        const sections = [];
        for (const sheet of sheets) {
            const sheetName = sheet["@_name"];
            const rId = sheet["@_r:id"];
            const target = relMap.get(rId);
            if (!target)
                continue;
            const sheetPath = target.startsWith("/")
                ? target.slice(1)
                : `xl/${target}`;
            const sheetXml = await zip.file(sheetPath)?.async("string");
            if (!sheetXml)
                continue;
            const parsed = parser.parse(sheetXml);
            const rows = toArray(parsed.worksheet?.sheetData?.row);
            if (rows.length === 0)
                continue;
            // Extract all rows as string arrays
            const tableRows = [];
            for (const row of rows) {
                const cells = toArray(row.c);
                const values = [];
                for (const cell of cells) {
                    values.push(this.getCellValue(cell, shared));
                }
                tableRows.push(values);
            }
            if (tableRows.length === 0)
                continue;
            // Normalize column count
            const maxCols = Math.max(...tableRows.map((r) => r.length));
            for (const row of tableRows) {
                while (row.length < maxCols)
                    row.push("");
            }
            sections.push(`## ${sheetName}`);
            const [header, ...body] = tableRows;
            const lines = [];
            lines.push(`| ${header.join(" | ")} |`);
            lines.push(`| ${header.map(() => "---").join(" | ")} |`);
            for (const row of body) {
                lines.push(`| ${row.join(" | ")} |`);
            }
            sections.push(lines.join("\n"));
        }
        return { markdown: sections.join("\n\n") };
    }
    getCellValue(cell, shared) {
        // Shared string
        if (cell["@_t"] === "s") {
            return this.getSharedString(shared, Number(cell.v));
        }
        // Inline string
        if (cell["@_t"] === "inlineStr") {
            const is = cell.is;
            if (!is)
                return "";
            if (is.t != null)
                return textValue(is.t);
            if (is.r)
                return toArray(is.r)
                    .map((r) => textValue(r.t))
                    .join("");
            return "";
        }
        // Boolean
        if (cell["@_t"] === "b") {
            return cell.v === 1 || cell.v === "1" ? "TRUE" : "FALSE";
        }
        // Number or formula result
        if (cell.v != null)
            return String(cell.v);
        return "";
    }
    getSharedString(shared, idx) {
        const si = shared[idx];
        if (!si)
            return "";
        // Simple text
        if (si.t != null)
            return textValue(si.t);
        // Rich text runs
        if (si.r) {
            return toArray(si.r)
                .map((r) => textValue(r.t))
                .join("");
        }
        return "";
    }
}
function textValue(t) {
    if (t == null)
        return "";
    if (typeof t === "object")
        return t["#text"] || "";
    return String(t);
}
function toArray(val) {
    if (!val)
        return [];
    return Array.isArray(val) ? val : [val];
}
