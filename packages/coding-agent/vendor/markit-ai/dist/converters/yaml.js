const EXTENSIONS = [".yaml", ".yml"];
const MIMETYPES = ["text/yaml", "application/x-yaml"];
export class YamlConverter {
    name = "yaml";
    accepts(streamInfo) {
        if (streamInfo.extension && EXTENSIONS.includes(streamInfo.extension))
            return true;
        if (streamInfo.mimetype &&
            MIMETYPES.some((m) => streamInfo.mimetype?.startsWith(m)))
            return true;
        return false;
    }
    async convert(input, streamInfo) {
        const text = new TextDecoder(streamInfo.charset || "utf-8").decode(input);
        return { markdown: `\`\`\`yaml\n${text}\n\`\`\`` };
    }
}
