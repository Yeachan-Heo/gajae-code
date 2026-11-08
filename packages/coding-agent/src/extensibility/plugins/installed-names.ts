/**
 * Names of every npm-style plugin that is installed: the registry dependencies in
 * the plugins `package.json`, plus packages that `plugin link` symlinked in.
 *
 * Linked packages are tracked in the runtime lock file rather than in
 * `dependencies`, because bun cannot keep a symlink there (a `file:` spec is
 * copied, a `link:` spec fails to resolve). Every consumer that enumerates plugins
 * — the session loader, `plugin list`, `plugin doctor`, the customize doctor — must
 * go through this one function, or a linked plugin is visible to some and not others.
 */
export function installedPluginNames(
	dependencies: Record<string, string> | undefined,
	runtimeConfig: { plugins?: Record<string, { linked?: boolean } | undefined> },
): string[] {
	const names = new Set(Object.keys(dependencies ?? {}));
	for (const [name, state] of Object.entries(runtimeConfig.plugins ?? {})) {
		if (state?.linked === true) names.add(name);
	}
	return [...names];
}
