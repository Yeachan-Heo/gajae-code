const TEXT_EXTENSIONS = [
    ".txt",
    ".md",
    ".markdown",
    ".rst",
    ".log",
    ".cfg",
    ".ini",
    ".yaml",
    ".yml",
    ".toml",
    ".xml",
    ".svg",
    ".env",
    ".sh",
    ".bash",
    ".zsh",
    ".fish",
    ".py",
    ".js",
    ".ts",
    ".jsx",
    ".tsx",
    ".go",
    ".rs",
    ".rb",
    ".java",
    ".c",
    ".cpp",
    ".h",
    ".hpp",
    ".cs",
    ".swift",
    ".kt",
    ".scala",
    ".sql",
    ".r",
    ".m",
    ".lua",
    ".pl",
    ".php",
    ".ex",
    ".exs",
    ".zig",
    ".nim",
    ".v",
    ".d",
    ".hs",
    ".ml",
    ".clj",
    ".makefile",
    ".dockerfile",
];
const TEXT_MIMETYPES = ["text/"];
export class PlainTextConverter {
    name = "plain-text";
    accepts(streamInfo) {
        if (streamInfo.extension &&
            TEXT_EXTENSIONS.includes(streamInfo.extension)) {
            return true;
        }
        if (streamInfo.mimetype &&
            TEXT_MIMETYPES.some((m) => streamInfo.mimetype?.startsWith(m))) {
            return true;
        }
        // If nothing else matched and there's no extension, try to decode as text
        if (!streamInfo.extension && !streamInfo.mimetype) {
            return true;
        }
        return false;
    }
    async convert(input, streamInfo) {
        const charset = streamInfo.charset || "utf-8";
        const text = new TextDecoder(charset).decode(input);
        // If it's already markdown, return as-is
        if (streamInfo.extension === ".md" ||
            streamInfo.extension === ".markdown") {
            return { markdown: text };
        }
        // For code files, wrap in a fenced code block
        const ext = streamInfo.extension?.slice(1);
        if (ext && !["txt", "log", "rst"].includes(ext)) {
            return { markdown: `\`\`\`${ext}\n${text}\n\`\`\`` };
        }
        return { markdown: text };
    }
}
