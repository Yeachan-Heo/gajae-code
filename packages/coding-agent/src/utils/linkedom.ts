type LinkedomModule = typeof import("linkedom");

type ParseHtml = LinkedomModule["parseHTML"];

let parseHtml: ParseHtml | undefined;
let linkedomImport: Promise<LinkedomModule> | undefined;

export async function parseHtmlLazy(markup: string): Promise<ReturnType<ParseHtml>> {
	if (!parseHtml) {
		linkedomImport ??= import("linkedom");
		parseHtml = (await linkedomImport).parseHTML;
	}
	return parseHtml(markup);
}
