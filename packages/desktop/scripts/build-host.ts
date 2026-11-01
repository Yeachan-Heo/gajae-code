import * as fs from "node:fs/promises";
import * as path from "node:path";
import { signMacOSBinary } from "../../../scripts/macos-code-signing";
import { buildCompileArgs, releaseEntrypoints } from "../../coding-agent/scripts/compile-args";

const root = path.resolve(import.meta.dir, "../../..");
const binaries = path.resolve(import.meta.dir, "../src-tauri/binaries");
if (process.platform !== "darwin" || process.arch !== "arm64") {
	throw new Error("Desktop packaging currently supports native macOS arm64 builds only.");
}
async function run(command: string[], env = Bun.env): Promise<void> {
	const child = Bun.spawn(command, { cwd: root, env, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
	const code = await child.exited;
	if (code !== 0) throw new Error(`${command[0]} failed with exit code ${code}`);
}
await fs.mkdir(binaries, { recursive: true });
const outputs = [
	{
		name: "gjc-desktop-host",
		// The host serves its own internal shell-worker modes before host setup.
		entrypoints: ["./packages/desktop-host/src/entry.ts", ...releaseEntrypoints.slice(1)],
	},
	// Workflow shell commands and task subprocesses need the real CLI, not a host
	// protocol process. Keep it app-local rather than installing into the user's PATH.
	{ name: "gjc", entrypoints: releaseEntrypoints },
];
try {
	await run([process.execPath, "--cwd=packages/stats", "scripts/generate-client-bundle.ts", "--generate"]);
	await run([process.execPath, "--cwd=packages/natives", "run", "embed:native"]);
	for (const binary of outputs) {
		const output = path.join(binaries, `${binary.name}-aarch64-apple-darwin`);
		const args = buildCompileArgs({
			root: ".",
			entrypoints: binary.entrypoints,
			outfile: output,
			target: "bun-darwin-arm64",
			defines: ['process.env.PI_COMPILED="true"', 'process.env.GJC_BUILD_CHANNEL="dev"'],
		});
		await run([process.execPath, ...args.slice(1)], { ...Bun.env, BUN_NO_CODESIGN_MACHO_BINARY: "1" });
		await signMacOSBinary(output, run);
	}
} finally {
	await run([process.execPath, "--cwd=packages/natives", "run", "embed:native", "--reset"]);
	await run([process.execPath, "--cwd=packages/stats", "scripts/generate-client-bundle.ts", "--reset"]);
}
