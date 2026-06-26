// Side-effecting on import: proves the compiler/installer never imports plugin code.
// (Runtime activation DOES import this, which is expected.)
import * as fs from "node:fs";

const sentinel = process.env.GJC_TEST_IMPORT_SENTINEL;
if (sentinel) fs.writeFileSync(sentinel, "imported-tool");

export default function domainNote(pi: any) {
	return {
		name: "domain_note",
		label: "Domain Note",
		description: "Write a domain-scoped note",
		parameters: pi.typebox.Type.Object({ note: pi.typebox.Type.String() }),
		async execute(_toolCallId: string, params: { note?: string }) {
			return { content: [{ type: "text", text: String(params.note ?? "ok") }] };
		},
	};
}
