import { loadAllPlugins } from "../plugins/loader.js";
import { bold, dim, output } from "../utils/output.js";
const BUILTIN_FORMATS = [
    { name: "PDF", extensions: [".pdf"], builtin: true },
    { name: "Word", extensions: [".docx"], builtin: true },
    { name: "PowerPoint", extensions: [".pptx"], builtin: true },
    { name: "Excel", extensions: [".xlsx"], builtin: true },
    { name: "HTML", extensions: [".html", ".htm"], builtin: true },
    { name: "EPUB", extensions: [".epub"], builtin: true },
    { name: "Jupyter", extensions: [".ipynb"], builtin: true },
    { name: "RSS/Atom", extensions: [".rss", ".atom", ".xml"], builtin: true },
    { name: "CSV", extensions: [".csv", ".tsv"], builtin: true },
    { name: "JSON", extensions: [".json"], builtin: true },
    { name: "YAML", extensions: [".yaml", ".yml"], builtin: true },
    { name: "XML", extensions: [".xml", ".svg"], builtin: true },
    {
        name: "Images",
        extensions: [".jpg", ".png", ".gif", ".webp"],
        builtin: true,
    },
    {
        name: "Audio",
        extensions: [".mp3", ".wav", ".m4a", ".flac"],
        builtin: true,
    },
    {
        name: "Pages",
        extensions: [".pages"],
        builtin: true,
    },
    {
        name: "Keynote",
        extensions: [".key"],
        builtin: true,
    },
    {
        name: "Numbers",
        extensions: [".numbers"],
        builtin: true,
    },
    {
        name: "GitHub",
        extensions: ["github.com/*", "gist.github.com/*"],
        builtin: true,
    },
    { name: "ZIP", extensions: [".zip"], builtin: true },
    {
        name: "Plain text",
        extensions: [".txt", ".md", ".rst", ".log"],
        builtin: true,
    },
    {
        name: "Code",
        extensions: [".py", ".js", ".ts", ".go", ".rs", "..."],
        builtin: true,
    },
    { name: "URLs", extensions: ["http://", "https://"], builtin: true },
    { name: "Wikipedia", extensions: ["*.wikipedia.org"], builtin: true },
];
export async function formats(_args, options) {
    const plugins = await loadAllPlugins();
    const pluginFormats = plugins.flatMap((p) => p.formats.map((f) => ({
        name: f.name,
        extensions: f.extensions,
        builtin: false,
        plugin: p.name,
    })));
    const allFormats = [...BUILTIN_FORMATS, ...pluginFormats];
    output(options, {
        json: () => ({ formats: allFormats }),
        human: () => {
            console.log();
            console.log(bold("Supported formats"));
            console.log();
            for (const fmt of BUILTIN_FORMATS) {
                const exts = fmt.extensions.join(", ");
                const note = fmt.dep ? dim(` (requires: npm i ${fmt.dep})`) : "";
                console.log(`  ${fmt.name.padEnd(14)} ${dim(exts)}${note}`);
            }
            if (pluginFormats.length > 0) {
                console.log();
                console.log(bold("Plugin formats"));
                console.log();
                for (const fmt of pluginFormats) {
                    const exts = fmt.extensions.join(", ");
                    console.log(`  ${fmt.name.padEnd(14)} ${dim(exts)} ${dim(`(${fmt.plugin})`)}`);
                }
            }
            console.log();
        },
    });
}
