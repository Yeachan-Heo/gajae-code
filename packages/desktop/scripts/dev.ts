import * as url from "node:url";

const child = Bun.spawn([process.execPath, "x", "--no-install", "tauri", "dev", ...process.argv.slice(2)], {
	cwd: url.fileURLToPath(new URL("..", import.meta.url)),
	env: { ...Bun.env, GJC_DESKTOP_BUN: process.execPath },
	stdin: "inherit",
	stdout: "inherit",
	stderr: "inherit",
});
const stop = () => child.kill("SIGTERM");
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
process.exitCode = await child.exited;
