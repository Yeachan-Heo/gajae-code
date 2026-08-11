/**
 * Minimal plist writer for hermetic tests.
 *
 * The verifier script reads plists via Python's `plistlib.load`, which
 * transparently handles both binary and XML formats. We emit XML plists
 * (the simpler, human-readable format) so fixtures are inspectable and
 * require no native binary serializer.
 */
import * as fs from "node:fs";

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function isPlistDict(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function plistValueXml(value: unknown, indent: number): string {
	const pad = "\t".repeat(indent);
	if (typeof value === "string") {
		return `${pad}<string>${escapeXml(value)}</string>`;
	}
	if (typeof value === "number") {
		if (Number.isInteger(value)) {
			return `${pad}<integer>${value}</integer>`;
		}
		return `${pad}<real>${value}</real>`;
	}
	if (typeof value === "boolean") {
		return `${pad}<${value ? "true" : "false"}/>`;
	}
	if (Array.isArray(value)) {
		const items = value.map((v) => plistValueXml(v, indent + 1));
		return `${pad}<array>\n${items.join("\n")}\n${pad}</array>`;
	}
	if (isPlistDict(value)) {
		const entries = Object.entries(value).map(([k, v]) => {
			return `${pad}\t<key>${escapeXml(k)}</key>\n${plistValueXml(v, indent + 1)}`;
		});
		return `${pad}<dict>\n${entries.join("\n")}\n${pad}</dict>`;
	}
	throw new Error(`Unsupported plist value type: ${typeof value}`);
}

/** Write `data` as an XML plist to `filePath`. */
export function write(filePath: string, data: Record<string, unknown>): void {
	const body = plistValueXml(data, 0);
	const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${body}\n</plist>\n`;
	fs.writeFileSync(filePath, xml);
}
