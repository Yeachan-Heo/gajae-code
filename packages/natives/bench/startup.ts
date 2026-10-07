// A/B adapter: cold CLI startup and native addon initialization per process.
import { resolve } from "node:path";
import { runAbSuite } from "./ab-adapter";

const root = resolve(import.meta.dir, "../../..");
const env = { ...Bun.env, GJC_NO_UPDATE_CHECK: "1" };

async function spawnAndCheck(cmd: string[]): Promise<void> {
	const child = Bun.spawn(cmd, {
		cwd: root,
		env,
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
	});
	const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
	if (exitCode !== 0) {
		throw new Error(`${cmd.join(" ")} exited with code ${exitCode}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
	}
}

const cli = [process.execPath, "packages/coding-agent/src/cli.ts"];

await runAbSuite(
	"startup",
	[
		{
			id: "S01",
			run: () => spawnAndCheck([...cli, "--version"]),
			// Each sample starts a fresh process; extra warmup spawns do not warm that process.
			warmup: 0,
		},
		{
			id: "S02",
			run: () => spawnAndCheck([...cli, "--help"]),
			warmup: 0,
		},
		{
			id: "S03",
			run: () =>
				spawnAndCheck([
					process.execPath,
					"-e",
					`const native = await import("./packages/natives/native/index.js");
if (native.visibleWidth("native", 4) !== 6) throw new Error("unexpected visible width");`,
				]),
			warmup: 0,
		},
	],
	10,
);
