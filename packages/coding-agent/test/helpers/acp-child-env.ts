import * as path from "node:path";

/** Hermetic child-process environment rooted at an isolated fixture HOME. */
export function buildChildEnv(root: string): Record<string, string> {
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: root,
		TMPDIR: path.join(root, "tmp"),
		XDG_DATA_HOME: path.join(root, ".local", "share"),
		XDG_CONFIG_HOME: path.join(root, ".config"),
		XDG_STATE_HOME: path.join(root, ".local", "state"),
		XDG_CACHE_HOME: path.join(root, ".cache"),
		XDG_RUNTIME_DIR: path.join(root, ".run"),
		GJC_CODING_AGENT_DIR: path.join(root, "agent"),
		PI_CODING_AGENT_DIR: path.join(root, "agent"),
		PI_NO_TITLE: "1",
		NO_COLOR: "1",
	};
	for (const key of ["LANG", "LC_ALL", "TZ"] as const) {
		const value = process.env[key];
		if (value !== undefined && value !== "") env[key] = value;
	}
	return env;
}
