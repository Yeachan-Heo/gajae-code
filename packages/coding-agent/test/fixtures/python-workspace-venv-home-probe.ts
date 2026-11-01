import { Settings } from "@gajae-code/coding-agent/config/settings";
import { pythonBackend } from "@gajae-code/coding-agent/eval";
import { checkPythonKernelAvailability } from "@gajae-code/coding-agent/eval/py/kernel";
import type { ToolSession } from "@gajae-code/coding-agent/tools";
import { resetShellConfigCache } from "@gajae-code/utils/shell-config";

const cwd = process.argv[2];
if (!cwd) {
	console.error("cwd required");
	process.exit(2);
}
for (const key of [
	"VIRTUAL_ENV",
	"CONDA_PREFIX",
	"NODE_ENV",
	"BUN_ENV",
	"GJC_PYTHON_SKIP_CHECK",
	"PI_PYTHON_SKIP_CHECK",
]) {
	delete Bun.env[key];
}
resetShellConfigCache();
const settings = Settings.isolated();
const session = { cwd, hasUI: false, settings } as ToolSession;
await pythonBackend.isAvailable(session);
const availability = await checkPythonKernelAvailability(cwd, undefined, undefined, settings);
console.log(JSON.stringify({ ok: availability.ok, pythonPath: availability.pythonPath ?? null }));
