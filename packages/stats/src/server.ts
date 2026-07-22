import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";
import {
	getBehaviorDashboardStats,
	getCostDashboardStats,
	getDashboardStats,
	getModelDashboardStats,
	getOverviewStats,
	getRecentErrors,
	getRecentRequests,
	getRequestDetails,
	getTotalMessageCount,
	syncAllSessions,
} from "./aggregator";
import { createCompiledClientAssetHandler } from "./compiled-client-assets";
import embeddedClientArchiveTxt from "./embedded-client.generated.txt";
import type { DashboardStats } from "./types";

const getEmbeddedClientArchive = (() => {
	const txt = embeddedClientArchiveTxt.replaceAll(/[\s\r\n]/g, "").trim();
	if (!txt) return null;
	return () => Buffer.from(txt, "base64");
})();

const CLIENT_DIR = path.join(import.meta.dir, "client");
const STATIC_DIR = path.join(import.meta.dir, "..", "dist", "client");
const IS_BUN_COMPILED =
	Bun.env.PI_COMPILED ||
	import.meta.url.includes("$bunfs") ||
	import.meta.url.includes("~BUN") ||
	import.meta.url.includes("%7EBUN");
const compiledClientAssets = createCompiledClientAssetHandler(() => getEmbeddedClientArchive?.() ?? null);

interface SyncResult {
	processed: number;
	files: number;
}

export interface StatsServerOptions {
	getDashboardStats?: (range?: string | null) => Promise<DashboardStats>;
	syncAllSessions?: () => Promise<SyncResult>;
	getTotalMessageCount?: () => Promise<number>;
}

interface ApiContext {
	getDashboardStats: (range?: string | null) => Promise<DashboardStats>;
	syncAllSessions: () => Promise<SyncResult>;
	getTotalMessageCount: () => Promise<number>;
	syncInProgress: boolean;
}

async function getLatestMtime(dir: string): Promise<number> {
	const entries = await fs.readdir(dir, { withFileTypes: true });

	const promises = [];
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			promises.push(getLatestMtime(fullPath));
		} else if (entry.isFile()) {
			promises.push(fs.stat(fullPath).then(stats => stats.mtimeMs));
		}
	}

	let latest = 0;
	await Promise.allSettled(promises).then(results => {
		for (const result of results) {
			if (result.status === "fulfilled") {
				latest = Math.max(latest, result.value);
			}
		}
	});
	return latest;
}

