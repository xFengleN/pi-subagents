import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyFactoryTarget } from "../../src/ai-factory/verifier.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function cwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-verifier-"));
  dirs.push(dir);
  return dir;
}

describe("deterministic target verification", () => {
  it("records command exit evidence, never a model-supplied PASS", async () => {
    const dir = cwd();
    expect(await verifyFactoryTarget(dir, "T1", { command: "printf verified", evidence: "check" })).toMatchObject({ status: "passed", command: "printf verified", evidence: expect.stringContaining("verified") });
    expect(await verifyFactoryTarget(dir, "T1", { command: "exit 7", evidence: "check" })).toMatchObject({ status: "failed", evidence: expect.stringContaining("exit=7") });
  });

  it("distinguishes manual owner-pending from unavailable", async () => {
    const dir = cwd();
    expect(await verifyFactoryTarget(dir, "T1", { evidence: "Visual inspection required", ownerPending: true })).toMatchObject({ status: "owner_pending", evidence: "Visual inspection required" });
    expect(await verifyFactoryTarget(dir, "T1", { evidence: "No check exists" })).toMatchObject({ status: "unavailable", evidence: "No check exists" });
  });
});
