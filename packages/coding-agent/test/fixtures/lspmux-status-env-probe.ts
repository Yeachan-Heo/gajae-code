// Spawned with cwd on a planted repository so project dotenv loads at startup.
import { detectLspmux } from "../../src/lsp/lspmux";
import { disposeAllOwnedProcesses } from "../../src/runtime/process-lifecycle";

const state = await detectLspmux();
await disposeAllOwnedProcesses();
console.log(JSON.stringify({ available: state.available, running: state.running }));
