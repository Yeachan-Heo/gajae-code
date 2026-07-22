import * as path from "node:path";

const INDEX_ASSET = "index.html";
const UNSAFE_ARCHIVE_NAME = /[\u0000-\u001f\u007f%?#]/u;
const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:\//;

const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
	".css": "text/css; charset=utf-8",
	".gif": "image/gif",
	".html": "text/html; charset=utf-8",
	".ico": "image/x-icon",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".png": "image/png",
	".svg": "image/svg+xml",
	".ttf": "font/ttf",
	".webp": "image/webp",
	".woff": "font/woff",
	".woff2": "font/woff2",
});

function normalizeArchiveName(archiveName: string): string {
	const normalized = archiveName.normalize("NFC");
	const segments = normalized.split("/");
	if (
		!normalized ||
		normalized.startsWith("/") ||
		WINDOWS_ABSOLUTE_PATH.test(normalized) ||
		normalized.includes("\\") ||
		UNSAFE_ARCHIVE_NAME.test(normalized) ||
		segments.some(segment => !segment || segment === "." || segment === "..")
	) {
		throw new Error(`Unsafe compiled stats client archive entry: ${JSON.stringify(archiveName)}`);
	}
	return normalized;
}

function contentType(assetName: string): string {
	return CONTENT_TYPES[path.posix.extname(assetName).toLowerCase()] ?? "application/octet-stream";
}

async function parseArchive(archiveBytes: Uint8Array): Promise<ReadonlyMap<string, Blob>> {
	const files = await new Bun.Archive(archiveBytes).files();
	const assets = new Map<string, Blob>();
	for (const [archiveName, file] of files) {
		const assetName = normalizeArchiveName(archiveName);
		if (assets.has(assetName)) {
			throw new Error(`Duplicate compiled stats client archive entry: ${JSON.stringify(assetName)}`);
		}
		assets.set(assetName, new Blob([file], { type: contentType(assetName) }));
	}
	if (!assets.has(INDEX_ASSET)) {
		throw new Error("Compiled stats client archive is missing index.html");
	}
	return assets;
}

function responseForPath(assets: ReadonlyMap<string, Blob>, requestPath: string): Response {
	const assetName = requestPath === "/" ? INDEX_ASSET : requestPath.replace(/^\//, "");
	const asset = assets.get(assetName);
	if (asset) return new Response(asset);
	return new Response(assets.get(INDEX_ASSET));
}

export function createCompiledClientAssetHandler(
	loadArchiveBytes: () => Uint8Array | null | Promise<Uint8Array | null>,
): { response(requestPath: string): Promise<Response> } {
	let initialization: Promise<ReadonlyMap<string, Blob>> | null = null;

	async function getAssets(): Promise<ReadonlyMap<string, Blob>> {
		if (initialization) return await initialization;
		const attempt = (async () => {
			const archiveBytes = await loadArchiveBytes();
			if (!archiveBytes) {
				throw new Error("Compiled stats client bundle missing. Rebuild binary with embedded stats assets.");
			}
			return await parseArchive(archiveBytes);
		})();
		initialization = attempt;
		try {
			return await attempt;
		} catch (error) {
			if (initialization === attempt) initialization = null;
			throw error;
		}
	}

	return {
		async response(requestPath) {
			return responseForPath(await getAssets(), requestPath);
		},
	};
}
