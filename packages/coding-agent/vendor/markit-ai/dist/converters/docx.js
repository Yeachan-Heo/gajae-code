import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import mammoth from "mammoth";
import { createTurndown, normalizeTablesHtml } from "../utils/turndown.js";
const EXTENSIONS = [".docx"];
const MIMETYPES = [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];
export class DocxConverter {
    name = "docx";
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
        const imageDir = streamInfo.imageDir;
        if (imageDir) {
            mkdirSync(imageDir, { recursive: true });
        }
        let imageCount = 0;
        const convertImage = imageDir
            ? mammoth.images.imgElement((image) => {
                imageCount++;
                const ext = (image.contentType?.split("/")[1] || "png").replace("jpeg", "jpg");
                const filename = `image_${imageCount}.${ext}`;
                const filepath = join(imageDir, filename);
                return image.read("base64").then((base64) => {
                    writeFileSync(filepath, Buffer.from(base64, "base64"));
                    return { src: filepath, alt: `image_${imageCount}` };
                });
            })
            : mammoth.images.imgElement((image) => {
                imageCount++;
                const contentType = image.contentType || "image/png";
                return image.read("base64").then((base64) => {
                    return {
                        src: `data:${contentType};base64,${base64.slice(0, 0)}`,
                        alt: `image_${imageCount}`,
                    };
                });
            });
        const { value: html } = await mammoth.convertToHtml({ buffer: input }, { convertImage });
        const turndown = createTurndown();
        let markdown = turndown.turndown(normalizeTablesHtml(html));
        // Replace data URI images with comment placeholders when no imageDir
        if (!imageDir) {
            markdown = markdown.replace(/!\[([^\]]*)\]\(data:[^)]*\)/g, "<!-- image: $1 -->");
        }
        return { markdown: markdown.trim() };
    }
}
