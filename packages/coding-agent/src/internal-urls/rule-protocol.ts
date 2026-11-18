/**
 * Protocol handler for rule:// URLs.
 *
 * URL forms:
 * - rule://<name> - Reads rule content
 */
import { getActiveRules } from "../capability/rule";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext } from "./types";

export class RuleProtocolHandler implements ProtocolHandler {
	readonly scheme = "rule";
	readonly immutable = true;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		// A caller that supplies a rule scope owns it: an empty list means no rule
		// is visible, not "read another session's registry". Callers that omit the
		// property (the reader route) keep the process-global snapshot.
		const rules = context?.rules ?? getActiveRules();

		const ruleName = url.rawHost || url.hostname;
		if (!ruleName) {
			throw new Error("rule:// URL requires a rule name: rule://<name>");
		}

		const rule = rules.find(r => r.name === ruleName);
		if (!rule) {
			const available = rules.map(r => r.name);
			const availableStr = available.length > 0 ? available.join(", ") : "none";
			throw new Error(`Unknown rule: ${ruleName}\nAvailable: ${availableStr}`);
		}

		return {
			url: url.href,
			content: rule.content,
			contentType: "text/markdown",
			size: Buffer.byteLength(rule.content, "utf-8"),
			sourcePath: rule.path,
			notes: [],
		};
	}
}
