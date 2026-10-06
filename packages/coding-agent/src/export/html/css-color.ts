const SAFE_CSS_COLOR =
	/^(?:#[0-9a-fA-F]{3,8}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)|rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(?:0|1|0?\.\d+)\s*\))$/;

/** Keep a theme color that is safe to place in a `<style>` block. */
export function cssColorOrFallback(value: string | undefined, fallback: string): string {
	const trimmed = value?.trim();
	if (trimmed && SAFE_CSS_COLOR.test(trimmed)) return trimmed;
	return fallback;
}
