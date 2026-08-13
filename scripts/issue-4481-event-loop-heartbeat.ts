const heartbeatPath = process.env.GJC_ISSUE4481_HEARTBEAT_PATH;
const intervalMs = Number(process.env.GJC_ISSUE4481_HEARTBEAT_INTERVAL_MS ?? "250");

if (heartbeatPath && Number.isFinite(intervalMs) && intervalMs > 0) {
	let sequence = 0;
	const writeHeartbeat = async (): Promise<void> => {
		sequence += 1;
		const payload = `${process.pid} ${sequence} ${Date.now()}\n`;
		await Bun.write(heartbeatPath, payload);
	};
	void writeHeartbeat();
	const timer = setInterval(() => void writeHeartbeat(), intervalMs);
	timer.unref();
}
