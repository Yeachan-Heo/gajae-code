const relayBase = process.env.RELAY_BASE_URL;
if (!relayBase) throw new Error("RELAY_BASE_URL is required");
const port = Number(process.env.PORT ?? "20720");
const decoder = new TextDecoder();
const encoder = new TextEncoder();
let requestCount = 0;

function logEvent(requestId: number, event: Record<string, unknown>): void {
  const type = typeof event.type === "string" ? event.type : "";
  const delta = typeof event.delta === "string" ? event.delta : undefined;
  const args = typeof event.arguments === "string" ? event.arguments : undefined;
  console.log(JSON.stringify({ requestId, at: Date.now(), type, deltaLength: delta?.length ?? 0, deltaPreview: delta?.slice(0, 120), argumentsLength: args?.length ?? 0 }));
}

const server = Bun.serve({
  port,
  async fetch(request) {
    if (request.method !== "POST") return new Response("capture proxy expects POST", { status: 405 });
    const requestId = ++requestCount;
    const target = new URL(request.url);
    const upstream = new URL(target.pathname + target.search, relayBase);
    const headers = new Headers(request.headers);
    headers.delete("host");
    const response = await fetch(upstream, { method: "POST", headers, body: request.body });
    if (!response.body) return response;
    const reader = response.body.getReader();
    let buffer = "";
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await reader.read();
        if (next.done) {
          if (buffer.trim()) {
            for (const line of buffer.split("\\n")) if (line.startsWith("data: ")) {
              try { logEvent(requestId, JSON.parse(line.slice(6)) as Record<string, unknown>); } catch {}
            }
          }
          controller.close();
          return;
        }
        const text = decoder.decode(next.value, { stream: true });
        buffer += text;
        const chunks = buffer.split("\\n\\n");
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks) {
          for (const line of chunk.split("\\n")) if (line.startsWith("data: ")) {
            try { logEvent(requestId, JSON.parse(line.slice(6)) as Record<string, unknown>); } catch {}
          }
        }
        controller.enqueue(encoder.encode(text));
      },
      cancel(reason) { reader.cancel(reason); },
    });
    const outHeaders = new Headers(response.headers);
    outHeaders.delete("content-length");
    return new Response(stream, { status: response.status, headers: outHeaders });
  },
});
console.error(`capture proxy listening on ${server.url}`);
