declare module "*.md" {
	const content: string;
	export default content;
}

declare module "*.txt" {
	const content: string;
	export default content;
}

declare module "*.py" {
	const content: string;
	export default content;
}

declare module "*.lark" {
	const content: string;
	export default content;
}

declare module "*.wasm" {
	const assetPath: string;
	export default assetPath;
}
// turndown-plugin-gfm has no published types
declare module "turndown-plugin-gfm" {
	import type TurndownService from "turndown";
	export const gfm: TurndownService.Plugin;
	export const tables: TurndownService.Plugin;
	export const strikethrough: TurndownService.Plugin;
	export const taskListItems: TurndownService.Plugin;
}
