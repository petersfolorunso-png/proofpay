import { keccak256, toBytes } from "viem";

/** Deterministic JSON (sorted keys, no whitespace) so hashes are reproducible by anyone. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  const o = v as Record<string, unknown>;
  return (
    "{" +
    Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k]))
      .join(",") +
    "}"
  );
}

export const hashJson = (v: unknown) => keccak256(toBytes(canonicalJson(v)));
