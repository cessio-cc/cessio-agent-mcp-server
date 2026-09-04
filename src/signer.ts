import type { Api, SignActionDto, TxExecuteBatchResponse } from "./client.ts";
import type { Identity } from "./identity.ts";

export interface Signer {
  run(actions: SignActionDto[]): Promise<void>;
}

/** Signs prepared-tx hashes and submits them via POST /tx/execute. Shared by
 * every tool that produces sign actions (the maker's quote allocations, the
 * taker's accept allocations). Keeps a set of already-signed ids so a re-drain of /tx/pending
 * does not double-submit. A transport failure or retryable per-action error
 * releases the id so a later run re-signs it. */
export function makeSigner(api: Api, identity: Identity, log: (m: string) => void): Signer {
  const signed = new Set<string>();
  return {
    async run(actions: SignActionDto[]): Promise<void> {
      if (signed.size > 5000) signed.clear();
      // Refuse anything that would move funds the agent never asked to move.
      for (const a of actions) {
        if (a.purpose === "transfer-out" && !signed.has(a.id)) {
          log(`REFUSING unexpected transfer-out: ${a.description}`);
          signed.add(a.id);
        }
      }
      const fresh = actions.filter((a) => !signed.has(a.id));
      // Chunked: the desk caps a batch at 50; a smaller chunk keeps each call's
      // sequential ledger work inside its request timeout.
      for (let i = 0; i < fresh.length; i += 10) {
        const chunk = fresh.slice(i, i + 10);
        for (const a of chunk) {
          signed.add(a.id);
          log(`signing: ${a.description}`);
        }
        try {
          const res = await api.post<TxExecuteBatchResponse>(
            "/tx/execute",
            { signatures: chunk.map((a) => ({ actionId: a.id, signature: identity.signHash(a.hash) })) },
            60_000,
          );
          for (const r of res.results) {
            if (r.status !== "error") continue; // in-flight: already running elsewhere
            log(`action ${r.actionId} failed (retryable=${r.retryable ?? false}): ${r.error}`);
            if (r.retryable === true) signed.delete(r.actionId);
          }
        } catch (e) {
          for (const a of chunk) signed.delete(a.id); // nothing certain happened; let a later run retry
          throw e;
        }
      }
    },
  };
}
