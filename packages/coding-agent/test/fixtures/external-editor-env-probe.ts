// Prints the external editor command resolved in this process. Spawned with a
// controlled cwd so the caller can plant a project `.env`, which is parsed at
// module load from `process.cwd()`.
import { getEditorCommand } from "../../src/utils/external-editor";

console.log(JSON.stringify({ editor: getEditorCommand() ?? null }));
