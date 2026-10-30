import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { assertDesktopAttachmentRequestSize } from "../../desktop-host/src/attachment-protocol";
import type { DesktopFrame, DesktopMethod, DesktopRequest } from "../../desktop-host/src/protocol";

export class DesktopRequestError extends Error {
	constructor(
		readonly requestId: string,
		message: string,
		readonly deliveryDisposition?: "refused" | "failed" | "unknown",
	) {
		super(message);
		this.name = "DesktopRequestError";
	}
}

export class DesktopLocalRequestError extends DesktopRequestError {
	constructor(requestId: string, message: string) {
		super(requestId, message, "refused");
		this.name = "DesktopLocalRequestError";
	}
}

/** Validate the exact envelope sent over the wire before any durable draft handoff. */
export function validateDesktopRequest(method: DesktopMethod, params: Record<string, unknown>, id: string): void {
	if (method !== "prompt") return;
	try {
		assertDesktopAttachmentRequestSize({ id, method, params } satisfies DesktopRequest);
	} catch (error) {
		throw new DesktopLocalRequestError(id, error instanceof Error ? error.message : String(error));
	}
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (reason: Error) => void;
}
const pending = new Map<string, PendingRequest>();
const listeners = new Set<(frame: DesktopFrame) => void>();
let connection: Promise<void> | undefined;

function receive(frame: DesktopFrame): void {
	if (frame.type === "response") {
		const waiter = pending.get(frame.id);
		if (waiter) {
			pending.delete(frame.id);
			if (frame.ok) waiter.resolve(frame.result);
			else waiter.reject(new DesktopRequestError(frame.id, frame.error, frame.deliveryDisposition));
		}
	} else if (frame.type === "fatal") {
		for (const waiter of pending.values()) waiter.reject(new Error(frame.error));
		pending.clear();
	}
	for (const listener of listeners) listener(frame);
}

async function connect(): Promise<void> {
	if (!isTauri())
		throw new Error("데스크톱 앱에서 실행해 주세요. 브라우저에서는 ?showcase로 디자인을 확인할 수 있습니다.");
	if (!connection) {
		connection = listen<DesktopFrame>("engine-frame", event => receive(event.payload))
			.then(() => undefined)
			.catch(error => {
				connection = undefined;
				throw error;
			});
	}
	await connection;
}

export async function subscribe(listener: (frame: DesktopFrame) => void): Promise<() => void> {
	listeners.add(listener);
	try {
		await connect();
	} catch (error) {
		listeners.delete(listener);
		throw error;
	}
	return () => {
		listeners.delete(listener);
	};
}

export async function request<T>(
	method: DesktopMethod,
	params: Record<string, unknown> = {},
	id: string = crypto.randomUUID(),
): Promise<T> {
	validateDesktopRequest(method, params, id);
	await connect();
	const envelope: DesktopRequest = { id, method, params };
	const result = Promise.withResolvers<unknown>();
	// Frames can settle before the invoke write acknowledgement returns.
	void result.promise.catch(() => {});
	pending.set(id, { resolve: result.resolve, reject: result.reject });
	void invoke("engine_request", { request: envelope }).catch(error => {
		pending.delete(id);
		result.reject(error instanceof Error ? error : new Error(String(error)));
	});
	return (await result.promise) as T;
}

export async function openAuthUrl(url: string): Promise<void> {
	const parsed = new URL(url);
	if (parsed.protocol !== "https:" || parsed.username || parsed.password)
		throw new Error("안전한 HTTPS 인증 주소만 열 수 있습니다.");
	await connect();
	await invoke("open_auth_url", { url });
}

export async function selectProject(): Promise<string | null> {
	await connect();
	return invoke<string | null>("select_project");
}
