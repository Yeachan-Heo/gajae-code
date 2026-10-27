import { FileType, glob } from "../native/index.js";

const root = process.env.GLOB_CACHE_BUDGET_ROOT;
if (!root) throw new Error("missing GLOB_CACHE_BUDGET_ROOT");

try {
	await glob({
		path: root,
		pattern: "**/*.txt",
		recursive: true,
		hidden: true,
		gitignore: false,
		cache: false,
		fileType: FileType.File,
	});
} catch (error) {
	if (error instanceof Error && error.message.includes("FS_SCAN_LIMIT operation=collect dimension=entries root="))
		process.exit(0);
	throw error;
}

throw new Error("walker scan unexpectedly succeeded above the configured entry budget");
