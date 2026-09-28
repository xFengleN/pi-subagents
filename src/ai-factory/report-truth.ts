/* Free-form Lead prose is evidence, never an authoritative Architect verdict. */
const architectClaim = /\bFinal (?:Acceptance )?Architect (?:acceptance )?verdict\s*:\s*(?:ACCEPT(?:ED)?|PASS|NEEDS_REMEDIATION|ARCHITECTURE_CONTRADICTION)\b/gi;
const prematureAcceptance = /\bVERDICT:\s*ACCEPT(?:ED)?(?:\s*\(technically\))?/gi;

export function sanitizeIntegrationAssessment(text: string, finalGateExpected = true): string {
  const pending = finalGateExpected ? "not recorded (pending)" : "not part of this workflow";
  return text.replace(architectClaim, `Final Architect verdict: ${pending}`)
    .replace(prematureAcceptance, "Technical assessment: final acceptance pending");
}

/** Also protects reports rendered from older persisted packets that predate the storage guard. */
export function alignReportedArchitectClaims(text: string, verdict: string | undefined, finalGateExpected: boolean): string {
  const actual = verdict ?? (finalGateExpected ? "not recorded (pending)" : "not part of this workflow");
  const aligned = text.replace(architectClaim, `Final Architect verdict: ${actual}`);
  return verdict === undefined && finalGateExpected
    ? aligned.replace(prematureAcceptance, "Technical assessment: final acceptance pending")
    : aligned;
}
