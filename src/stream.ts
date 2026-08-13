import WebSocket from "ws";
import type { RfqDto, WsEvent } from "./client.ts";

export interface RfqQueue {
  push(rfq: RfqDto): void;
  remove(rfqId: string): void;
  reset(): void;
  next(timeoutMs: number): Promise<RfqDto | null>;
  close(): void;
}

/** Async FIFO of incoming RFQs. `next` returns a buffered RFQ at
 * once, else waits up to `timeoutMs` for the next `push`, else resolves null. */
export function makeRfqQueue(): RfqQueue {
  const MAX_BUFFERED_RFQS = 100;
  const buffered = new Map<string, RfqDto>();
  const order: string[] = [];
  const waiters: Array<{
    resolve: (rfq: RfqDto | null) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  let closed = false;

  return {
    push(rfq: RfqDto): void {
      if (closed) return;
      const waiter = waiters.shift();
      if (waiter !== undefined) {
        clearTimeout(waiter.timer);
        waiter.resolve(rfq);
        return;
      }

      if (buffered.has(rfq.rfqId)) {
        buffered.set(rfq.rfqId, rfq);
        return;
      }

      buffered.set(rfq.rfqId, rfq);
      order.push(rfq.rfqId);
      while (buffered.size > MAX_BUFFERED_RFQS) {
        const oldestId = order.shift();
        if (oldestId === undefined) break;
        buffered.delete(oldestId);
      }
    },
    remove(rfqId: string): void {
      if (closed) return;
      if (!buffered.delete(rfqId)) return;
      const index = order.indexOf(rfqId);
      if (index !== -1) order.splice(index, 1);
    },
    reset(): void {
      if (closed) return;
      buffered.clear();
      order.length = 0;
    },
    next(timeoutMs: number): Promise<RfqDto | null> {
      if (closed) return Promise.resolve(null);
      while (order.length > 0) {
        const rfqId = order.shift();
        if (rfqId === undefined) break;
        const queued = buffered.get(rfqId);
        if (queued !== undefined) {
          buffered.delete(rfqId);
          return Promise.resolve(queued);
        }
      }

      return new Promise((resolve) => {
        let waiter: (typeof waiters)[number];
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index !== -1) {
            waiters.splice(index, 1);
            resolve(null);
          }
        }, timeoutMs);
        waiter = { resolve, timer };
        waiters.push(waiter);
      });
    },
    close(): void {
      if (closed) return;
      closed = true;
      buffered.clear();
      order.length = 0;
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.resolve(null);
      }
    },
  };
}

export interface RfqStream {
  next(timeoutMs: number): Promise<RfqDto | null>;
  get(rfqId: string): RfqDto | undefined;
  close(): void;
}

/** Thin WS wiring: one socket, reconnected forever with a flat 5s backoff (like
 * the demo bot). Buffers `rfq.created` into the queue and keeps a cache of
 * last-seen RFQs so submit_quote can resolve an rfqId. Reconnect, buffering,
 * and close behavior are covered by the stream unit tests. */
export function makeRfqStream(
  streamOptions: () => { url: string; headers: Record<string, string> },
  log: (m: string) => void,
): RfqStream {
  const queue = makeRfqQueue();
  const cache = new Map<string, RfqDto>();
  let socket: WebSocket | undefined;
  let closed = false;

  function connect(): void {
    if (closed) return;
    const options = streamOptions();
    const ws = new WebSocket(options.url, { headers: options.headers });
    socket = ws;
    ws.on("open", () => log("stream connected"));
    ws.on("message", (data) => {
      let parsed: WsEvent;
      try {
        parsed = JSON.parse(String(data)) as WsEvent;
      } catch {
        return;
      }
      if (parsed.type === "rfq.created") {
        const rfq = parsed.payload as RfqDto;
        const firstSeen = !cache.has(rfq.rfqId);
        cache.set(rfq.rfqId, rfq);
        if (firstSeen) queue.push(rfq);
      } else if (parsed.type === "rfq.closed" || parsed.type === "rfq.expired") {
        const { rfqId } = parsed.payload as { rfqId: string };
        cache.delete(rfqId);
        queue.remove(rfqId);
      }
    });
    ws.on("close", () => {
      if (!closed) {
        cache.clear();
        queue.reset();
        log("stream closed — reconnecting in 5s");
        setTimeout(connect, 5_000);
      }
    });
    ws.on("error", () => {}); // close always follows; the retry lives there
  }
  connect();

  return {
    next: (timeoutMs) => queue.next(timeoutMs),
    get: (rfqId) => cache.get(rfqId),
    close: () => {
      closed = true;
      queue.close();
      socket?.close();
    },
  };
}
