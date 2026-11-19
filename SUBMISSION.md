# ProofPay — DoraHacks submission draft

**Do not submit, register, or publish until Mari says so.**

Hackathon: [Aevum Builder Challenge #1](https://dorahacks.io/hackathon/qday)  
Track (pick one): **Native AI Assistants**  
Deadline: **11 December 2026, 9:00 AM WAT** (08:00 UTC). Late entries are not accepted.  
If top 5: live Demo Day on **15 December 2026, 7:00 AM WAT**. A pre-recorded video cannot replace that call.

DoraHacks marks this event **GitHub/GitLab/Bitbucket link required** and **Demo video required** (`mandatoryVideoLink: true`). The starter kit also requires a demo video link that works without login.

---

## Form fields (draft text — paste into DoraHacks)

### Project name
ProofPay

### Tagline / one-liner
Get paid the moment you prove it.

### Track
Native AI Assistants

### Tags (suggested)
AI agents, escrow, stablecoin payments, tUSD8, Aevum, QDay, freelancers

### Logo
Optional. The product mark is a green check on a dark background (same as the demo and site). A PNG/SVG logo has not been exported yet — make one before submit if the form asks for an image.

### Short intro (if the form has a short field)
ProofPay is an AI-verified escrow for tUSD8 on QDay Aevum Testnet. A client describes a job in plain words, the money is locked on-chain, and a freelancer gets paid automatically when they submit public proof that matches the brief — or the agent rejects it in plain language and the client can get a refund.

### Full description (markdown)

**The problem.** Freelancers, creators and promoters often deliver first and then chase payment in chat. Clients do not want to pay before they see the work. Today a human has to check every deliverable and then send the money by hand.

**What ProofPay does.** A client types something like: *Pay @ada 1 tUSD8 when she posts a tweet saying "ProofPay is live" with #Aevum by Friday.* ProofPay turns that into an escrow, locks official tUSD8 on Aevum, and waits. The freelancer pastes a public proof link. An agent fetches the proof, checks it against the brief (right account, right words, right hashtag, posted in range), and either **releases tUSD8 on-chain** or rejects it with reasons. Every verdict comes with a downloadable receipt whose hash is stored on-chain.

**Why this track.** The agent is the product. It parses unstructured payment requests, stages a reviewable tUSD8 escrow, reconciles on-chain settlement against the brief in plain language, and exports an accounting-ready receipt.

**On-chain evidence (Aevum Testnet, chain 44005).**

- Escrow (verified): https://explorer-test.qday.info/address/0x7FE218568E7AE2f03B95ac9769f1D84fad498593
- Official tUSD8: `0x456569838f1d43009A91ebA4263147Afd7233483`
- Happy path (1 tUSD8 paid to the freelancer):
  - Lock: https://explorer-test.qday.info/tx/0xdc637ab37c1bfdb04aad7ad5c88e4f63560f0195971a59bdd0b301c0b654a4a0
  - Proof submitted: https://explorer-test.qday.info/tx/0x6f7726759bdc50d0e69bedc4fd6dddd35e526a0a0b4917d8107a806aab45b001
  - Agent release: https://explorer-test.qday.info/tx/0x92888e99af1e390e19c02bfe444edb80bd756a9231c1c4e8b3c2ab6099a60ab9
- Failure path (bad proof rejected, then refunded):
  - Lock: https://explorer-test.qday.info/tx/0x845ce2d75c7e6cb1b3e536bebdd36986788a7d77d6b5826bf95e1836289fd57b
  - Proof submitted: https://explorer-test.qday.info/tx/0x865026adc2abacddf5a12e946a743df1a441f7800ec8863c95e0563abbe6720c
  - Agent reject: https://explorer-test.qday.info/tx/0x2a960748cf7e8e147e8eef7e9440989af3489fc9eb96cbfc701d4a53ab2ca07d
  - Refund: https://explorer-test.qday.info/tx/0xb23b8f4360f7c88f66dba3be6e0f30703a6399066ee63995511eba474a085d06

Full hashes and receipts: `deployments/testnet-e2e.json`.

**Safety.** Payee and amount are fixed in the contract at creation. The agent can only call `agentRelease` or `agentReject` (capped). Prompt injection in proof content forces a human review. Clients can approve manually or refund after a rejection or a missed deadline.

### GitHub / source link (required)
**Not public yet.** Create a public repo and push `proofpay` (MIT). Suggested name: `proofpay`. Do not commit `.env` or `~/.secrets`. Then paste the URL here.

### Demo video link (required, must work without login)
**Not uploaded yet.** File ready at `/workspace/hackathons/aevum/demo/proofpay-demo.mp4` (82.6 seconds, 1280×720). Upload to YouTube as unlisted (or another login-free host) and paste the link.

### Live demo / website
**Not hosted yet.** Judges can also run the packaged Docker image (satisfies the official “live deployment” rule):

```bash
docker build -t proofpay .
docker run -p 8787:8787 --env-file <secrets-file> -e DEMO_WALLETS=1 proofpay
# open http://localhost:8787
```

Optional later: a free Render web service (workspace “Mari Space”) with `DEMO_WALLETS=1` and the agent/demo keys. Do not deploy until Mari says so. No new paid account and no card charge.

### Social links
Add the X launch post after it is published, and tag @terminal3io only if that is still desired for the other grant. For this challenge, official channels are QDay / Aevum (Discord: https://discord.gg/bYPhjmrSfK).

### Team
Solo: Mari (Peters Folorunso). Add her DoraHacks account, X handle, and contact email when submitting.

---

## Official deliverable checklist

- [ ] Public GitHub repo, MIT, no secrets, README a stranger can run
- [x] Contracts on Aevum Testnet (verified) + tUSD8 settlement evidence
- [ ] Live demo URL **or** judges can run Docker (Docker is already in the repo)
- [x] Documentation (README + this page + `deployments/`)
- [ ] Demo video uploaded, login-free link pasted on DoraHacks
- [ ] Registered as a hacker and project submitted on https://dorahacks.io/hackathon/qday before 11 Dec 2026, 9:00 AM WAT
- [ ] If top 5: be on the live call 15 Dec 2026, 7:00 AM WAT

## What still needs Mari's OK

1. Create/push a **public** GitHub repo (nothing has been pushed).
2. Upload the demo video to YouTube (unlisted is fine) and send the link.
3. Optionally deploy the app on Render free (only if it will not charge a card).
4. Register on DoraHacks and submit this project (one track: Native AI Assistants).
5. Post the launch on X, then paste that post link into the submission if useful.
