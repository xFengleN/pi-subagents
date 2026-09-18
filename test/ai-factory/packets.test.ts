/**
 * ai-factory/packets.test.ts — structured handoff packets.
 */

import { describe, expect, it } from "vitest";
import { packetSchema, parsePacket } from "../../src/ai-factory/packets.js";

describe("AI Factory — packets", () => {
  it("packet schemas compile and reject garbage", () => {
    for (const kind of ["proposal", "architect_initial", "engineer", "reviewer", "integration", "architect_final", "lead_escalation"] as const) {
      const schema = packetSchema(kind);
      expect(schema.check({})).not.toBe(true); // required fields missing
    }
  });

  it("parses a validated structured payload", () => {
    const packet = parsePacket("reviewer", JSON.stringify({
      verdict: "PASS",
      blockingFindings: [],
      nonBlockingFindings: ["minor"],
      requiredRepairs: [],
      testConcerns: [],
      architecturalIssue: false,
    }), undefined);
    expect(packet).toMatchObject({ verdict: "PASS", nonBlockingFindings: ["minor"] });
  });

  it("fills optional arrays with defaults", () => {
    const packet = parsePacket("reviewer", JSON.stringify({ verdict: "NEEDS_FIX" }), undefined);
    expect(packet).toMatchObject({ verdict: "NEEDS_FIX", blockingFindings: [], requiredRepairs: [] });
  });

  it("falls back to extracting JSON from prose when StructuredOutput was never called", () => {
    const prose = "Here is my assessment.\n```json\n{\"verdict\":\"ARCHITECTURAL_ESCALATION\",\"architecturalIssue\":true}\n```\nDone.";
    const packet = parsePacket("reviewer", undefined, prose);
    expect(packet).toMatchObject({ verdict: "ARCHITECTURAL_ESCALATION", architecturalIssue: true });
  });

  it("returns undefined for unusable output rather than guessing", () => {
    expect(parsePacket("reviewer", undefined, "I have no structured verdict to give.")).toBeUndefined();
    expect(parsePacket("reviewer", "{ not json", undefined)).toBeUndefined();
    expect(parsePacket("reviewer", JSON.stringify({ verdict: "MAYBE" }), undefined)).toBeUndefined();
  });

  it("normalizes engineer packets including the escalation flag", () => {
    const packet = parsePacket("engineer", JSON.stringify({
      status: "completed",
      workPackageId: "wp-1",
      summary: "done",
      architecturalEscalationRequired: true,
    }), undefined);
    expect(packet).toMatchObject({ status: "completed", architecturalEscalationRequired: true, changedFiles: [] });
  });
});
