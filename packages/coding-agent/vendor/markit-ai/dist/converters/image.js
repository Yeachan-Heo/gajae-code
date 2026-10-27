const EXTENSIONS = [
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".webp",
    ".tiff",
    ".tif",
    ".bmp",
    ".svg",
];
const MIMETYPES = ["image/"];
export class ImageConverter {
    name = "image";
    accepts(streamInfo) {
        if (streamInfo.extension && EXTENSIONS.includes(streamInfo.extension))
            return true;
        if (streamInfo.mimetype &&
            MIMETYPES.some((m) => streamInfo.mimetype?.startsWith(m)))
            return true;
        return false;
    }
    async convert(input, streamInfo, options) {
        const sections = [];
        // Extract EXIF metadata
        try {
            const exifr = await import("exifr");
            const metadata = await exifr.parse(input, {
                pick: [
                    "ImageWidth",
                    "ImageHeight",
                    "Make",
                    "Model",
                    "DateTimeOriginal",
                    "CreateDate",
                    "GPSLatitude",
                    "GPSLongitude",
                    "Artist",
                    "Copyright",
                    "Description",
                    "Title",
                    "Keywords",
                    "Software",
                    "ExposureTime",
                    "FNumber",
                    "ISO",
                    "FocalLength",
                ],
            });
            if (metadata && Object.keys(metadata).length > 0) {
                sections.push("## Metadata\n");
                if (metadata.ImageWidth && metadata.ImageHeight) {
                    sections.push(`ImageSize: ${metadata.ImageWidth}x${metadata.ImageHeight}`);
                }
                const fields = {
                    Title: metadata.Title,
                    Description: metadata.Description || metadata.ImageDescription,
                    Keywords: Array.isArray(metadata.Keywords)
                        ? metadata.Keywords.join(", ")
                        : metadata.Keywords,
                    Artist: metadata.Artist,
                    Copyright: metadata.Copyright,
                    Camera: [metadata.Make, metadata.Model].filter(Boolean).join(" "),
                    DateTimeOriginal: metadata.DateTimeOriginal
                        ? String(metadata.DateTimeOriginal)
                        : undefined,
                    CreateDate: metadata.CreateDate
                        ? String(metadata.CreateDate)
                        : undefined,
                    GPS: metadata.GPSLatitude && metadata.GPSLongitude
                        ? `${metadata.GPSLatitude}, ${metadata.GPSLongitude}`
                        : undefined,
                    ExposureTime: metadata.ExposureTime
                        ? `1/${Math.round(1 / metadata.ExposureTime)}s`
                        : undefined,
                    FNumber: metadata.FNumber ? `f/${metadata.FNumber}` : undefined,
                    ISO: metadata.ISO ? String(metadata.ISO) : undefined,
                    FocalLength: metadata.FocalLength
                        ? `${metadata.FocalLength}mm`
                        : undefined,
                    Software: metadata.Software,
                };
                for (const [key, value] of Object.entries(fields)) {
                    if (value)
                        sections.push(`${key}: ${value}`);
                }
            }
        }
        catch {
            // EXIF parsing failed — not all images have EXIF
        }
        // AI description
        if (options?.describe) {
            try {
                const mimetype = streamInfo.mimetype || guessMimetype(streamInfo.extension);
                const description = await options.describe(input, mimetype);
                if (description) {
                    sections.push(`\n## Description\n\n${description}`);
                }
            }
            catch {
                // Description failed — continue without it
            }
        }
        if (sections.length === 0) {
            return { markdown: `*[image: ${streamInfo.filename || "unknown"}]*` };
        }
        return { markdown: sections.join("\n").trim() };
    }
}
function guessMimetype(ext) {
    const map = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".tiff": "image/tiff",
        ".tif": "image/tiff",
        ".bmp": "image/bmp",
        ".svg": "image/svg+xml",
    };
    return map[ext || ""] || "image/png";
}
