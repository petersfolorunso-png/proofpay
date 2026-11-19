import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

/** Parse a dotenv-style file without logging values. */
export function loadEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
  return out;
}

const secretsPath = process.env.PROOFPAY_SECRETS ?? resolve(homedir(), ".secrets/aevum/wallet.env");
const storeSecretsPath = process.env.PROOFPAY_STORE_SECRETS ?? resolve(homedir(), ".secrets/aevum/proofpay-store.env");
const secrets = { ...loadEnvFile(secretsPath), ...(process.env.NODE_TEST_CONTEXT ? {} : loadEnvFile(storeSecretsPath)) };
// Public deployment info (committed) is the default source for the escrow address on Aevum.
const deployFile = resolve(import.meta.dirname, "../../deployments/aevum-testnet.json");
const deployment: Record<string, string> =
  existsSync(deployFile) && (process.env.CHAIN_ID ?? "44005") === "44005" ? JSON.parse(readFileSync(deployFile, "utf8")) : {};
// Only these keys may come from the secrets file; the owner key is never read by the server.
const SECRET_KEYS = new Set(["AGENT_PRIVATE_KEY", "DEMO_CLIENT_PRIVATE_KEY", "DEMO_FREELANCER_PRIVATE_KEY", "GEMINI_API_KEY", "DEMO_WALLETS", "DEMO_FREELANCER_X", "PROOFPAY_STORE_URL", "PROOFPAY_STORE_TOKEN", "SESSION_SECRET"]);
const env = (k: string, d?: string) => process.env[k] ?? (SECRET_KEYS.has(k) ? secrets[k] : undefined) ?? d;

export type Hex = `0x${string}`;

export const config = {
  port: Number(env("PORT", "8787")),
  chainId: Number(env("CHAIN_ID", "44005")),
  rpcUrl: env("RPC_URL", "https://rpc-test.qday.info")!,
  explorerUrl: env("EXPLORER_URL", "https://explorer-test.qday.info")!,
  tokenAddress: env("TOKEN_ADDRESS", "0x456569838f1d43009A91ebA4263147Afd7233483") as Hex,
  escrowAddress: env("ESCROW_ADDRESS", deployment.escrow ?? "") as Hex | "",
  /** Only the narrowly-scoped agent key is loaded by default. Never the owner key. */
  agentPrivateKey: env("AGENT_PRIVATE_KEY") as Hex | undefined,
  /** Demo mode: server holds two throwaway testnet wallets so judges can click through without MetaMask. */
  demoWallets: env("DEMO_WALLETS", "0") === "1",
  demoClientKey: env("DEMO_CLIENT_PRIVATE_KEY") as Hex | undefined,
  demoFreelancerKey: env("DEMO_FREELANCER_PRIVATE_KEY") as Hex | undefined,
  /** LLM provider: "gemini" (needs GEMINI_API_KEY) or "none" (deterministic rules only). */
  llmProvider: env("LLM_PROVIDER", env("GEMINI_API_KEY") ? "gemini" : "none")!,
  geminiApiKey: env("GEMINI_API_KEY"),
  geminiModel: env("GEMINI_MODEL", "gemini-3.5-flash-lite")!,
  /** If the LLM is down, may the agent still auto-release on a full deterministic rule pass? */
  allowRulesOnlyRelease: env("ALLOW_RULES_ONLY_RELEASE", "1") === "1",
  /** Minimum LLM confidence for an automatic on-chain action. */
  minConfidence: Number(env("MIN_CONFIDENCE", "0.75")),
  pollMs: Number(env("POLL_MS", "6000")),
  /** Aevum RPC caps eth_getLogs at 1,000 blocks. */
  logChunk: BigInt(env("LOG_CHUNK", "900")!),
  startBlock: env("START_BLOCK", deployment.deployBlock) ? BigInt(env("START_BLOCK", deployment.deployBlock)!) : undefined,
  dataDir: env("DATA_DIR", resolve(process.cwd(), "data"))!,
  /** Test-only: resolve fixture://name proof URLs from this directory. Never set in production. */
  proofFixturesDir: env("PROOF_FIXTURES_DIR"),
  /** Durable store (Cloudflare D1 via the proofpay-store Worker). Unset = local JSON files only. */
  storeUrl: env("PROOFPAY_STORE_URL"),
  storeToken: env("PROOFPAY_STORE_TOKEN"),
  /** HMAC key for wallet sign-in sessions. Unset = random per process (sessions end on restart). */
  sessionSecret: env("SESSION_SECRET"),
  faucetUrl: "https://faucet.qday.info/en",
  tokenDecimals: 6,
  tokenSymbol: "tUSD8",
};

export const txUrl = (h: string) => `${config.explorerUrl}/tx/${h}`;
export const addrUrl = (a: string) => `${config.explorerUrl}/address/${a}`;
