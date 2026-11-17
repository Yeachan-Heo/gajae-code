/** Close a test WebSocket and wait for its close event, bounded at 500ms. */
export async function closeSocket(socket: WebSocket): Promise<void> {
	if (socket.readyState === WebSocket.CLOSED) return;
	const { promise, resolve } = Promise.withResolvers<void>();
	socket.addEventListener("close", () => resolve(), { once: true });
	socket.close();
	await Promise.race([promise, Bun.sleep(500)]);
}
