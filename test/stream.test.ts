import { expect, test, vi } from "vitest";
import type { RfqDto } from "../src/client.ts";

const socketHarness = vi.hoisted(() => {
  class FakeWebSocket {
    static readonly instances: FakeWebSocket[] = [];
    private readonly handlers = new Map<string, Array<(data?: unknown) => void>>();

    constructor(_url: string, _options?: unknown) {
      FakeWebSocket.instances.push(this);
    }

    on(event: string, handler: (data?: unknown) => void): this {
      const handlers = this.handlers.get(event) ?? [];
      handlers.push(handler);
      this.handlers.set(event, handlers);
      return this;
    }

    emit(event: string, data?: unknown): void {
      for (const handler of this.handlers.get(event) ?? []) handler(data);
    }

    close(): void {
      this.emit("close");
    }
  }
  return { FakeWebSocket };
});

vi.mock("ws", () => ({ default: socketHarness.FakeWebSocket }));

import { makeRfqQueue, makeRfqStream } from "../src/stream.ts";

const rfq = (id: string): RfqDto => ({
  rfqId: id, taker: "tk", direction: "SELL", qty: "1", base: "cBTC", quote: "USDC",
  deadline: "2026-07-26T01:00:00Z", invitedMakers: ["agent"], feeBps: 10, open: true,
});

test("next returns an already-buffered rfq immediately", async () => {
  const q = makeRfqQueue();
  q.push(rfq("r1"));
  expect((await q.next(50))?.rfqId).toBe("r1");
});

test("next resolves when an rfq arrives after the wait starts", async () => {
  const q = makeRfqQueue();
  const p = q.next(1_000);
  setTimeout(() => q.push(rfq("r2")), 10);
  expect((await p)?.rfqId).toBe("r2");
});

test("next returns null on timeout", async () => {
  const q = makeRfqQueue();
  expect(await q.next(20)).toBeNull();
});

test("buffered rfqs are delivered in FIFO order", async () => {
  const q = makeRfqQueue();
  q.push(rfq("a"));
  q.push(rfq("b"));
  expect((await q.next(50))?.rfqId).toBe("a");
  expect((await q.next(50))?.rfqId).toBe("b");
});

test("two concurrent waiters settle in FIFO order", async () => {
  const q = makeRfqQueue();
  const first = q.next(1_000);
  const second = q.next(1_000);
  q.push(rfq("r1"));
  q.push(rfq("r2"));
  expect((await first)?.rfqId).toBe("r1");
  expect((await second)?.rfqId).toBe("r2");
});

test("close resolves every waiter", async () => {
  const q = makeRfqQueue();
  const first = q.next(1_000);
  const second = q.next(1_000);
  q.close();
  await expect(first).resolves.toBeNull();
  await expect(second).resolves.toBeNull();
});

test("duplicate RFQs are delivered only once", async () => {
  const q = makeRfqQueue();
  q.push(rfq("same"));
  q.push(rfq("same"));
  expect((await q.next(10))?.rfqId).toBe("same");
  await expect(q.next(10)).resolves.toBeNull();
});

test("removed RFQs are not delivered", async () => {
  const q = makeRfqQueue();
  q.push(rfq("closed"));
  q.remove("closed");
  await expect(q.next(10)).resolves.toBeNull();
});

test("the queue evicts the oldest RFQ when it exceeds 100 entries", async () => {
  const q = makeRfqQueue();
  for (let i = 0; i <= 100; i++) q.push(rfq(`r${i}`));
  expect((await q.next(10))?.rfqId).toBe("r1");
});

test("close discards buffered RFQs", async () => {
  const q = makeRfqQueue();
  q.push(rfq("buffered"));
  q.close();
  await expect(q.next(10)).resolves.toBeNull();
});

test("next resolves null immediately after close", async () => {
  vi.useFakeTimers();
  try {
    const q = makeRfqQueue();
    q.close();
    let settled = false;
    void q.next(1_000).then(() => { settled = true; });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(settled).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test("push after close is ignored", async () => {
  const q = makeRfqQueue();
  q.close();
  q.push(rfq("late"));
  await expect(q.next(10)).resolves.toBeNull();
});

test("close is idempotent", async () => {
  const q = makeRfqQueue();
  let resolutions = 0;
  const waiter = q.next(1_000).then((result) => {
    resolutions += 1;
    return result;
  });
  q.close();
  q.close();
  await expect(waiter).resolves.toBeNull();
  expect(resolutions).toBe(1);
});

test("reset clears buffered RFQs but preserves live waiters", async () => {
  const q = makeRfqQueue();
  q.push(rfq("stale"));
  q.reset();
  const waiter = q.next(1_000);
  q.reset();
  q.push(rfq("fresh"));
  await expect(waiter).resolves.toMatchObject({ rfqId: "fresh" });
});

test("reconnect replaces stale stream cache and buffer with the new empty snapshot", async () => {
  vi.useFakeTimers();
  let stream: ReturnType<typeof makeRfqStream> | undefined;
  try {
    socketHarness.FakeWebSocket.instances.length = 0;
    stream = makeRfqStream(() => ({ url: "ws://desk.test/maker/stream", headers: {} }), () => {});
    const first = socketHarness.FakeWebSocket.instances[0]!;
    first.emit("message", JSON.stringify({ type: "rfq.created", payload: rfq("stale") }));
    expect(stream.get("stale")?.rfqId).toBe("stale");

    first.emit("close");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(socketHarness.FakeWebSocket.instances).toHaveLength(2);
    expect(stream.get("stale")).toBeUndefined();
    const next = stream.next(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(next).resolves.toBeNull();
  } finally {
    stream?.close();
    vi.useRealTimers();
  }
});

test("terminal stream close still clears waiters and prevents reconnect", async () => {
  vi.useFakeTimers();
  try {
    socketHarness.FakeWebSocket.instances.length = 0;
    const stream = makeRfqStream(() => ({ url: "ws://desk.test/maker/stream", headers: {} }), () => {});
    const waiter = stream.next(60_000);
    stream.close();
    await expect(waiter).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(socketHarness.FakeWebSocket.instances).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});
