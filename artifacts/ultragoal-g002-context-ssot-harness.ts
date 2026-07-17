// Context-usage SSOT dogfood harness (G002, fail-closed): drive a real
// provider turn through the source-checkout SDK and assert that
// AgentSession.getContextUsage() upholds the v0.10.1 SSOT contract:
//   - before any provider turn: heuristic fallback (no anchor exists yet),
//   - after a successful turn: provider-anchored snapshot with positive
//     tokens, a positive context window, and a sane percent.
// Any violation throws, so the process exits nonzero on regression.
import { createAgentSession } from "@gajae-code/coding-agent/sdk";

function assert(condition: boolean, label: string): void {
	if (!condition) throw new Error(`SSOT invariant violated: ${label}`);
}

const { session } = await createAgentSession({
	noSession: true,
	toolNames: [],
});

try {
	const before = session.getContextUsage();
	assert(before !== undefined, "before snapshot exists");
	assert(before?.source === "heuristic", `before.source is heuristic (got ${before?.source})`);

	await session.prompt("Reply with exactly: SSOT-OK");

	const after = session.getContextUsage();
	const text = session.messages
		.filter(m => m.role === "assistant")
		.flatMap(m => (Array.isArray(m.content) ? m.content : []))
		.filter(b => b.type === "text")
		.map(b => b.text)
		.join("");

	assert(text.includes("SSOT-OK"), "assistant reply contains the marker");
	assert(after !== undefined, "after snapshot exists");
	assert(after?.source === "provider_anchor", `after.source is provider_anchor (got ${after?.source})`);
	assert((after?.tokens ?? 0) > 0, `after.tokens positive (got ${after?.tokens})`);
	assert((after?.contextWindow ?? 0) > 0, `after.contextWindow positive (got ${after?.contextWindow})`);
	assert(
		after?.percent !== null && after !== undefined && after.percent > 0 && after.percent < 100,
		`after.percent sane (got ${after?.percent})`,
	);

	console.log(
		JSON.stringify(
			{
				pass: true,
				before: { source: before?.source, tokens: before?.tokens },
				after: {
					source: after?.source,
					tokens: after?.tokens,
					contextWindow: after?.contextWindow,
					percent: after?.percent,
				},
			},
			null,
			2,
		),
	);
} finally {
	await session.dispose();
}
process.exit(0);
