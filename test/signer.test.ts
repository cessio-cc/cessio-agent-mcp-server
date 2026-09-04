import { expect, test, vi } from "vitest";
import type { Api, SignActionDto } from "../src/client.ts";
import type { Identity } from "../src/identity.ts";
import { makeSigner } from "../src/signer.ts";

const idn = { partyId: "p", hint: "agent", apiKey: "mk_", signHash: (h: string) => `sig(${h})`, signText: () => "t" } as Identity;
const action = (id: string, purpose: SignActionDto["purpose"] = "allocate"): SignActionDto => ({ id, purpose, description: id, hash: `hash-${id}` });

function apiStub(post: Api["post"]): Api {
  return { get: vi.fn(), post, del: vi.fn(), streamOptions: () => ({ url: "ws://x", headers: {} }) };
}

test("signs each action and posts signatures to /tx/execute", async () => {
  const post = vi.fn(async (_p: string, body: unknown) => ({
    results: (body as { signatures: { actionId: string }[] }).signatures.map((s) => ({ actionId: s.actionId, status: "executed" as const })),
  }));
  const signer = makeSigner(apiStub(post as unknown as Api["post"]), idn, () => {});
  await signer.run([action("a"), action("b")]);
  expect(post).toHaveBeenCalledWith("/tx/execute", { signatures: [{ actionId: "a", signature: "sig(hash-a)" }, { actionId: "b", signature: "sig(hash-b)" }] }, 60_000);
});

test("refuses an unexpected transfer-out (signs nothing for it)", async () => {
  const post = vi.fn(async () => ({ results: [] }));
  const signer = makeSigner(apiStub(post as unknown as Api["post"]), idn, () => {});
  await signer.run([action("x", "transfer-out")]);
  // The only action was a transfer-out → it is filtered out, so no signatures are posted.
  expect(post).not.toHaveBeenCalled();
});

test("re-signs a retryable error on the next run", async () => {
  const calls: string[][] = [];
  const post = vi.fn(async (_p: string, body: unknown) => {
    const ids = (body as { signatures: { actionId: string }[] }).signatures.map((s) => s.actionId);
    calls.push(ids);
    return { results: ids.map((actionId) => ({ actionId, status: "error" as const, error: "busy", retryable: true })) };
  });
  const signer = makeSigner(apiStub(post as unknown as Api["post"]), idn, () => {});
  await signer.run([action("a")]);
  await signer.run([action("a")]);
  expect(calls).toEqual([["a"], ["a"]]); // retryable id was released, so run 2 re-signs it
});
