import { expect, test } from "vitest";
import { NAME } from "../src/index.ts";

test("package identity", () => {
  expect(NAME).toBe("@cessio/agent-mcp-server");
});
