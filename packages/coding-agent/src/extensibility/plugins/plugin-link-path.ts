import path from "node:path";

/** Resolve a package.json name under the plugins node_modules root, or throw. */
export function resolvePluginLinkPath(root: string, name: string): string {
	const base = path.resolve(root);
	const destination = path.resolve(base, name);
	const relative = path.relative(base, destination);
	if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`package.json name is not a safe plugin link path: ${name}`);
	}
	return destination;
}
