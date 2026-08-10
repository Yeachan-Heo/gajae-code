import * as fs from "node:fs/promises";

if (process.argv[2] === "--child") {
	setInterval(() => {}, 1_000);
} else {
	const childPidFile = process.argv[2];
	const rootPidFile = process.argv[3];
	if (!childPidFile) throw new Error("Missing child pid file path");
	// Report the root pid first so readiness is observable even if the
	// grandchild spawn below never lands (fail-fast diagnostic, not a hang).
	const rootTemporaryPath = `${rootPidFile}.tmp`;
	await Bun.write(rootTemporaryPath, String(process.pid));
	await fs.rename(rootTemporaryPath, rootPidFile);
	const child = Bun.spawn([process.execPath, import.meta.path, "--child"], {
		stdout: "ignore",
		stderr: "ignore",
	});
	const childTemporaryPath = `${childPidFile}.tmp`;
	await Bun.write(childTemporaryPath, String(child.pid));
	await fs.rename(childTemporaryPath, childPidFile);
	setInterval(() => {}, 1_000);
}
