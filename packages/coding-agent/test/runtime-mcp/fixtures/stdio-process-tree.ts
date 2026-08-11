import * as fs from "node:fs/promises";

if (process.argv[2] === "--child") {
	setInterval(() => {}, 1_000);
} else {
	const pidFile = process.argv[2];
	if (!pidFile) throw new Error("Missing pid file path");
	const child = Bun.spawn([process.execPath, import.meta.path, "--child"], {
		stdout: "ignore",
		stderr: "ignore",
	});
	const temporaryPath = `${pidFile}.tmp`;
	await Bun.write(temporaryPath, String(child.pid));
	await fs.rename(temporaryPath, pidFile);
	setInterval(() => {}, 1_000);
}
