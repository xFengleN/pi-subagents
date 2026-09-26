import { spawn } from "node:child_process";
import type { FactoryVerificationResult } from "./types.js";

/** Execute the contract's reproducible check, not a model judgment. */
export async function verifyFactoryTarget(
  cwd: string,
  _targetId: string,
  instruction: { command?: string; evidence: string; ownerPending?: boolean },
): Promise<FactoryVerificationResult> {
  if (instruction.ownerPending) return { status: "owner_pending", evidence: instruction.evidence };
  if (!instruction.command?.trim()) return { status: "unavailable", evidence: instruction.evidence || "No reproducible verification command supplied" };
  const command = instruction.command;
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    let output = "";
    const capture = (chunk: Buffer): void => { output = (output + chunk.toString()).slice(-16_384); };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const timeout = setTimeout(() => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { child.kill("SIGKILL"); }
    }, 120_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      resolve({ status: "failed", command, evidence: `Command could not start: ${error.message}` });
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ status: code === 0 && !signal ? "passed" : "failed", command, evidence: `exit=${code ?? "unknown"}${signal ? ` signal=${signal}` : ""}; ${output.trim()}` });
    });
  });
}
