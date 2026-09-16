/**
 * Lossless JSON policy-field editing for `.gjc/mcp.json`.
 *
 * Uses `jsonc-parser`'s AST/edit API instead of `JSON.parse`/`JSON.stringify`
 * so only the selected `mcpServers.<name>.<field>` token is rewritten. Every
 * other token in the document (unrelated fields, large
 * integer literals, `-0`, secrets) survives untouched. `JSON.parse` would
 * silently normalize those values and collapse duplicate keys to "last one
 * wins", hiding a real authoring bug — so duplicate keys along the selected
 * path are rejected instead of being silently resolved.
 */
import {
	applyEdits,
	findNodeAtLocation,
	getNodeValue,
	modify,
	type Node,
	type ParseError,
	parseTree,
} from "jsonc-parser";

export type McpBooleanField = "autoload" | "enabled";

export type McpFieldReadResult =
	| { readonly status: "ok"; readonly exists: boolean; readonly value: unknown }
	| { readonly status: "duplicate_key"; readonly path: string }
	| { readonly status: "malformed" }
	| { readonly status: "not_found" };

export type McpFieldWriteResult =
	| { readonly status: "ok"; readonly text: string; readonly beforeValue: unknown }
	| { readonly status: "duplicate_key"; readonly path: string }
	| { readonly status: "malformed" }
	| { readonly status: "not_found" };

/**
 * Detect a duplicate property name at each level while descending the given
 * path. Scoped to the selected policy path only — this is not a whole-document
 * scan; it visits only the objects on the selected path.
 */
export function findDuplicateKeyAlongPath(root: Node, path: readonly string[]): string | undefined {
	let node: Node | undefined = root;
	for (let depth = 0; depth < path.length; depth++) {
		if (node?.type !== "object" || !node.children) return undefined;
		let matched: Node | undefined;
		for (const property of node.children) {
			const keyNode = property.children?.[0];
			if (!keyNode || keyNode.value !== path[depth]) continue;
			if (matched) return path.slice(0, depth + 1).join(".");
			matched = property;
		}
		node = matched?.children?.[1];
	}
	return undefined;
}

function parsePolicyTree(raw: string): Node | undefined {
	const errors: ParseError[] = [];
	const root = parseTree(raw, errors, { disallowComments: true, allowTrailingComma: false });
	return root && errors.length === 0 ? root : undefined;
}

/** Read one selected `mcpServers.<name>.<field>` boolean without collapsing duplicate keys. */
export function readMcpBooleanField(raw: string, serverName: string, field: McpBooleanField): McpFieldReadResult {
	const root = parsePolicyTree(raw);
	if (!root) return { status: "malformed" };
	const path = ["mcpServers", serverName, field];
	const duplicate = findDuplicateKeyAlongPath(root, path);
	if (duplicate) return { status: "duplicate_key", path: duplicate };
	const serverNode = findNodeAtLocation(root, ["mcpServers", serverName]);
	if (serverNode?.type !== "object") return { status: "not_found" };
	const fieldNode = findNodeAtLocation(root, path);
	return { status: "ok", exists: fieldNode !== undefined, value: fieldNode ? getNodeValue(fieldNode) : undefined };
}

/**
 * Compute the lossless text after setting `mcpServers.<name>.<field>` to
 * `value`, or removing it when `value` is `undefined` (used to restore an
 * originally-absent field). Only the selected token's edit range changes.
 */
export function writeMcpBooleanField(
	raw: string,
	serverName: string,
	field: McpBooleanField,
	/**
	 * The new field value. `undefined` removes the key, restoring an
	 * originally-absent field on rollback. A rollback may also need to restore
	 * an originally-invalid non-boolean scalar, so this intentionally accepts
	 * any JSON value rather than only `boolean`.
	 */
	value: unknown,
): McpFieldWriteResult {
	const before = readMcpBooleanField(raw, serverName, field);
	if (before.status !== "ok") return before;
	const edits = modify(raw, ["mcpServers", serverName, field], value, {});
	return { status: "ok", text: applyEdits(raw, edits), beforeValue: before.value };
}

/** Restore the original token, rather than reserializing its possibly-invalid value. */
export function restoreMcpBooleanField(
	raw: string,
	original: string,
	serverName: string,
	field: McpBooleanField,
): McpFieldWriteResult {
	const current = readMcpBooleanField(raw, serverName, field);
	const before = readMcpBooleanField(original, serverName, field);
	if (current.status !== "ok") return current;
	if (before.status !== "ok") return before;
	if (!before.exists) return writeMcpBooleanField(raw, serverName, field, undefined);
	const currentTree = parsePolicyTree(raw);
	const originalTree = parsePolicyTree(original);
	if (!currentTree || !originalTree) return { status: "malformed" };
	const selected = ["mcpServers", serverName, field];
	const currentNode = findNodeAtLocation(currentTree, selected);
	const originalNode = findNodeAtLocation(originalTree, selected);
	if (!currentNode || !originalNode) return { status: "not_found" };
	return {
		status: "ok",
		beforeValue: current.value,
		text: applyEdits(raw, [
			{
				offset: currentNode.offset,
				length: currentNode.length,
				content: original.slice(originalNode.offset, originalNode.offset + originalNode.length),
			},
		]),
	};
}
