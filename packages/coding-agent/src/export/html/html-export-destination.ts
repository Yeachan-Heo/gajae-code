import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { hasFsCode, isEnoent } from "@gajae-code/utils";

const NOFOLLOW = process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW ?? 0);
const HTML_EXPORT_TEMP_OPEN_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW;
const HTML_EXPORT_EXISTING_OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | NOFOLLOW;

/**
 * Owner-only sibling of `outputPath` that an export is written to and then renamed over the
 * output, so a failed or interrupted export never leaves a partial file at the output path.
 */
export function createHtmlExportTempFile(outputPath: string): { path: string; fd: number } {
	const tempPath = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.${crypto.randomUUID()}.tmp`);
	const fd = fs.openSync(tempPath, HTML_EXPORT_TEMP_OPEN_FLAGS, 0o600);
	try {
		fs.fchmodSync(fd, 0o600);
		return { path: tempPath, fd };
	} catch (error) {
		fs.closeSync(fd);
		removeHtmlExportTempFile(tempPath);
		throw error;
	}
}

/**
 * Opens an existing output only to compare its identity with the source; never writes it.
 * Returns undefined when there is no output yet, or it cannot be opened for reading (the path
 * preflight already compared its identity).
 */
export function openExistingHtmlExportOutput(outputPath: string): number | undefined {
	try {
		return fs.openSync(outputPath, HTML_EXPORT_EXISTING_OPEN_FLAGS);
	} catch (error) {
		if (isEnoent(error) || hasFsCode(error, "EACCES")) return undefined;
		throw error;
	}
}

/** Removes an export temp file; a missing file is fine. */
export function removeHtmlExportTempFile(tempPath: string): void {
	try {
		fs.unlinkSync(tempPath);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
}
