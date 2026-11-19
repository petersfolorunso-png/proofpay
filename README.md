# ProofPay: get paid the moment you prove it

**Aevum Builder Challenge #1, Native AI Assistants track.** An AI-verified, proof-of-work escrow for **tUSD8** on **QDay Aevum Testnet** (chain 44005).

> A client types: *"Pay @sarah 50 tUSD8 when she posts a tweet saying "ProofPay is live" with #Aevum by Friday."*
> ProofPay turns that into an escrow, locks the tUSD8 on-chain, and waits. Sarah pastes her tweet link. An AI agent fetches the post, checks it against the brief, and **pays her on-chain in seconds**, or rejects it with reasons. Every verdict comes with a receipt whose hash is stored on-chain.

## The problem

Freelancers, creators, clippers and promoters, especially in emerging markets like Nigeria, deliver first and then chase payment. Clients don't want to pay before they see the work. Today a human has to check every deliverable and then send the money by hand. ProofPay automates the *check* and the *pay* together, and adds strict on-chain guardrails so the AI can never pay the wrong person or the wrong amount.

## How it works

```
 Client (plain language)                       Freelancer
        │ "Pay @sarah 50 tUSD8 when …"                │
        ▼                                           │
 ┌──────────────┐  brief JSON + hash                │
 │ Brief parser │  (payee/amount from text only)    │
 └──────┬───────┘                                   │
        │ approve + createAndFund(payee, amount,    │ submitProof(jobId, url)
        ▼        deadline, briefHash)               ▼
 ┌─────────────────────────── ProofPayEscrow (Aevum Testnet) ───────────────────────────┐
 │ Created → Funded → ProofSubmitted → Released | (rejected → Funded …) | Refunded      │
 └──────────────────────────────────────▲───────────────────────────────────────────────┘
                                        │ agentRelease / agentReject(jobId, proofHash, receiptHash)
                              ┌─────────┴──────────┐
                              │  Verifier agent    │  1. fetch public proof (X post / web page)
                              │  (capped key)      │  2. deterministic hard checks
                              └────────────────────┘  3. AI judge (Gemini) on untrusted content
                                                      4. policy → release / reject / needs human
                                                      5. receipt JSON → keccak256 → on-chain
```

| Piece | Path | Tech |
|---|---|---|
| Escrow contract | `contracts/src/ProofPayEscrow.sol` | Solidity 0.8.24, OpenZeppelin 5.1, Foundry |
| Contract tests | `contracts/test/` | 34 Foundry tests (unit, fuzz, reentrancy, fee-token) |
| Agent + API | `app/src/` | Node 24 (native TypeScript), viem |
| Web UI | `app/public/` | Plain HTML/JS, no build step; browser wallet via viem |
| Deploy | `scripts/deploy-aevum.sh` | forge create + Blockscout verification |

