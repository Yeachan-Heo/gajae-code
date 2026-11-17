import http from "node:http";
import https from "node:https";
import * as net from "node:net";

// This CLI regression never sends a prompt. Fail closed if startup tries network.
function deny(): never {
	throw new Error("Network is disabled in the resume picker PTY test");
}

globalThis.fetch = Object.assign(deny, { preconnect: deny });
http.request = deny;
http.get = deny;
https.request = deny;
https.get = deny;
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
	const target = args[0];
	const pipe =
		typeof target === "string"
			? target
			: target && typeof target === "object" && "path" in target
				? String(target.path)
				: "";
	if (pipe.startsWith("\\\\.\\pipe\\")) return connect.apply(this, args as never);
	return deny();
} as typeof connect;
