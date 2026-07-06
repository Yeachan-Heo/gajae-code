import process from "node:process";

interface GjcCommand {
	cmd: string;
	args: string[];
	shell: boolean;
}

const DEFAULT_CMD = process.platform === "win32" ? "gjc.cmd" : "gjc";
const DEFAULT_SHELL = process.platform === "win32";

export function resolveGjcCommand(): GjcCommand {
	const entry = process.argv[1];
	if (entry && (entry.endsWith(".ts") || entry.endsWith(".js"))) {
		return { cmd: process.execPath, args: [entry], shell: false };
	}

	return { cmd: DEFAULT_CMD, args: [], shell: DEFAULT_SHELL };
}
