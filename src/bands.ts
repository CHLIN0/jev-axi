import type { Thresholds } from "./config.js";

/**
 * A band turns a confidence into a policy the agent can branch on without
 * doing the math: act automatically, confirm with the user, or escalate.
 */
export type Band = "act" | "confirm" | "escalate";

export function bandForConfidence(confidence: number, t: Thresholds): Band {
  if (confidence >= t.act) return "act";
  if (confidence >= t.confirm) return "confirm";
  return "escalate";
}

/**
 * Noul answers carry no confidence. Treat distance from 0.5 (rescaled to 0..1)
 * as the confidence: 0.95 and 0.05 are both confident, 0.5 is not.
 */
export function noulConfidence(p: number): number {
  return Math.min(1, Math.abs(p - 0.5) * 2);
}

export function bandForNoul(p: number, t: Thresholds): Band {
  return bandForConfidence(noulConfidence(p), t);
}
