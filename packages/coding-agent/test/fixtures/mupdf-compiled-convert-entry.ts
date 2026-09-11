import { convertFileWithMarkit } from "../../src/utils/markit";

const pdfPath = Bun.argv[Bun.argv.length - 1];
if (!pdfPath) throw new Error("expected pdf path");

const result = await convertFileWithMarkit(pdfPath);
if (!result.ok) {
	console.error(`CONVERT_FAILED:${result.error ?? "unknown error"}`);
	process.exit(1);
}
console.log(`CONVERTED:${result.content.trim().split("\n")[0]}`);
