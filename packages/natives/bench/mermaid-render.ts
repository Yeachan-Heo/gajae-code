// A/B adapter for Mermaid-to-ASCII conversion through the shared public utility entrypoint.
import { renderMermaidAscii } from "../../utils/src/mermaid-ascii";
import { runAbSuite } from "./ab-adapter";

const SMALL_FLOWCHART = `flowchart TD
  Request[Incoming request] --> Parse[Parse input]
  Parse --> Validate{Valid?}
  Validate -->|yes| Convert[Convert content]
  Validate -->|no| Reject[Return error]
  Convert --> Output[Build response]
  Reject --> Output`;

const LARGE_FLOWCHART = [
	"flowchart LR",
	...Array.from({ length: 20 }, (_, index) => `N${index}[Stage ${index}]`),
	...Array.from({ length: 19 }, (_, index) => `N${index} --> N${index + 1}`),
].join("\n");

await runAbSuite(
	"mermaid-render",
	[
		{
			id: "M01",
			run: async () => {
				const ascii = await renderMermaidAscii(SMALL_FLOWCHART);
				if (!ascii) throw new Error("Mermaid fixture produced no ASCII output");
			},
		},
		{
			id: "M02",
			run: async () => {
				const ascii = await renderMermaidAscii(LARGE_FLOWCHART);
				if (!ascii) throw new Error("Mermaid fixture produced no ASCII output");
			},
		},
	],
	100,
);
