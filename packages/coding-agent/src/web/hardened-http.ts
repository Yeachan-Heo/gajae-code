import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import { isPrivateOrSpecialAddress, normalizeUrlHostname } from "./insane/url-guard";

/** Await `operation`, rejecting as soon as `signal` aborts (if provided). */
export function withAbortSignal<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return operation;
	if (signal.aborted) return Promise.reject(signal.reason);
	const deferred = Promise.withResolvers<T>();
	const abort = () => deferred.reject(signal.reason);
	signal.addEventListener("abort", abort, { once: true });
	operation.then(deferred.resolve, deferred.reject).finally(() => signal.removeEventListener("abort", abort));
	return deferred.promise;
}

function normalizePeerAddress(address: string): string {
	const normalized = address.toLowerCase();
	return normalized.startsWith("::ffff:") ? normalized.slice(7) : normalized;
}

export interface PinnedResponseOptions {
	url: URL;
	/** Addresses approved by `validatePublicHttpUrl`; the socket may only connect to these. */
	addresses: string[];
	signal?: AbortSignal;
	headers: Record<string, string>;
	maxHeaderBytes: number;
	/** Reject a response whose connected peer is missing (default) or only when it is unapproved. */
	rejectMissingPeer?: boolean;
	unapprovedPeerMessage: (peer: string | undefined) => string;
	/** Optional post-response header-size cap; `maxHeaderBytes` already bounds parsing. */
	maxResponseHeaderBytes?: number;
	responseHeaderBytes?: (response: http.IncomingMessage) => number;
	responseHeaderTooLargeMessage?: string;
	/** Error raised when DNS resolves to an address outside the approved set. */
	lookupErrorMessage?: string;
}

/**
 * Open an HTTP(S) GET whose DNS lookup and connected peer are pinned to
 * pre-approved public addresses, preventing SSRF rebinding between validation
 * and connection.
 */
export function openPinnedResponse(options: PinnedResponseOptions): Promise<http.IncomingMessage> {
	const { url, addresses, signal, headers, maxHeaderBytes, rejectMissingPeer = true } = options;
	const hostname = normalizeUrlHostname(url.hostname);
	const approved = addresses.map(address => ({ address, family: net.isIP(address) }));
	const approvedPeers = new Set(approved.map(record => normalizePeerAddress(record.address)));
	const lookup: net.LookupFunction = (requestedHostname, lookupOptions, callback) => {
		const requestedFamily =
			lookupOptions.family === "IPv4" ? 4 : lookupOptions.family === "IPv6" ? 6 : (lookupOptions.family ?? 0);
		const matching = approved.filter(record => requestedFamily === 0 || record.family === requestedFamily);
		if (normalizeUrlHostname(requestedHostname) !== hostname || matching.length === 0) {
			const error = Object.assign(new Error(options.lookupErrorMessage ?? "No approved address for pinned host"), {
				code: "ENOTFOUND",
			});
			callback(error, lookupOptions.all ? [] : "", 0);
			return;
		}
		if (lookupOptions.all) callback(null, matching);
		else callback(null, matching[0].address, matching[0].family);
	};
	const deferred = Promise.withResolvers<http.IncomingMessage>();
	const requestOptions: https.RequestOptions = {
		protocol: url.protocol,
		hostname,
		port: url.port || undefined,
		path: `${url.pathname}${url.search}`,
		method: "GET",
		headers,
		agent: false,
		insecureHTTPParser: false,
		lookup,
		maxHeaderSize: maxHeaderBytes,
		signal,
		...(url.protocol === "https:"
			? { rejectUnauthorized: true, servername: net.isIP(hostname) === 0 ? hostname : undefined }
			: {}),
	};
	const requestFn = url.protocol === "https:" ? https.request : http.request;
	const request = requestFn(requestOptions, response => {
		const responseHeaderBytes = options.responseHeaderBytes?.(response);
		if (
			options.maxResponseHeaderBytes !== undefined &&
			responseHeaderBytes !== undefined &&
			responseHeaderBytes > options.maxResponseHeaderBytes
		) {
			response.destroy();
			deferred.reject(new Error(options.responseHeaderTooLargeMessage ?? "Response headers exceed the limit"));
			return;
		}
		const peer = response.socket.remoteAddress;
		if (
			(rejectMissingPeer && !peer) ||
			(peer && (isPrivateOrSpecialAddress(peer) || !approvedPeers.has(normalizePeerAddress(peer))))
		) {
			response.destroy();
			deferred.reject(new Error(options.unapprovedPeerMessage(peer)));
			return;
		}
		deferred.resolve(response);
	});
	request.once("error", deferred.reject);
	const abort = () => {
		request.destroy(signal?.reason);
		deferred.reject(signal?.reason);
	};
	if (signal?.aborted) abort();
	else signal?.addEventListener("abort", abort, { once: true });
	request.once("close", () => signal?.removeEventListener("abort", abort));
	request.end();
	return deferred.promise;
}

export interface ResponseFramingOptions {
	ambiguousMessage: string;
	invalidContentLengthMessage: string;
	maxBytes: number;
	oversizeMessage: string;
}

/** Reject ambiguous framing (duplicate Content-Length or CL+TE) and oversize declared bodies. */
export function validateResponseFraming(response: http.IncomingMessage, options: ResponseFramingOptions): void {
	const rawContentLengths: string[] = [];
	let hasTransferEncoding = false;
	for (let index = 0; index < response.rawHeaders.length; index += 2) {
		const name = response.rawHeaders[index]?.toLowerCase();
		if (name === "content-length") rawContentLengths.push(response.rawHeaders[index + 1] ?? "");
		if (name === "transfer-encoding") hasTransferEncoding = true;
	}
	if (rawContentLengths.length > 1 || (rawContentLengths.length > 0 && hasTransferEncoding)) {
		response.destroy();
		throw new Error(options.ambiguousMessage);
	}
	const contentLength = response.headers["content-length"];
	if (contentLength === undefined) return;
	const declaredBytes = typeof contentLength === "string" && /^\d+$/.test(contentLength) ? Number(contentLength) : NaN;
	if (!Number.isSafeInteger(declaredBytes)) {
		response.destroy();
		throw new Error(options.invalidContentLengthMessage);
	}
	if (declaredBytes > options.maxBytes) {
		response.destroy();
		throw new Error(options.oversizeMessage);
	}
}

export interface ReadResponseBodyOptions {
	maxBytes: number;
	signal?: AbortSignal;
	oversizeMessage: string;
}

/** Read an abort-safe response body, destroying the stream on abort or oversize. */
export async function readResponseBody(
	response: http.IncomingMessage,
	options: ReadResponseBodyOptions,
): Promise<Buffer> {
	const { maxBytes, signal, oversizeMessage } = options;
	const abort = () => response.destroy(signal?.reason);
	if (signal?.aborted) {
		abort();
		throw signal.reason;
	}
	signal?.addEventListener("abort", abort, { once: true });
	const chunks: Buffer[] = [];
	let receivedBytes = 0;
	try {
		for await (const chunk of response) {
			const bytes = Buffer.from(chunk);
			receivedBytes += bytes.byteLength;
			if (receivedBytes > maxBytes) {
				response.destroy();
				throw new Error(oversizeMessage);
			}
			chunks.push(bytes);
		}
		return Buffer.concat(chunks, receivedBytes);
	} finally {
		signal?.removeEventListener("abort", abort);
	}
}
