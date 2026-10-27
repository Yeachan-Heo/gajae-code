const EXTENSIONS = [".json"];
const MIMETYPES = ["application/json"];
export class JsonConverter {
    name = "json";
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
    async convert(input, _streamInfo) {
        const text = new TextDecoder("utf-8").decode(input);
        const parsed = JSON.parse(text);
        const pretty = JSON.stringify(parsed, null, 2);
        return { markdown: `\`\`\`json\n${pretty}\n\`\`\`` };
    }
}
