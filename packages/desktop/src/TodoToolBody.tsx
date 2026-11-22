import type { ToolCallBodyProps } from "./ToolCallCard";

/** Expanded body of a `todo_write` card. It shows the generic output. */
export function TodoToolBody({ output }: ToolCallBodyProps) {
	return output;
}
