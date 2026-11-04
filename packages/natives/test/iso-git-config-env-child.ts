import { IsoBackendKind, isoStart } from "../native/index.js";

const [repo, merged] = process.argv.slice(2);
if (!repo || !merged) {
	console.error("usage: iso-git-config-env-child.ts <repo> <merged>");
	process.exit(2);
}
await isoStart(IsoBackendKind.Rcopy, repo, merged);
