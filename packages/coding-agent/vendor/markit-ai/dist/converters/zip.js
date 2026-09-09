import { basename, extname } from "node:path";
import JSZip from "jszip";
const EXTENSIONS = [".zip"];
const MIMETYPES = ["application/zip", "application/x-zip-compressed"];
export class ZipConverter {
    name = "zip";
    parentConverters;
    constructor(parentConverters) {
        this.parentConverters = parentConverters;
    }
    accepts(streamInfo) {
        if (streamInfo.extension && EXTENSIONS.includes(streamInfo.extension))
            return true;
        if (streamInfo.mimetype &&
            MIMETYPES.some((m) => streamInfo.mimetype?.startsWith(m)))
            return true;
        return false;
    }
    async convert(input, streamInfo) {
        const zip = await JSZip.loadAsync(input);
        const label = streamInfo.localPath || streamInfo.filename || "archive.zip";
        const sections = [`Content from \`${basename(label)}\`:`];
        for (const [path, file] of Object.entries(zip.files)) {
            if (file.dir)
                continue;
            const ext = extname(path).toLowerCase();
            const fileInfo = {
                extension: ext,
                filename: basename(path),
            };
            const buffer = Buffer.from(await file.async("arraybuffer"));
            // Try each converter
            let converted = false;
            for (const converter of this.parentConverters) {
                if (converter.name === "zip")
                    continue; // avoid recursion loops
                if (!converter.accepts(fileInfo))
                    continue;
                try {
                    const result = await converter.convert(buffer, fileInfo);
                    if (result.markdown.trim()) {
                        sections.push(`## File: ${path}\n\n${result.markdown.trim()}`);
                        converted = true;
                        break;
                    }
                }
                catch {
                    // Try next converter
                }
            }
            if (!converted) {
                sections.push(`## File: ${path}\n\n*[binary file]*`);
            }
        }
        return { markdown: sections.join("\n\n").trim() };
    }
}
