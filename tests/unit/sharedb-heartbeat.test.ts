import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { FakeWebSocket, sockets } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { EventEmitter } = require("node:events") as typeof import("node:events");

  class FakeWebSocket extends EventEmitter {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = FakeWebSocket.OPEN;
    sent: string[] = [];
    pings = 0;
    terminated = false;
    url: string;

    constructor(url: string) {
      super();
      this.url = url;
      sockets.push(this);
      queueMicrotask(() => this.emit("open"));
    }

    send(data: string): void {
      this.sent.push(data);
    }

    ping(): void {
      this.pings += 1;
    }

    terminate(): void {
      this.terminated = true;
      this.readyState = FakeWebSocket.CLOSED;
      this.emit("close", 1006);
    }

    close(): void {
      this.readyState = FakeWebSocket.CLOSED;
      this.emit("close", 1000);
    }
  }

  const sockets: InstanceType<typeof FakeWebSocket>[] = [];
  return { FakeWebSocket, sockets };
});

vi.mock("ws", () => ({ default: FakeWebSocket }));

import type { Config } from "../../src/config.js";
import { ShareDBClient } from "../../src/transport/sharedb.js";

const config: Config = {
  cookieHeader: "connect.sid=s%3Atest",
  baseUrl: "https://wanderlog.com",
  wsBaseUrl: "wss://wanderlog.com",
  userAgent: "test",
};

async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

async function connectAndSubscribe(client: ShareDBClient) {
  const connectPromise = client.connect();
  await flushMicrotasks();
  const ws = sockets[sockets.length - 1];
  ws.emit(
    "message",
    JSON.stringify({ a: "init", id: "sess1", protocol: 1, protocolMinor: 2, type: "http://sharejs.org/types/JSONv0" }),
  );
  ws.emit(
    "message",
    JSON.stringify({ a: "hs", id: "sess1", protocol: 1, protocolMinor: 2, type: "http://sharejs.org/types/JSONv0" }),
  );
  await connectPromise;

  const subscribePromise = client.subscribe();
  await flushMicrotasks();
  ws.emit(
    "message",
    JSON.stringify({
      a: "s",
      c: "TripPlans",
      d: "testtrip",
      data: { v: 7, data: { sections: [] } },
    }),
  );
  await subscribePromise;
  return ws;
}

describe("ShareDBClient heartbeat & zombie-connection recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sockets.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("pings on an interval and stays alive while pongs arrive", async () => {
    const client = new ShareDBClient(config, "testtrip");
    const ws = await connectAndSubscribe(client);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(ws.pings).toBe(1);
    ws.emit("pong");

    await vi.advanceTimersByTimeAsync(30_000);
    expect(ws.pings).toBe(2);
    ws.emit("pong");

    expect(ws.terminated).toBe(false);
    expect(client.isSubscribed).toBe(true);
    client.close();
  });

  it("terminates the socket when a pong is missed", async () => {
    const client = new ShareDBClient(config, "testtrip");
    const ws = await connectAndSubscribe(client);

    await vi.advanceTimersByTimeAsync(30_000); // ping sent
    await vi.advanceTimersByTimeAsync(10_000); // pong timeout

    expect(ws.terminated).toBe(true);
    expect(client.isSubscribed).toBe(false);
    client.close();
  });

  it("terminates the socket after a submit ack timeout so the next op can recover", async () => {
    const client = new ShareDBClient(config, "testtrip");
    const ws = await connectAndSubscribe(client);

    const submitPromise = client.submit([{ p: ["sections", 0], li: {} }]);
    const rejection = expect(submitPromise).rejects.toMatchObject({
      code: "submit_timeout",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;

    expect(ws.terminated).toBe(true);
    expect(client.isSubscribed).toBe(false);
    client.close();
  });

  it("does not serve the cached snapshot from a dead socket on subscribe", async () => {
    const client = new ShareDBClient(config, "testtrip");
    const ws = await connectAndSubscribe(client);

    // Simulate a half-open connection detected late: socket no longer OPEN.
    ws.readyState = FakeWebSocket.CLOSED;

    const resubscribe = client.subscribe();
    // The guard must not early-return the stale snapshot; it should attempt
    // a fresh subscribe (which here fails because the socket is closed).
    await expect(resubscribe).rejects.toThrow();
    client.close();
  });
});
