import * as os from "node:os";
import * as path from "node:path";
import { prepareDesktopEnvironment } from "./environment-policy";

// First import of the process entrypoint, before the SDK captures discovery roots.
// Shared installation is the default; GJC_DESKTOP_ISOLATED=1 selects hermetic QA roots.
const dataDir = path.resolve(
	process.env.GJC_DESKTOP_DATA_DIR || path.join(os.homedir(), "Library", "Application Support", "Gajae Code Desktop"),
);
prepareDesktopEnvironment(process.env, dataDir);
