import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { defaultIpv6Probe, defaultLoopbackHealthProbe } from "../src/backends/docker.ts";

async function withServer(handler: (socket: Socket) => void): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    handler(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

async function probeResult(probe: Promise<boolean>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hang = new Promise<"hang">((resolve) => {
    timer = setTimeout(() => resolve("hang"), 5000);
  });
  const result = await Promise.race([probe, hang]);
  clearTimeout(timer);
  if (result === "hang") throw new Error("probe hung for 5s");
  return result;
}

test("loopback probe resolves false when the peer accepts then closes without a response", async () => {
  const { port, close } = await withServer((socket) => {
    socket.once("data", () => socket.end());
  });
  try {
    assert.equal(await probeResult(defaultLoopbackHealthProbe(`http://127.0.0.1:${port}/healthz`)), false);
  } finally {
    await close();
  }
});

test("loopback probe resolves true on an HTTP 200 response", async () => {
  const { port, close } = await withServer((socket) => {
    socket.once("data", () => {
      socket.end("HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 0\r\n\r\n");
    });
  });
  try {
    assert.equal(await probeResult(defaultLoopbackHealthProbe(`http://127.0.0.1:${port}/healthz`)), true);
  } finally {
    await close();
  }
});

test("loopback probe rejects a non-2xx response", async () => {
  const { port, close } = await withServer((socket) => {
    socket.once("data", () => {
      socket.end("HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\n\r\n");
    });
  });
  try {
    assert.equal(await probeResult(defaultLoopbackHealthProbe(`http://127.0.0.1:${port}/healthz`)), false);
  } finally {
    await close();
  }
});

test("loopback probe rejects a closed port", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.equal(await probeResult(defaultLoopbackHealthProbe(`http://127.0.0.1:${port}/healthz`)), false);
});

test("ipv6 probe resolves false when nothing listens on loopback IPv6", async () => {
  assert.equal(await probeResult(defaultIpv6Probe(1)), false);
});
