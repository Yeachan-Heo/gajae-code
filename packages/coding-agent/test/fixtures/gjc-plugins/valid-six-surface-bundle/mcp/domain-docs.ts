// Bundled stdio MCP server stub for fixture purposes (never imported at compile).
import * as fs from "node:fs";

const sentinel = process.env.GJC_TEST_IMPORT_SENTINEL;
if (sentinel) fs.writeFileSync(sentinel, "imported-mcp");