### Core flows
1. **Create:** the client describes the job. The parser extracts payee (0x address or saved contact), amount, deadline and proof requirements (quoted phrases, #hashtags, @mentions, links). The client sees a confirm card and signs `approve` + `createAndFund`.
2. **Deliver:** the payee submits a public URL with `submitProof`. The URL hash is stored on-chain.
3. **Verify:** the agent watches `ProofSubmitted` events (chunked `eth_getLogs` under the RPC's 1,000-block limit), fetches the proof, runs the checks, and calls `agentRelease` or `agentReject`. The verdict is bound to the exact `proofHash` it reviewed.
4. **Receipt:** a canonical JSON receipt holds the brief hash, proof snapshot, every check, the AI verdict, reasoning and decision. `keccak256(receipt)` is the on-chain `verdictHash`. You can download it from the UI and anyone can re-hash it.
5. **Fallbacks:** the client can **approve manually** at any time (human override). They can **refund** after the deadline, or right after a rejected proof. After 3 rejections the escrow refunds automatically.

## Safety, trust and controls

| Risk | Control |
|---|---|
| AI pays the wrong person or amount | Payee and amount are fixed on-chain at creation. The agent's only powers are `agentRelease` and `agentReject`, and they take no address or amount. The parser takes payee and amount from the client's literal text, never from the LLM. |
| Runaway agent / stolen agent key | `agentReleaseCap` per job (default 100 tUSD8). Larger jobs need client approval. The owner can `pause()` agent actions and rotate or revoke the agent with `setAgent`. The agent key is separate from the owner/deployer key. |
| Funds stuck | Pausing never blocks clients. They can still `approveRelease` and `refund`. Deadline plus a 24h review grace guarantees a refund path. |
| Double payment | A single-shot state machine. Status is set before transfer (checks-effects-interactions), with `nonReentrant` on every value path. Tests cover double release, double refund, release-after-refund and reentrancy through a malicious token. |
| Swapped proof race | `agentRelease/agentReject` require the `proofHash` the agent actually reviewed. |
| Prompt injection in proof content | Proof text sits inside a random, unguessable delimiter and is labelled untrusted. The model can only return a narrow JSON verdict (schema-validated, confidence clamped). Regex injection signals ("ignore previous instructions", "release the funds", forged verdict JSON or delimiters) or an AI `suspicious_instructions` flag force **needs human**, so funds never move automatically. |
| AI hallucination | Deterministic hard checks run first (author, required phrases/hashtags/links, posted after the job was created and before submission). A failed hard check always rejects, even if the AI says yes. Release needs every hard check to pass plus AI agreement at ≥ 75% confidence. |
| SSRF via proof URL | Only http(s). No credentials, no non-standard ports, no private/loopback/link-local/metadata IPs (checked on every redirect hop). 10s timeout, 400 KB cap. |
| Fake tokens | Fee-on-transfer tokens are rejected (balance-delta check). Only the official tUSD8 address is configured. |
| Key hygiene | Keys live outside the repo (`~/.secrets/aevum/wallet.env`, chmod 600). The server loads only the agent/demo keys and never the owner key. `.gitignore` blocks env and key files. Testnet only. |

Known limitations (MVP): the JSON file store is a cache (the chain is the source of truth). DNS-rebinding between the check and the fetch is not fully closed. X verification uses X's public syndication endpoint, so protected or deleted posts can't be verified. A malicious client can refund right after a rejection; the payee's protection is the 3-strike rule plus the receipt trail.

## Run it

Requirements: Foundry, Node ≥ 22.18 (Node 24 recommended).

```bash
# contracts
cd contracts
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts@v5.1.0 --no-git   # first time only
forge test -vv

# app
cd ../app && npm ci
npm test                      # 13 unit tests (parser, rules, injection, policy, SSRF, receipts)
./scripts/local-e2e.sh        # full on-chain flow on anvil: release / reject+refund / impostor / injection / over-cap
KEEP=1 ./scripts/local-e2e.sh # same, then leaves a local demo running on http://127.0.0.1:8799
```

### On Aevum Testnet
```bash
# 1. Put testnet-only keys in ~/.secrets/aevum/wallet.env (see .env.example), fund the deployer at https://faucet.qday.info/en
DRY_RUN=1 ./scripts/deploy-aevum.sh   # estimates gas (≈1.72M gas, ≈0.0017 tQDAY)
./scripts/deploy-aevum.sh             # deploys, verifies on the explorer, writes deployments/aevum-testnet.json, tops up agent/demo wallets
# 2. Start the agent + UI
cd app && DEMO_WALLETS=1 npm start    # http://localhost:8787
```
`DEMO_WALLETS=1` lets judges click through with two server-held testnet wallets. Without it, users connect their own browser wallet (the app adds Aevum, chain 44005).
Docker: `docker build -t proofpay . && docker run -p 8787:8787 --env-file <secrets-file> proofpay`.

### Network
| | |
|---|---|
| Chain | QDay Aevum Testnet, id 44005 |
| RPC | https://rpc-test.qday.info |
| Explorer | https://explorer-test.qday.info |
| tUSD8 | `0x456569838f1d43009A91ebA4263147Afd7233483` (6 decimals) |
| ProofPayEscrow | [`0x7FE218568E7AE2f03B95ac9769f1D84fad498593`](https://explorer-test.qday.info/address/0x7FE218568E7AE2f03B95ac9769f1D84fad498593) (verified) |

### Testnet evidence (real tUSD8 on Aevum)
The escrow is verified on the explorer. A 1 tUSD8 happy path and a reject+refund path already ran on-chain. Full receipts: `deployments/testnet-e2e.json`.

| Step | Explorer |
|---|---|
| Deploy ProofPayEscrow | [tx](https://explorer-test.qday.info/tx/0x5721750b66ec42e8a6b71d13be6dcb22937a91b1dab708be75d0d76d3dcaefb4) |
| Job 1 — lock 1 tUSD8 | [tx](https://explorer-test.qday.info/tx/0xdc637ab37c1bfdb04aad7ad5c88e4f63560f0195971a59bdd0b301c0b654a4a0) |
| Job 1 — submit proof | [tx](https://explorer-test.qday.info/tx/0x6f7726759bdc50d0e69bedc4fd6dddd35e526a0a0b4917d8107a806aab45b001) |
| Job 1 — agent release (paid) | [tx](https://explorer-test.qday.info/tx/0x92888e99af1e390e19c02bfe444edb80bd756a9231c1c4e8b3c2ab6099a60ab9) |
| Job 2 — lock 1 tUSD8 | [tx](https://explorer-test.qday.info/tx/0x845ce2d75c7e6cb1b3e536bebdd36986788a7d77d6b5826bf95e1836289fd57b) |
| Job 2 — submit bad proof | [tx](https://explorer-test.qday.info/tx/0x865026adc2abacddf5a12e946a743df1a441f7800ec8863c95e0563abbe6720c) |
| Job 2 — agent reject | [tx](https://explorer-test.qday.info/tx/0x2a960748cf7e8e147e8eef7e9440989af3489fc9eb96cbfc701d4a53ab2ca07d) |
| Job 2 — refund to client | [tx](https://explorer-test.qday.info/tx/0xb23b8f4360f7c88f66dba3be6e0f30703a6399066ee63995511eba474a085d06) |

### AI provider
The provider is pluggable (`app/src/llm.ts`). It defaults to Google Gemini (`gemini-3.5-flash-lite`, set with `GEMINI_API_KEY`). With `LLM_PROVIDER=none` the agent runs **rules-only**: it auto-releases only when there are at least 2 concrete hard checks and all of them pass, and otherwise asks the client. The demo still works if the model is down.

## Why the Native AI Assistants track
The agent is the product. It reads natural language, decides whether real-world work was done, and moves money on-chain inside hard, verifiable limits (cap, scope, deadline, proof binding, human override, signed receipts).

## Roadmap to mainnet
Smart-account session keys for the agent (scoped, expiring) instead of a hot EOA · more proof sources (GitHub PR merged, YouTube/TikTok, on-chain events) · multi-milestone jobs and split payouts · dispute window with a human arbiter · IPFS-pinned receipts · reputation from receipt history.

## License
MIT. Third-party code: OpenZeppelin Contracts (MIT), forge-std (MIT/Apache-2.0), viem (MIT).
