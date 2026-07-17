import type { AuthCredentialSelector, AuthCredentialSelectorKind } from "@gajae-code/ai";

export interface CliCredentialSelector {
	provider?: string;
	selector: AuthCredentialSelector;
	raw: string;
}

const SELECTOR_KINDS = new Set<AuthCredentialSelectorKind>(["id", "email", "account", "project"]);

function parseSelectorBody(body: string): AuthCredentialSelector | undefined {
	const separator = body.indexOf(":");
	if (separator === -1) {
		if (body.includes("@")) return { kind: "email", value: body };
		return undefined;
	}
	const rawKind = body.slice(0, separator);
	const value = body.slice(separator + 1).trim();
	if (!SELECTOR_KINDS.has(rawKind as AuthCredentialSelectorKind) || value.length === 0) return undefined;
	return { kind: rawKind as AuthCredentialSelectorKind, value };
}

export function parseCliCredentialSelector(raw: string): CliCredentialSelector {
	const trimmed = raw.trim();
	const slash = trimmed.indexOf("/");
	const provider = slash === -1 ? undefined : trimmed.slice(0, slash).trim();
	const body = slash === -1 ? trimmed : trimmed.slice(slash + 1).trim();
	const selector = parseSelectorBody(body);
	if (!selector || provider === "") {
		throw new Error(
			`Invalid --credential selector "${raw}". Use email:name@example.com, id:123, account:<id>, project:<id>, or provider/email:name@example.com.`,
		);
	}
	return { ...(provider ? { provider } : {}), selector, raw };
}
