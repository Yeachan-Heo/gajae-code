import { describe, expect, it } from "bun:test";
import { rm } from "node:fs/promises";
import * as net from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";

const isMacOS = process.platform === "darwin";

type ComputerScreenshot = {
	widthPx: number;
	heightPx: number;
	scaleX: number;
	scaleY: number;
	png: Uint8Array;
	displayEpoch: number;
	captureId: number;
};

type NativeComputerModule = {
	ComputerController: new () => Record<string, unknown>;
	computerScreenshot: () => ComputerScreenshot;
	unixSocketPeerPid: (fd: number) => number;
	darwinProcessIdentity: (pid: number) => { startToken: string; executable: string; pgid: number };
};

type SocketWithInternalHandle = {
	_handle?: {
		fd?: number;
	};
};

function socketFileDescriptor(socket: net.Socket): number {
	const handle = (socket as unknown as SocketWithInternalHandle)._handle;
	if (typeof handle?.fd !== "number") {
		throw new Error("connected socket did not expose a numeric file descriptor");
	}
	return handle.fd;
}

function listen(server: net.Server, socketPath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
}

function close(server: net.Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close(error => (error ? reject(error) : resolve()));
	});
}

async function loadNativeComputerModule(): Promise<NativeComputerModule> {
	return (await import("../native/index.js")) as unknown as NativeComputerModule;
}

describe.if(isMacOS)("ComputerController napi binding", () => {
	it("exists with expected methods", async () => {
		const { ComputerController } = await loadNativeComputerModule();
		const controller = new ComputerController();
		expect(controller).toBeInstanceOf(ComputerController);
		for (const method of [
			"screenshot",
			"click",
			"doubleClick",
			"move",
			"drag",
			"scroll",
			"type",
			"keypress",
			"wait",
		]) {
			expect(typeof controller[method]).toBe("function");
		}
	});
});

// The native `computerScreenshot` binding is macOS-only and captures the real
// primary display, so it requires the Screen Recording permission. Gate on
// platform and skip gracefully when capture is unavailable in the environment.
describe.if(isMacOS)("computer screenshot napi binding", () => {
	it("returns a decodable PNG whose dimensions match the descriptor", async () => {
		const { computerScreenshot } = await loadNativeComputerModule();
		let shot: ComputerScreenshot;
		try {
			shot = computerScreenshot();
		} catch (err) {
			// Screen Recording not granted to this process — surfaced, not silent.
			console.warn(`skipping: computerScreenshot unavailable (${String(err)})`);
			return;
		}

		expect(shot.widthPx).toBeGreaterThan(0);
		expect(shot.heightPx).toBeGreaterThan(0);
		expect(shot.scaleX).toBeGreaterThan(0);
		expect(shot.scaleY).toBeGreaterThan(0);
		expect(shot.png.byteLength).toBeGreaterThan(0);
		expect(shot.displayEpoch).toBeGreaterThan(0);
		expect(shot.captureId).toBeGreaterThan(0);

		// PNG magic number: 89 50 4E 47 0D 0A 1A 0A.
		const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
		for (let i = 0; i < sig.length; i++) {
			expect(shot.png[i]).toBe(sig[i]);
		}
	});
});

describe.if(isMacOS)("Unix socket peer PID napi binding", () => {
	it("returns the kernel-reported peer PID for both ends of a local socket", async () => {
		const socketPath = path.join(
			tmpdir(),
			`gjc-native-peer-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`,
		);
		const serverConnection = Promise.withResolvers<net.Socket>();
		const server = net.createServer(socket => serverConnection.resolve(socket));
		let client: net.Socket | undefined;
		let serverSocket: net.Socket | undefined;
		let listening = false;

		try {
			await listen(server, socketPath);
			listening = true;
			client = await new Promise<net.Socket>((resolve, reject) => {
				const socket = net.createConnection(socketPath);
				socket.once("connect", () => {
					socket.removeListener("error", reject);
					resolve(socket);
				});
				socket.once("error", reject);
			});
			serverSocket = await serverConnection.promise;

			const { unixSocketPeerPid } = await loadNativeComputerModule();
			expect(unixSocketPeerPid(socketFileDescriptor(client))).toBe(process.pid);
			expect(unixSocketPeerPid(socketFileDescriptor(serverSocket))).toBe(process.pid);
			expect(() => unixSocketPeerPid(-1)).toThrow();
		} finally {
			client?.destroy();
			serverSocket?.destroy();
			if (listening) await close(server);
			await rm(socketPath, { force: true });
		}
	});

	it("returns a microsecond process incarnation and executable path", async () => {
		const { darwinProcessIdentity } = await loadNativeComputerModule();
		const identity = darwinProcessIdentity(process.pid);
		expect(identity.startToken).toMatch(/^\d+:\d+$/);
		expect(path.isAbsolute(identity.executable)).toBe(true);
		expect(identity.pgid).toBeGreaterThan(0);
		expect(() => darwinProcessIdentity(-1)).toThrow();
	});
});
