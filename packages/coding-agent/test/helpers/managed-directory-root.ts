import * as fs from "node:fs";
import * as path from "node:path";
import type { ManagedDirectoryRoot } from "../../src/session/internal/managed-session-storage";

/** Read the dev/inode identity a managed-directory API should derive for a fixture path. */
export function expectedDirectoryRoot(pathname: string): ManagedDirectoryRoot {
	const stat = fs.lstatSync(pathname, { bigint: true });
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("fixture_directory_invalid");
	return {
		canonicalPath: path.resolve(pathname),
		dev: BigInt.asUintN(64, stat.dev),
		ino: BigInt.asUintN(64, stat.ino),
	};
}
