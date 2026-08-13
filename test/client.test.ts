import { afterEach, expect, test, vi } from "vitest";
import { HttpError, makeApi } from "../src/client.ts";

afterEach(() => vi.restoreAllMocks());

function mockFetch(status: number, body: string): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status })));
}

test("GET sends the api key and parses JSON", async () => {
  mockFetch(200, JSON.stringify({ feeBps: 10, makers: ["m1"] }));
  const api = makeApi("http://desk", () => "mk_secret");
  const desk = await api.get<{ feeBps: number; makers: string[] }>("/desk");
  expect(desk.makers).toEqual(["m1"]);
  const call = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
  expect(call[0]).toBe("http://desk/desk");
  expect((call[1] as RequestInit).headers).toMatchObject({ "x-api-key": "mk_secret" });
});

test("non-2xx throws HttpError with status and body", async () => {
  mockFetch(409, "quote already accepted");
  const api = makeApi("http://desk", () => "mk_secret");
  await expect(api.post("/quote/x/accept")).rejects.toMatchObject({ status: 409, body: "quote already accepted" });
  await expect(api.post("/quote/x/accept")).rejects.toBeInstanceOf(HttpError);
});

test("streamOptions keeps the API key out of the URL and puts it in upgrade headers", () => {
  const api = makeApi("http://desk", () => "mk_secret");
  expect(api.streamOptions()).toEqual({
    url: "ws://desk/maker/stream",
    headers: { "x-api-key": "mk_secret" },
  });
  expect(api.streamOptions().url).not.toContain("mk_secret");
});
