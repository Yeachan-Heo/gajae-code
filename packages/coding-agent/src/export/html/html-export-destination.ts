import * as fs from "node:fs";

const HTML_EXPORT_DESTINATION_OPEN_FLAGS =
	fs.constants.O_WRONLY | fs.constants.O_CREAT | (process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW ?? 0));

/** Owner-only HTML export. A replaced file is locked down on the opened descriptor. */
export function openHtmlExportDestination(outputPath: string): number {
	const fd = fs.openSync(outputPath, HTML_EXPORT_DESTINATION_OPEN_FLAGS, 0o600);
	try {
		fs.fchmodSync(fd, 0o600);
		return fd;
	} catch (error) {
		fs.closeSync(fd);
		throw error;
	}
}
