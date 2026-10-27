/**
 * Recursively substitute ${ANTHROPIC_MODEL_PLUGIN_ROOT} and ${GJC_PLUGIN_ROOT}
 * with the actual plugin root path in strings, arrays, and plain objects.
 */
// Use concatenation to avoid noTemplateCurlyInString lint rule on literal placeholder names
const CLAUDE_VAR = "$" + "{CLAUDE_PLUGIN_ROOT}";
const GJC_VAR = "$" + "{GJC_PLUGIN_ROOT}";

export function substitutePluginRoot<T>(value: T, rootPath: string): T {
	if (typeof value === "string") {
		// Function replacers: a string replacement would expand `$&`, `$$`, `` $` ``
		// and `$'` inside the install path instead of inserting it verbatim.
		return value.replaceAll(CLAUDE_VAR, () => rootPath).replaceAll(GJC_VAR, () => rootPath) as T;
	}
	if (Array.isArray(value)) {
		return value.map(v => substitutePluginRoot(v, rootPath)) as T;
	}
	if (value && typeof value === "object") {
		const result: Record<string, unknown> = Object.create(null);
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			Object.defineProperty(result, k, {
				value: substitutePluginRoot(v, rootPath),
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
		return result as T;
	}
	return value;
}
