// Run under `bun --preload scripts/test-preload.ts`. Prints, as one JSON line,
// the HOME each spawn path hands a child, plus the C environ's HOME, which
// native spawns (portable-pty) snapshot.
import { CString, dlopen, FFIType } from "bun:ffi";
import * as childProcess from "node:child_process";
import { $ } from "bun";

const probe = ["sh", "-c", 'printf %s "$HOME"'];
const libc = dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", {
	getenv: { args: [FFIType.cstring], returns: FFIType.ptr },
});
const nativePointer = libc.symbols.getenv(Buffer.from("HOME\0"));
const spawned = Bun.spawn(probe, { stdout: "pipe" });

console.log(
	JSON.stringify({
		processEnv: process.env.HOME,
		bunSpawn: (await new Response(spawned.stdout).text()).trim(),
		bunSpawnSync: Bun.spawnSync({ cmd: probe }).stdout.toString(),
		bunSpawnSyncWithOptions: Bun.spawnSync(probe, { stdout: "pipe" }).stdout.toString(),
		childProcess: childProcess.execFileSync(probe[0]!, probe.slice(1)).toString(),
		bunShell: (await $`sh -c ${probe[2]!}`.text()).trim(),
		nativeEnviron: nativePointer === null ? null : new CString(nativePointer).toString(),
		explicitEnv: Bun.spawnSync(probe, { env: { PATH: process.env.PATH, HOME: "/explicit-home" } }).stdout.toString(),
	}),
);
