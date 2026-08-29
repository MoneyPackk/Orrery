import { once } from "node:events";
import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_LINE_BYTES, PROTOCOL_VERSION, encodeMessage } from "@orrery/mission-control-protocol";
import { TcpLineTransport } from "./transport";

const servers: Server[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function listen(handler: (socket: Socket) => void) {
  const server = createServer((socket) => { sockets.push(socket); socket.on("error", () => undefined); handler(socket); });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind.");
  return { host: "127.0.0.1", port: address.port, version: PROTOCOL_VERSION } as const;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Condition was not met before timeout.");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe("TcpLineTransport", () => {
  it("sends NDJSON and parses fragmented and coalesced response lines", async () => {
    const endpoint = await listen((socket) => {
      socket.setEncoding("utf8");
      socket.once("data", () => {
        const first = encodeMessage({ type: "pong", version: PROTOCOL_VERSION, requestId: "ping-1" });
        const second = encodeMessage({ type: "pong", version: PROTOCOL_VERSION, requestId: "ping-2" });
        socket.write(first.slice(0, 8));
        socket.write(first.slice(8) + second);
      });
    });
    const transport = new TcpLineTransport();
    const received: unknown[] = [];
    transport.onMessage((message) => received.push(message));
    await transport.connect(endpoint);
    await transport.send({ type: "ping", version: PROTOCOL_VERSION, requestId: "ping-request" });
    await waitFor(() => received.length === 2);
    expect(received).toEqual([
      { type: "pong", version: PROTOCOL_VERSION, requestId: "ping-1" },
      { type: "pong", version: PROTOCOL_VERSION, requestId: "ping-2" },
    ]);
    await transport.disconnect();
  });

  it.each([
    ["malformed", "{}\n", /type|message/i],
    ["oversized", "x".repeat(MAX_LINE_BYTES + 1), /large|size/i],
  ])("reports a %s incoming line once and closes the socket", async (_name, payload, expected) => {
    const endpoint = await listen((socket) => {
      socket.setEncoding("utf8");
      socket.once("data", () => setTimeout(() => socket.write(payload), 5));
    });
    const transport = new TcpLineTransport();
    const errors: Error[] = [];
    transport.onClose((error) => { if (error) errors.push(error); });
    await transport.connect(endpoint);
    await transport.send({ type: "ping", version: PROTOCOL_VERSION, requestId: "trigger" });
    await waitFor(() => errors.length > 0);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(expected);
    await expect(transport.send({ type: "ping", version: PROTOCOL_VERSION, requestId: "after-close" })).rejects.toThrow(/not connected/i);
  });

  it("supports explicit reconnect without retaining a partial line", async () => {
    let connections = 0;
    const endpoint = await listen((socket) => {
      connections += 1;
      if (connections === 1) socket.write('{"type":"pong"');
      else socket.write(encodeMessage({ type: "pong", version: PROTOCOL_VERSION, requestId: "fresh" }));
    });
    const transport = new TcpLineTransport();
    const received: unknown[] = [];
    transport.onMessage((message) => received.push(message));
    await transport.connect(endpoint);
    await transport.disconnect();
    await transport.connect(endpoint);
    await waitFor(() => received.length === 1);
    expect(received).toEqual([{ type: "pong", version: PROTOCOL_VERSION, requestId: "fresh" }]);
    await transport.disconnect();
  });
});
