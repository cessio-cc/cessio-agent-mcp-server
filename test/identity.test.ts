import { generateKeyPairSync, verify as edVerify } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { loadIdentity } from "../src/identity.ts";

test("loadIdentity round-trips and signHash verifies against the public key", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const dir = mkdtempSync(join(tmpdir(), "agent-id-"));
  const file = join(dir, "id.json");
  writeFileSync(
    file,
    JSON.stringify({
      partyId: "party::abc",
      hint: "agent",
      apiKey: "mk_key",
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    }),
  );

  const idn = loadIdentity(file);
  expect(idn?.hint).toBe("agent");
  const hashB64 = Buffer.from("deadbeefdeadbeef").toString("base64");
  const sig = Buffer.from(idn!.signHash(hashB64), "base64");
  expect(edVerify(null, Buffer.from(hashB64, "base64"), publicKey, sig)).toBe(true);
});

test("loadIdentity returns undefined when no state file exists", () => {
  expect(loadIdentity(join(tmpdir(), "does-not-exist-agent-id.json"))).toBeUndefined();
});
