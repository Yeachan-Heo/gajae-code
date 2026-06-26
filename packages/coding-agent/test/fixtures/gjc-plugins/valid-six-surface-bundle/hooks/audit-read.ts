// Side-effecting on import: proves the compiler/installer never imports plugin code.
import * as fs from "node:fs";

const sentinel = process.env.GJC_TEST_IMPORT_SENTINEL;
if (sentinel) fs.writeFileSync(sentinel, "imported-hook");

export default function registerAuditRead(api: any) {
	api.on("tool_call", () => ({}));
}
