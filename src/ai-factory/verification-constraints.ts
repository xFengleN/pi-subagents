import type { ExecutionContractPacket } from "./types.js";

/** Check literal owner-supplied shell instructions before executing a Lead-authored contract. */
export function validateVerificationConstraints(task: string, contract: ExecutionContractPacket): string[] {
  const checks = [...Object.values(contract.verification), ...(contract.runVerification ?? [])];
  const commands = checks.map((instruction) => instruction.command).filter((command): command is string => command !== undefined);
  const issues: string[] = [];
  const requiredEnvironment = new Set<string>();
  const snippets = [...task.matchAll(/`([^`\n]+)`/g)].map((match) => ({ literal: match[1].trim(), index: match.index, length: match[0].length }));
  for (const fence of task.matchAll(/```(?:bash|sh|shell)\s*\n([\s\S]*?)\n```/g)) {
    for (const line of fence[1].split("\n")) {
      const literal = line.trim();
      if (literal && !literal.startsWith("#")) snippets.push({ literal, index: fence.index, length: fence[0].length });
    }
  }
  for (const { literal, index, length } of snippets) {
    const assignment = /^(?:[A-Za-z_][A-Za-z_0-9]*=(?:"[^"]*"|'[^']*'|[^\s]+))(?:\s+|$)/.exec(literal);
    const before = task.slice(Math.max(0, index - 180), index);
    const context = task.slice(Math.max(0, index - 180), Math.min(task.length, index + length + 180));
    if (!/\b(?:verif(?:y|ication)|test(?:s|ing)?|check(?:s)?|browser)\b/i.test(context)) continue;
    if (/(?:instead of|rather than|avoid|never|do not(?: use| run)?|don't(?: use| run)?|not run|not|generic)\s*$/i.test(before)) continue;
    if (assignment === null) {
      if (/^(?:npm|npx|node|pnpm|yarn|bun|sh|bash|python\d*|\.\/)\s/.test(literal) && !commands.includes(literal)) {
        issues.push(`Owner-specified verification command was omitted or changed: ${literal}`);
      }
      continue;
    }
    const command = literal.slice(assignment[0].length).trim();
    if (command) {
      if (!commands.includes(literal)) issues.push(`Owner-specified verification command was omitted or changed: ${literal}`);
    } else if (/\b(?:required|must|use|using)\b/i.test(context)) {
      requiredEnvironment.add(assignment[0].trim());
    }
  }
  for (const environment of requiredEnvironment) {
    if (checks.some((check) => check.command && /\b(?:test|verify|check|e2e|browser|playwright)\b/i.test(`${check.command} ${check.evidence}`) && !check.command.includes(environment))) {
      issues.push(`Required verification environment was omitted from a planned check: ${environment}`);
    }
  }
  return issues;
}
