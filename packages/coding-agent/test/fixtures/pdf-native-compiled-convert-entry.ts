import { convertFileWithMarkit } from "../../src/utils/markit";

const pdfPath = Bun.argv[Bun.argv.length - 1];
if (!pdfPath) throw new Error("expected a PDF path");

const result = await convertFileWithMarkit(pdfPath);
if (!result.ok) throw new Error(result.error ?? "PDF conversion failed");
process.stdout.write(JSON.stringify({ content: result.content }));
