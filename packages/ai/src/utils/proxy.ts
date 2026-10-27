import * as net from "node:net";
import * as tls from "node:tls";
import { loadedProjectEnvSnapshot } from "@gajae-code/utils";
import { canonicalEnvKey } from "@gajae-code/utils/env-file";

export interface ProxyConnectOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

const CONNECT_HEADER_LIMIT = 64 * 1024;
const CLOUD_METADATA_HOSTS: Record<string, true> = {
	metadata: true,
	"metadata.aws": true,
	"metadata.aws.internal": true,
	"metadata.azure": true,
	"metadata.azure.com": true,
	"metadata.azure.internal": true,
	"metadata.google": true,
	"metadata.google.internal": true,
	"metadata.oraclecloud.com": true,
	"instance-data": true,
	"instance-data.ec2.internal": true,
	"100.100.100.100": true,
	"100.100.100.200": true,
	"169.254.169.254": true,
};

class ProxyTransportError extends Error {
	readonly name = "ProxyTransportError";
}

function transportError(message: string): ProxyTransportError {
	return new ProxyTransportError(message);
}

function normalizeProvider(provider: string): string {
	return provider
		.trim()
		.toUpperCase()
		.replace(/[^A-Z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
}

function firstEnvValue(...names: string[]): string | undefined {
	for (const name of names) {
		const value = process.env[name];
		if (value?.trim()) return value.trim();
	}
	return undefined;
}

// This module may load lazily after --worktree changes cwd. Use the shared
// process-startup snapshot captured by @gajae-code/utils before that transition.
// A dynamic declaration is refused, and a runtime value equal to the declared
// text is ambiguous. A distinct shell value remains a selector.
const projectProxyEnv = loadedProjectEnvSnapshot();

function projectSuppliedProxy(name: string, runtime: string): boolean {
	const key = canonicalEnvKey(name);
	const declared = projectProxyEnv.values[key];
	if (declared === undefined && !projectProxyEnv.dynamic.has(key)) return false;
	return projectProxyEnv.dynamic.has(key) || declared === runtime || declared === runtime.trim();
}

function trustedProxyEnvValue(name: string): string | undefined {
	const runtime = process.env[name];
	if (!runtime?.trim() || projectSuppliedProxy(name, runtime)) return undefined;
	return runtime.trim();
}

function firstTrustedProxyEnv(...names: string[]): string | undefined {
	for (const name of names) {
		const value = trustedProxyEnvValue(name);
		if (value) return value;
	}
	return undefined;
}

function normalizeHost(hostname: string): string {
	return hostname
		.trim()
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "")
		.toLowerCase();
}

function defaultPortForProtocol(protocol: string): number | undefined {
	if (protocol === "https:") return 443;
	if (protocol === "http:") return 80;
	return undefined;
}

function effectiveUrlPort(url: URL): number | undefined {
	if (url.port) {
		const port = Number(url.port);
		return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
	}
	return defaultPortForProtocol(url.protocol);
}

function parseIPv4(host: string): [number, number, number, number] | undefined {
	if (net.isIP(host) !== 4) return undefined;
	const parts = host.split(".");
	if (parts.length !== 4) return undefined;
	const numbers = parts.map(part => Number(part));
	if (numbers.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
	return numbers as [number, number, number, number];
}

function parseIPv6(host: string): Uint8Array | undefined {
	if (net.isIP(host) !== 6) return undefined;
	const withoutZone = host.split("%", 1)[0] ?? host;
	let value = withoutZone;

	// IPv4 tails are represented by the final two IPv6 hextets.
	const lastColon = value.lastIndexOf(":");
	const lastDot = value.lastIndexOf(".");
	if (lastDot > lastColon) {
		const ipv4 = value.slice(lastColon + 1);
		const parsed = parseIPv4(ipv4);
		if (!parsed) return undefined;
		const [a, b, c, d] = parsed;
		value = `${value.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
	}

	const doubleColon = value.indexOf("::");
	if (doubleColon !== value.lastIndexOf("::")) return undefined;

	const parseHextets = (part: string): number[] => {
		if (!part) return [];
		const hextets = part.split(":");
		if (hextets.some(hextet => !/^[0-9a-f]{1,4}$/i.test(hextet))) return [];
		return hextets.map(hextet => Number.parseInt(hextet, 16));
	};

	let hextets: number[];
	if (doubleColon >= 0) {
		const left = parseHextets(value.slice(0, doubleColon));
		const right = parseHextets(value.slice(doubleColon + 2));
		if (
			(!left.length && value.slice(0, doubleColon) !== "") ||
			(!right.length && value.slice(doubleColon + 2) !== "")
		) {
			return undefined;
		}
		const missing = 8 - left.length - right.length;
		if (missing < 1) return undefined;
		hextets = [...left, ...new Array<number>(missing).fill(0), ...right];
	} else {
		hextets = parseHextets(value);
		if (hextets.length !== 8) return undefined;
	}
	if (hextets.length !== 8) return undefined;

	const bytes = new Uint8Array(16);
	for (let index = 0; index < hextets.length; index++) {
		bytes[index * 2] = hextets[index]! >> 8;
		bytes[index * 2 + 1] = hextets[index]! & 0xff;
	}
	return bytes;
}

function isPrivateOrLocalHost(hostname: string): boolean {
	const host = normalizeHost(hostname);
	if (!host) return false;
	if (
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host === "localhost.localdomain" ||
		host.endsWith(".localhost.localdomain")
	)
		return true;
	if (Object.hasOwn(CLOUD_METADATA_HOSTS, host)) return true;

	const ipv4 = parseIPv4(host);
	if (ipv4) {
		const [first, second] = ipv4;
		return (
			first === 0 ||
			first === 10 ||
			(first === 172 && second >= 16 && second <= 31) ||
			(first === 192 && second === 168) ||
			first === 127 ||
			(first === 169 && second === 254)
		);
	}

	const ipv6 = parseIPv6(host);
	if (!ipv6) return false;

	// IPv4-mapped IPv6 addresses retain the local/private classification of IPv4.
	const isMapped = ipv6.slice(0, 10).every(byte => byte === 0) && ipv6[10] === 0xff && ipv6[11] === 0xff;
	if (isMapped) {
		const mapped = `${ipv6[12]}.${ipv6[13]}.${ipv6[14]}.${ipv6[15]}`;
		return isPrivateOrLocalHost(mapped);
	}

	const isUnspecified = ipv6.every(byte => byte === 0);
	const isLoopback = ipv6.slice(0, 15).every(byte => byte === 0) && ipv6[15] === 1;
	const isLinkLocal = ipv6[0] === 0xfe && (ipv6[1]! & 0xc0) === 0x80;
	const isUniqueLocal = (ipv6[0]! & 0xfe) === 0xfc;
	return isUnspecified || isLoopback || isLinkLocal || isUniqueLocal;
}

interface NoProxyRule {
	host: string;
	port?: number;
	wildcard: boolean;
}

function parseNoProxyRule(rawRule: string): NoProxyRule | undefined {
	const rule = rawRule.trim().toLowerCase();
	if (!rule) return undefined;

	let host: string;
	let portText: string | undefined;
	if (rule.startsWith("[")) {
		const closingBracket = rule.indexOf("]");
		if (closingBracket < 0) return undefined;
		host = rule.slice(1, closingBracket);
		const suffix = rule.slice(closingBracket + 1);
		if (suffix) {
			if (!suffix.startsWith(":")) return undefined;
			portText = suffix.slice(1);
		}
	} else {
		const colon = rule.lastIndexOf(":");
		if (colon >= 0 && rule.indexOf(":") === colon) {
			const possiblePort = rule.slice(colon + 1);
			if (/^\d+$/.test(possiblePort) || possiblePort === "*") {
				host = rule.slice(0, colon);
				portText = possiblePort;
			} else {
				host = rule;
			}
		} else {
			host = rule;
		}
	}

	const wildcard = host === "*" || host === "*.";
	if (wildcard) {
		if (portText && portText !== "*" && !/^\d+$/.test(portText)) return undefined;
		const port = portText && portText !== "*" ? Number(portText) : undefined;
		if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65_535)) return undefined;
		return { host: "*", port, wildcard: true };
	}

	if (host.startsWith("*.")) host = host.slice(1);
	if (host.startsWith(".")) host = host.slice(1);
	host = normalizeHost(host);
	if (!host) return undefined;

	let port: number | undefined;
	if (portText && portText !== "*") {
		if (!/^\d+$/.test(portText)) return undefined;
		port = Number(portText);
		if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
	}
	return { host, port, wildcard: false };
}

function matchesNoProxy(hostname: string, port: number | undefined): boolean {
	const noProxy = firstEnvValue("NO_PROXY", "no_proxy");
	if (!noProxy) return false;
	const host = normalizeHost(hostname);

	for (const rawRule of noProxy.split(",")) {
		const rule = parseNoProxyRule(rawRule);
		if (!rule) continue;
		if (rule.port !== undefined && rule.port !== port) continue;
		if (rule.wildcard) return true;
		if (host === rule.host || host.endsWith(`.${rule.host}`)) return true;
	}
	return false;
}

export function getProxyForUrl(provider: string, url: URL): string | undefined {
	const hostname = normalizeHost(url.hostname);
	if (!hostname || isPrivateOrLocalHost(hostname) || matchesNoProxy(hostname, effectiveUrlPort(url))) return undefined;

	const normalizedProvider = normalizeProvider(provider);
	const protocolProxy =
		url.protocol === "https:"
			? firstTrustedProxyEnv("HTTPS_PROXY", "https_proxy")
			: url.protocol === "http:"
				? firstTrustedProxyEnv("HTTP_PROXY", "http_proxy")
				: undefined;
	const candidates = [
		normalizedProvider ? trustedProxyEnvValue(`PI_PROXY_${normalizedProvider}`) : undefined,
		trustedProxyEnvValue("PI_PROXY"),
		protocolProxy,
		firstTrustedProxyEnv("ALL_PROXY", "all_proxy"),
	];
	for (const candidate of candidates) {
		if (candidate) return candidate;
	}
	return undefined;
}

function formatAuthority(hostname: string, port: number): string {
	const host = normalizeHost(hostname);
	return net.isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`;
}

function tlsServerName(hostname: string): string | undefined {
	const host = normalizeHost(hostname);
	return host && net.isIP(host) === 0 ? host : undefined;
}

interface ParsedProxyUrl {
	protocol: "http:" | "https:";
	hostname: string;
	port: number;
	username: string;
	password: string;
}

function parseProxyUrl(value: string): ParsedProxyUrl {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw transportError("Invalid proxy URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw transportError("Unsupported proxy protocol");
	const hostname = normalizeHost(url.hostname);
	const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
	if (!hostname || !Number.isInteger(port) || port < 1 || port > 65_535) throw transportError("Invalid proxy address");
	return { protocol: url.protocol, hostname, port, username: url.username, password: url.password };
}

interface ParsedTargetUrl {
	hostname: string;
	port: number;
	authority: string;
	servername?: string;
}

function parseTargetUrl(value: string): ParsedTargetUrl {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw transportError("Invalid target URL");
	}
	const hostname = normalizeHost(url.hostname);
	const port = url.port ? Number(url.port) : defaultPortForProtocol(url.protocol);
	if (!hostname || port === undefined || !Number.isInteger(port) || port < 1 || port > 65_535) {
		throw transportError("Invalid target address");
	}
	return { hostname, port, authority: formatAuthority(hostname, port), servername: tlsServerName(hostname) };
}

function decodeProxyCredential(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		throw transportError("Invalid proxy credentials");
	}
}

function proxyAuthorization(proxy: ParsedProxyUrl): string | undefined {
	if (!proxy.username && !proxy.password) return undefined;
	const username = decodeProxyCredential(proxy.username);
	const password = decodeProxyCredential(proxy.password);
	return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

function waitForSocketConnect(socket: net.Socket, signal: AbortSignal): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	let settled = false;
	const cleanup = () => {
		socket.removeListener("connect", onConnect);
		socket.removeListener("error", onError);
		socket.removeListener("close", onClose);
		signal.removeEventListener("abort", onAbort);
	};
	const succeed = () => {
		if (settled) return;
		settled = true;
		cleanup();
		resolve();
	};
	const fail = (error: ProxyTransportError) => {
		if (settled) return;
		settled = true;
		cleanup();
		reject(error);
	};
	const onConnect = () => succeed();
	const onError = () => fail(transportError("Proxy TCP connection failed"));
	const onClose = () => fail(transportError("Proxy TCP connection closed"));
	const onAbort = () => {
		cleanup();
		if (!settled) {
			settled = true;
			reject(transportError("Proxy connection aborted"));
		}
	};

	socket.once("connect", onConnect);
	socket.once("error", onError);
	socket.once("close", onClose);
	signal.addEventListener("abort", onAbort, { once: true });
	if (signal.aborted) onAbort();
	return promise;
}

function openTcpSocket(
	hostname: string,
	port: number,
	signal: AbortSignal,
	addSocket: (socket: net.Socket) => void,
): Promise<net.Socket> {
	let socket: net.Socket;
	try {
		socket = net.connect({ host: hostname, port });
	} catch {
		return Promise.reject(transportError("Proxy TCP connection failed"));
	}
	addSocket(socket);
	return waitForSocketConnect(socket, signal).then(() => socket);
}

function waitForTlsHandshake(socket: tls.TLSSocket, signal: AbortSignal): Promise<tls.TLSSocket> {
	const { promise, resolve, reject } = Promise.withResolvers<tls.TLSSocket>();
	let settled = false;
	const cleanup = () => {
		socket.removeListener("secureConnect", onSecureConnect);
		socket.removeListener("error", onError);
		socket.removeListener("close", onClose);
		signal.removeEventListener("abort", onAbort);
	};
	const succeed = () => {
		if (settled) return;
		settled = true;
		cleanup();
		resolve(socket);
	};
	const fail = (error: ProxyTransportError) => {
		if (settled) return;
		settled = true;
		cleanup();
		reject(error);
	};
	const onSecureConnect = () => succeed();
	const onError = () => fail(transportError("Proxy TLS handshake failed"));
	const onClose = () => fail(transportError("Proxy TLS connection closed"));
	const onAbort = () => {
		cleanup();
		if (!settled) {
			settled = true;
			reject(transportError("Proxy connection aborted"));
		}
	};

	socket.once("secureConnect", onSecureConnect);
	socket.once("error", onError);
	socket.once("close", onClose);
	signal.addEventListener("abort", onAbort, { once: true });
	if (signal.aborted) onAbort();
	return promise;
}

function wrapProxyTls(
	socket: net.Socket,
	servername: string | undefined,
	signal: AbortSignal,
	addSocket: (socket: net.Socket) => void,
	alpnProtocols?: string[],
): Promise<tls.TLSSocket> {
	let tlsSocket: tls.TLSSocket;
	try {
		const options: tls.ConnectionOptions = { socket };
		if (servername) options.servername = servername;
		if (alpnProtocols) options.ALPNProtocols = alpnProtocols;
		tlsSocket = tls.connect(options);
	} catch {
		return Promise.reject(transportError("Proxy TLS handshake failed"));
	}
	addSocket(tlsSocket);
	const handshake = waitForTlsHandshake(tlsSocket, signal);
	// CONNECT parsing pauses the socket before handing it to TLS so buffered bytes are not lost.
	socket.resume();
	return handshake;
}

function issueConnectRequest(
	socket: net.Socket,
	target: ParsedTargetUrl,
	proxy: ParsedProxyUrl,
	signal: AbortSignal,
): Promise<void> {
	const authorization = proxyAuthorization(proxy);
	const request = [
		`CONNECT ${target.authority} HTTP/1.1`,
		`Host: ${target.authority}`,
		authorization ? `Proxy-Authorization: ${authorization}` : undefined,
		"Connection: Keep-Alive",
		"",
		"",
	]
		.filter((line): line is string => line !== undefined)
		.join("\r\n");

	const { promise, resolve, reject } = Promise.withResolvers<void>();
	let settled = false;
	const response = Buffer.allocUnsafe(CONNECT_HEADER_LIMIT);
	let responseLength = 0;
	let headerMatchLength = 0;
	const cleanup = () => {
		socket.removeListener("data", onData);
		socket.removeListener("error", onError);
		socket.removeListener("close", onClose);
		signal.removeEventListener("abort", onAbort);
	};
	const succeed = () => {
		if (settled) return;
		settled = true;
		cleanup();
		resolve();
	};
	const fail = (error: ProxyTransportError) => {
		if (settled) return;
		settled = true;
		cleanup();
		reject(error);
	};
	const onData = (bytes: Buffer) => {
		const capacity = CONNECT_HEADER_LIMIT - responseLength;
		const scanLength = Math.min(bytes.length, capacity);
		let headerLength = -1;

		for (let index = 0; index < scanLength; index++) {
			const byte = bytes[index];
			if (headerMatchLength === 0) {
				if (byte === 0x0d) headerMatchLength = 1;
			} else if (headerMatchLength === 1) {
				if (byte === 0x0a) headerMatchLength = 2;
				else if (byte !== 0x0d) headerMatchLength = 0;
			} else if (headerMatchLength === 2) {
				if (byte === 0x0d) headerMatchLength = 3;
				else headerMatchLength = 0;
			} else {
				if (byte === 0x0a) {
					headerLength = index + 1;
					break;
				}
				if (byte === 0x0d) headerMatchLength = 1;
				else headerMatchLength = 0;
			}
		}

		if (headerLength < 0) {
			if (bytes.length > capacity) {
				fail(transportError("Proxy CONNECT response headers too large"));
				return;
			}
			bytes.copy(response, responseLength);
			responseLength += bytes.length;
			return;
		}

		bytes.copy(response, responseLength, 0, headerLength);
		responseLength += headerLength;
		const headerEnd = responseLength - 4;
		const header = response.subarray(0, responseLength);
		const firstLineEnd = header.indexOf("\r\n");
		const firstLine = header.subarray(0, firstLineEnd < 0 ? headerEnd : firstLineEnd).toString("latin1");
		const statusMatch = /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s|$)/i.exec(firstLine);
		if (!statusMatch) {
			fail(transportError("Invalid proxy CONNECT response"));
			return;
		}
		const status = Number(statusMatch[1]);
		if (status !== 200) {
			fail(transportError(`Proxy CONNECT failed with status ${status}`));
			return;
		}
		socket.pause();
		const remaining = bytes.subarray(headerLength);
		if (remaining.length > 0) socket.unshift(remaining);
		succeed();
	};
	const onError = () => fail(transportError("Proxy CONNECT failed"));
	const onClose = () => fail(transportError("Proxy CONNECT connection closed"));
	const onAbort = () => {
		cleanup();
		if (!settled) {
			settled = true;
			reject(transportError("Proxy connection aborted"));
		}
	};

	socket.on("data", onData);
	socket.once("error", onError);
	socket.once("close", onClose);
	signal.addEventListener("abort", onAbort, { once: true });
	if (signal.aborted) {
		onAbort();
		return promise;
	}
	try {
		socket.write(request);
	} catch {
		onError();
	}
	return promise;
}

export function connectProxiedSocket(
	proxyUrl: string,
	targetUrl: string,
	options: ProxyConnectOptions = {},
): Promise<tls.TLSSocket> {
	const { promise, resolve, reject } = Promise.withResolvers<tls.TLSSocket>();
	const sockets = new Set<net.Socket>();
	const abortController = new AbortController();
	const signal = abortController.signal;
	let settled = false;
	let timeout: NodeJS.Timeout | undefined;

	const addSocket = (socket: net.Socket) => sockets.add(socket);
	const cleanup = () => {
		if (options.signal) options.signal.removeEventListener("abort", onAbort);
		if (timeout !== undefined) clearTimeout(timeout);
	};
	const destroySockets = () => {
		for (const socket of sockets) socket.destroy();
		sockets.clear();
	};
	const fail = (message: string) => {
		if (settled) return;
		settled = true;
		cleanup();
		abortController.abort();
		destroySockets();
		reject(transportError(message));
	};
	const succeed = (socket: tls.TLSSocket) => {
		if (settled) {
			socket.destroy();
			return;
		}
		settled = true;
		cleanup();
		sockets.clear();
		resolve(socket);
	};
	const onAbort = () => fail("Proxy connection aborted");
	if (options.signal?.aborted) {
		fail("Proxy connection aborted");
		return promise;
	}
	if (options.signal) options.signal.addEventListener("abort", onAbort, { once: true });
	if (options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
		timeout = setTimeout(() => fail("Proxy connection timed out"), options.timeoutMs);
	}

	void (async () => {
		try {
			if (settled) return;
			const proxy = parseProxyUrl(proxyUrl);
			const target = parseTargetUrl(targetUrl);
			let proxySocket: net.Socket = await openTcpSocket(proxy.hostname, proxy.port, signal, addSocket);
			if (proxy.protocol === "https:") {
				proxySocket = await wrapProxyTls(proxySocket, tlsServerName(proxy.hostname), signal, addSocket);
			}
			await issueConnectRequest(proxySocket, target, proxy, signal);
			const targetTls = await wrapProxyTls(proxySocket, target.servername, signal, addSocket, ["h2"]);
			succeed(targetTls);
		} catch (error) {
			if (settled) return;
			const message = error instanceof ProxyTransportError ? error.message : "Proxy connection failed";
			fail(message);
		}
	})();
	return promise;
}
