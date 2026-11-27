import * as fs from "node:fs";
import * as path from "node:path";
import { verifyOwnerOnlyPathSecurity } from "@gajae-code/natives";
import { prepareManagedDirectoryRoot } from "../session/internal/managed-session-storage";
import { assertNoLinkedComponent } from "./owner-lifecycle-path";

/**
 * Create or accept a managed owner lifecycle root for a launch. An existing root
 * must already be private: it is verified, never repaired. A missing root and its
 * missing ancestors are created owner-only, and the result is verified natively.
 * Throws without naming the path; callers report their own refusal code.
 */
export function prepareOwnerLifecycleRootSync(root: string): void {
	const target = path.resolve(root);
	assertNoLinkedComponent(target);
	let exists = false;
	try {
		fs.lstatSync(target);
		exists = true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (exists && !verifyOwnerOnlyPathSecurity(target, "directory").ok) throw new Error("owner_lifecycle_root_unsafe");
	prepareManagedDirectoryRoot(target);
	if (!verifyOwnerOnlyPathSecurity(target, "directory").ok) throw new Error("owner_lifecycle_root_unsafe");
}