const ensureClientBuild = async () => {
	if (IS_BUN_COMPILED) return;
	const indexPath = path.join(STATIC_DIR, "index.html");
	const cssPath = path.join(STATIC_DIR, "styles.css");
	const clientSourceMtime = await getLatestMtime(CLIENT_DIR);
	const tailwindConfigPath = path.join(import.meta.dir, "..", "tailwind.config.js");
	let tailwindConfigMtime = 0;
	try {
		const tailwindConfigStats = await fs.stat(tailwindConfigPath);
		tailwindConfigMtime = tailwindConfigStats.mtimeMs;
	} catch {}
	const sourceMtime = Math.max(clientSourceMtime, tailwindConfigMtime);
	let shouldBuild = true;
	try {
		const [indexStats, cssStats] = await Promise.all([fs.stat(indexPath), fs.stat(cssPath)]);
		if (
			indexStats.isFile() &&
			cssStats.isFile() &&
			indexStats.mtimeMs >= sourceMtime &&
			cssStats.mtimeMs >= sourceMtime
		) {
			shouldBuild = false;
		}
	} catch {
		shouldBuild = true;
	}

	if (!shouldBuild) return;

	await fs.rm(STATIC_DIR, { recursive: true, force: true });

	console.log("Building stats client...");
	const packageRoot = path.join(import.meta.dir, "..");
	const buildResult = await $`bun run build.ts`.cwd(packageRoot).quiet().nothrow();
	if (buildResult.exitCode !== 0) {
		const output = buildResult.text().trim();
		const details = output ? `\n${output}` : "";
		throw new Error(`Failed to build stats client (exit ${buildResult.exitCode})${details}`);
	}

	const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AI Usage Statistics</title>
    <link rel="stylesheet" href="styles.css">
</head>
<body>
    <div id="root"></div>
    <script src="index.js" type="module"></script>
</body>
</html>`;

	await Bun.write(path.join(STATIC_DIR, "index.html"), indexHtml);
};

/**
 * Handle API requests.
 */
async function handleApi(req: Request, context: ApiContext): Promise<Response> {
	const url = new URL(req.url);
	const path = url.pathname;

	// Stats reads are DB-only; explicit /api/sync does the expensive session scan.
	const range = url.searchParams.get("range");

	if (path === "/api/stats") {
		const stats = await context.getDashboardStats(range);
		return Response.json(stats);
	}

	if (path === "/api/stats/overview") {
		const stats = await getOverviewStats(range);
		return Response.json(stats);
	}

	if (path === "/api/stats/model-dashboard") {
		const stats = await getModelDashboardStats(range);
		return Response.json(stats);
	}

	if (path === "/api/stats/costs") {
		const stats = await getCostDashboardStats(range);
		return Response.json(stats);
	}

	if (path === "/api/stats/behavior") {
		const stats = await getBehaviorDashboardStats(range);
		return Response.json(stats);
	}

	if (path === "/api/stats/recent") {
		const limit = url.searchParams.get("limit");
		const stats = await getRecentRequests(limit ? parseInt(limit, 10) : undefined);
		return Response.json(stats);
	}

	if (path === "/api/stats/errors") {
		const limit = url.searchParams.get("limit");
		const stats = await getRecentErrors(limit ? parseInt(limit, 10) : undefined);
		return Response.json(stats);
	}

	if (path === "/api/stats/models") {
		const stats = await context.getDashboardStats(range);
		return Response.json(stats.byModel);
	}

	if (path === "/api/stats/folders") {
		const stats = await context.getDashboardStats(range);
		return Response.json(stats.byFolder);
	}

	if (path === "/api/stats/timeseries") {
		const stats = await context.getDashboardStats(range);
		return Response.json(stats.timeSeries);
	}

	if (path.startsWith("/api/request/")) {
		const id = path.split("/").pop();
		if (!id) return new Response("Bad Request", { status: 400 });
		const details = await getRequestDetails(parseInt(id, 10));
		if (!details) return new Response("Not Found", { status: 404 });
		return Response.json(details);
	}

	if (path === "/api/sync") {
		if (context.syncInProgress) {
			return Response.json({ error: "Sync already in progress" }, { status: 409 });
		}
		context.syncInProgress = true;
		try {
			const result = await context.syncAllSessions();
			const count = await context.getTotalMessageCount();
			return Response.json({ ...result, totalMessages: count });
		} finally {
			context.syncInProgress = false;
		}
	}

	return new Response("Not Found", { status: 404 });
}

function forbidden(): Response {
	return new Response("Forbidden", { status: 403 });
}

function methodNotAllowed(allowedMethod: "GET" | "POST"): Response {
	return new Response("Method Not Allowed", { status: 405, headers: { Allow: allowedMethod } });
}

function validateApiRequest(req: Request, url: URL, boundPort: number): Response | null {
	const authority = req.headers.get("Host");
	const allowedAuthorities =
		boundPort === 80
			? new Set(["localhost", "localhost:80", "127.0.0.1", "127.0.0.1:80"])
			: new Set([`localhost:${boundPort}`, `127.0.0.1:${boundPort}`]);
	if (!authority || !allowedAuthorities.has(authority)) return forbidden();

	if (url.protocol !== "http:" || (url.hostname !== "localhost" && url.hostname !== "127.0.0.1")) {
		return forbidden();
	}

	const requestPort = url.port ? Number.parseInt(url.port, 10) : 80;
	if (requestPort !== boundPort) return forbidden();

	const origin = req.headers.get("Origin");
	if (origin !== null) {
		try {
			const parsedOrigin = new URL(origin);
			if (parsedOrigin.origin !== origin || origin !== url.origin) return forbidden();
		} catch {
			return forbidden();
		}
	}

	const allowedMethod = url.pathname === "/api/sync" ? "POST" : "GET";
	if (req.method !== allowedMethod) return methodNotAllowed(allowedMethod);
	if (url.pathname === "/api/sync" && origin === null) return forbidden();

	return null;
}

/**
 * Handle static file requests.
 */
async function handleStatic(requestPath: string): Promise<Response> {
	if (IS_BUN_COMPILED) return await compiledClientAssets.response(requestPath);

	const filePath = requestPath === "/" ? "/index.html" : requestPath;
	const fullPath = path.join(STATIC_DIR, filePath);

	const file = Bun.file(fullPath);
	if (await file.exists()) {
		return new Response(file);
	}

	// SPA fallback
	const index = Bun.file(path.join(STATIC_DIR, "index.html"));
	if (await index.exists()) {
		return new Response(index);
	}

	return new Response("Not Found", { status: 404 });
}

/**
 * Start the HTTP server.
 */
export async function startServer(
	port = 3847,
	options: StatsServerOptions = {},
): Promise<{ port: number; stop: () => void }> {
	await ensureClientBuild();
	const apiContext: ApiContext = {
		getDashboardStats: options.getDashboardStats ?? getDashboardStats,
		syncAllSessions: options.syncAllSessions ?? syncAllSessions,
		getTotalMessageCount: options.getTotalMessageCount ?? getTotalMessageCount,
		syncInProgress: false,
	};

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port,
		async fetch(req) {
			let url: URL;
			try {
				url = new URL(req.url);
			} catch {
				return forbidden();
			}
			const path = url.pathname;

			if (path.startsWith("/api/")) {
				const policyResponse = validateApiRequest(req, url, server.port ?? port);
				if (policyResponse) return policyResponse;
			}

			try {
				if (path.startsWith("/api/")) {
					return await handleApi(req, apiContext);
				}
				return await handleStatic(path);
			} catch (error) {
				console.error("Server error:", error);
				return Response.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
			}
		},
	});

	return {
		port: server.port ?? port,
		stop: () => server.stop(),
	};
}
