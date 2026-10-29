import * as fs from "node:fs";
import * as path from "node:path";
import { verifyOwnerOnlyPathSecurity } from "@gajae-code/natives";
import { prepareManagedDirectoryRoot } from "../session/internal/managed-session-storage";

/**
 * The spelling the native no-follow walk inspects: on macOS it reads the system
 * aliases `/var`, `/tmp` and `/etc` as their `/private` targets, so those are the
 * only links it accepts.
 */
function nativeWalkPath(target: string): string {
	if (process.platform !== "darwin") return target;
	for (const alias of ["/var", "/tmp", "/etc"]) {
		if (target === alias || target.startsWith(`${alias}/`)) return `/private${target}`;
	}
	return target;
}

/**
 * Refuse a path whose existing components are not all real directories, checked
 * from the filesystem root with `lstat`. The native verification that follows
 * preparation refuses the same links; checking first means nothing is created
 * through a link (for example an empty `owner-lifecycle` inside a linked session
 * tail) before that refusal. The walk stops at the first missing component, which
 * preparation then creates.
 */
function assertNoLinkedComponent(target: string): void {
	const walked = nativeWalkPath(target);
	let current = path.parse(walked).root;
	for (const component of walked.slice(current.length).split(path.sep)) {
		if (component === "") continue;
		current = path.join(current, component);
		let stat: fs.Stats;
		try {
			stat = fs.lstatSync(current);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		if (!stat.isDirectory()) throw new Error("owner_lifecycle_root_unsafe");
	}
}

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
