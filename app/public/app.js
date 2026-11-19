// ProofPay UI. Plain ES modules, no build step. All server/proof text is HTML-escaped before rendering.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
let CFG = null;
let ABI = null;
let selected = null;
let pollTimer = null;
let wallet = null; // { client, account, viem } when an injected wallet is connected
let draft = null;

const api = async (path, opts = {}) => {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
};
const toast = (msg, err = false) => {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (err ? " err" : "");
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), err ? 7000 : 3500);
};
const txLink = (h, label = "view tx") => (h ? `<a href="${CFG.explorerUrl}/tx/${esc(h)}" target="_blank" rel="noopener">${esc(label)} ↗</a>` : "");
const addrLink = (a) => `<a class="mono" href="${CFG.explorerUrl}/address/${esc(a)}" target="_blank" rel="noopener">${esc(short(a))}</a>`;
const useDemo = () => CFG.demo && $("#demoSwitch").checked && !wallet;
const busy = async (btn, fn) => {
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span>${label}`;
  try {
    return await fn();
  } catch (e) {
    toast(e.shortMessage || e.message, true);
  } finally {
    btn.disabled = false;
    btn.innerHTML = label;
  }
};

// ------------------------------------------------------------------ boot
async function boot() {
  CFG = await api("/api/config");
  ABI = await (await fetch("/abi.json")).json();
  $("#net").innerHTML = `<b>●</b> ${CFG.chainId === 44005 ? "Aevum Testnet" : "Local chain"} (${CFG.chainId}) · AI: ${esc(CFG.llm)}`;
  $("#footerInfo").innerHTML = CFG.escrow
    ? `Escrow ${addrLink(CFG.escrow)} · Agent ${CFG.agent ? addrLink(CFG.agent) : "read-only"} · cap ${esc(CFG.params?.agentReleaseCap ?? "?")} tUSD8/job`
    : "Escrow not deployed yet";
  if (CFG.demo) $("#demoSwitchWrap").hidden = false;
  const ex = [
    `Pay @ada 5 tUSD8 when she posts a tweet saying "ProofPay is live" with #Aevum by tomorrow`,
    `Pay 0x… 20 tUSD8 for a blog post that links qday.io within 3 days`,
    `Pay @ada $3 for a GitHub PR to proofpay with "fix" in the title by friday`,
  ];
  $("#examples").innerHTML = ex.map((e, i) => `<button class="chip" data-i="${i}">Example ${i + 1}</button>`).join("");
  $("#examples").onclick = (e) => {
    const i = e.target.dataset?.i;
    if (i !== undefined) $("#jobText").value = ex[i];
  };
  renderWallets();
  loadJobs();
  const m = location.pathname.match(/^\/job\/(\d+)/);
  if (m) openJob(m[1]);
}

async function renderWallets() {
  if (wallet) {
    $("#walletInfo").innerHTML = `Connected: ${addrLink(wallet.account)} — you can create jobs (as client) or submit proof (as the payee).`;
    return;
  }
  if (useDemo()) {
    try {
      const b = await api("/api/demo/balances");
      const card = (t, x, sub) => `<div class="bal"><div class="muted">${t}</div><div class="big">${Number(x.tUSD8).toLocaleString()} tUSD8</div><div class="mono">${addrLink(x.address)} · ${Number(x.gas).toFixed(4)} tQDAY</div><div class="muted" style="font-size:12px">${sub}</div></div>`;
      $("#walletInfo").innerHTML = `<div class="balances">${card("Client (demo)", b.client, "locks funds")}${card("Freelancer (demo)", b.freelancer, "@ada · gets paid")}${card("Escrow contract", b.escrow, "held until proof")}</div>`;
    } catch (e) {
      $("#walletInfo").textContent = "Demo wallets: " + e.message;
    }
  } else {
    $("#walletInfo").innerHTML = `Connect a browser wallet on Aevum Testnet (chain ${CFG.chainId}) to create or deliver jobs. Get tQDAY + tUSD8 from the <a href="https://faucet.qday.info/en" target="_blank">faucet</a>.`;
  }
}

$("#demoSwitch").onchange = renderWallets;
$("#connectBtn").onclick = () =>
  busy($("#connectBtn"), async () => {
    if (!window.ethereum) throw new Error("No browser wallet found. Install MetaMask or Rabby, or use demo wallets.");
    const viem = await import("https://esm.sh/viem@2.58.1");
    const chain = viem.defineChain({ id: CFG.chainId, name: "QDay Aevum Testnet", nativeCurrency: { name: "tQDAY", symbol: "tQDAY", decimals: 18 }, rpcUrls: { default: { http: [CFG.rpcUrl] } }, blockExplorers: { default: { name: "Explorer", url: CFG.explorerUrl } } });
    const client = viem.createWalletClient({ chain, transport: viem.custom(window.ethereum) });
    const [account] = await client.requestAddresses();
    try {
      await client.switchChain({ id: chain.id });
    } catch {
      await client.addChain({ chain });
    }
    const pub = viem.createPublicClient({ chain, transport: viem.http(CFG.rpcUrl) });
    wallet = { client, account, viem, pub, chain };
    $("#connectBtn").textContent = short(account);
    renderWallets();
  });

async function walletWrite(address, abi, functionName, args) {
  const { client, account, pub, chain } = wallet;
  const { request, result } = await pub.simulateContract({ address, abi, functionName, args, account });
  const hash = await client.writeContract({ ...request, chain, account });
  toast("Sent. Waiting for confirmation…");
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error("Transaction reverted");
  return { hash, result };
}

// ------------------------------------------------------------------ drafting
$("#draftBtn").onclick = () =>
  busy($("#draftBtn"), async () => {
    const text = $("#jobText").value.trim();
    const r = await api("/api/parse", { method: "POST", body: { text } });
    draft = r;
    const b = r.brief;
    const reqs = [
      ...(b.proof.authorHandle ? [`Posted by <b>@${esc(b.proof.authorHandle)}</b>`] : []),
      `Platform: <b>${esc(b.proof.platform === "x" ? "X post" : b.proof.platform)}</b>`,
      ...b.proof.mustInclude.map((t) => `Contains <b>${esc(t)}</b>`),
      ...b.proof.mustLinkTo.map((t) => `Links to <b>${esc(t)}</b>`),
      ...(b.proof.postedAfterCreation ? ["Posted after the escrow is created"] : []),
    ];
    const overCap = CFG.params && Number(b.amount) > Number(CFG.params.agentReleaseCap);
    $("#draft").innerHTML = `<div class="confirm">
      <div class="kv">
        <div>Pay</div><div>${addrLink(b.payee)}${b.payeeHandle ? ` (@${esc(b.payeeHandle)})` : ""}</div>
        <div>Amount</div><div class="big">${esc(b.amount)} tUSD8</div>
        <div>Deadline</div><div>${new Date(b.deadline * 1000).toLocaleString()}</div>
        <div>Done when</div><div><ul class="req">${reqs.map((x) => `<li>${x}</li>`).join("")}</ul><div class="muted">${esc(b.proof.notes)}</div></div>
        <div>Brief hash</div><div class="mono">${esc(r.briefHash)}</div>
        <div>Safety</div><div class="muted">The agent can only pay <b>this</b> address <b>this</b> amount, only after proof, and only up to ${esc(CFG.params?.agentReleaseCap ?? "?")} tUSD8. You can approve manually any time, and refund after the deadline.${overCap ? ` <span class="warn">Above the auto-pay cap: you'll approve the payout yourself.</span>` : ""}</div>
      </div>
      ${r.warnings.map((w) => `<div class="warn">⚠ ${esc(w)}</div>`).join("")}
      <div class="row between"><span class="muted" style="font-size:12px">Parsed by ${esc(r.parser)}. Amount and payee always come from your words, never from the AI.</span><button id="lockBtn">Lock ${esc(b.amount)} tUSD8</button></div>
    </div>`;
    $("#lockBtn").onclick = () => busy($("#lockBtn"), lockFunds);
  });

async function lockFunds() {
  if (!CFG.escrow) throw new Error("Escrow contract not deployed yet");
  const b = draft.brief;
  let jobId;
  if (useDemo()) {
    const r = await api("/api/demo/create", { method: "POST", body: { briefHash: draft.briefHash } });
    jobId = r.jobId;
    toast(`Locked! ${r.steps.map((s) => s.label).join(" → ")}`);
  } else {
    if (!wallet) throw new Error("Connect a wallet (or enable demo wallets) first");
    const amount = BigInt(draft.amountBaseUnits);
    const allowance = await wallet.pub.readContract({ address: CFG.token, abi: ABI.erc20, functionName: "allowance", args: [wallet.account, CFG.escrow] });
    if (allowance < amount) await walletWrite(CFG.token, ABI.erc20, "approve", [CFG.escrow, amount]);
    const r = await walletWrite(CFG.escrow, ABI.escrow, "createAndFund", [b.payee, amount, BigInt(b.deadline), draft.briefHash]);
    jobId = r.result.toString();
    await api(`/api/jobs/${jobId}/created`, { method: "POST", body: { txHash: r.hash } });
    toast("Locked in escrow!");
  }
  $("#draft").innerHTML = "";
  $("#jobText").value = "";
  await loadJobs();
  openJob(jobId);
  renderWallets();
}

// ------------------------------------------------------------------ jobs
$("#refreshBtn").onclick = () => loadJobs();
async function loadJobs() {
  try {
    const jobs = await api("/api/jobs");
    $("#jobs").innerHTML = jobs.length
      ? jobs
          .map((j) => `<div class="job ${selected === j.jobId ? "sel" : ""}" data-id="${esc(j.jobId)}"><span class="muted">#${esc(j.jobId)}</span><span>${esc(j.brief?.title ?? "(brief not registered here)")}</span><span class="amt">${esc(j.amount)} tUSD8</span><span class="status s-${esc(j.status)}">${esc(label(j))}</span></div>`)
          .join("")
      : `<p class="muted">No jobs yet. Describe one above.</p>`;
    document.querySelectorAll(".job").forEach((el) => (el.onclick = () => openJob(el.dataset.id)));
  } catch (e) {
    $("#jobs").innerHTML = `<p class="muted">${esc(e.message)}</p>`;
  }
}
const label = (j) => ({ Funded: j.rejections ? "Proof rejected" : "Waiting for proof", ProofSubmitted: j.agentState === "needs_human" ? "Needs your review" : "Verifying", Released: "Paid", Refunded: "Refunded", Created: "Not funded", Cancelled: "Cancelled" })[j.status] ?? j.status;

async function openJob(id) {
  selected = String(id);
  history.replaceState(null, "", `/job/${id}`);
  clearTimeout(pollTimer);
  const j = await api(`/api/jobs/${id}`).catch((e) => (toast(e.message, true), null));
  if (!j) return;
  renderJob(j);
  loadJobs();
  if (["ProofSubmitted"].includes(j.status) && j.agentState !== "needs_human") pollTimer = setTimeout(() => openJob(id), 2500);
}

function renderJob(j) {
  const el = $("#jobDetail");
  el.hidden = false;
  const r = j.receipts?.at(-1);
  const steps = [
    ["Locked", ["Funded", "ProofSubmitted", "Released", "Refunded"].includes(j.status) || j.rejections > 0],
    ["Proof submitted", ["ProofSubmitted", "Released"].includes(j.status) || j.rejections > 0],
    ["AI verified", j.status === "Released" || !!r],
    [j.status === "Refunded" ? "Refunded" : "Paid", ["Released", "Refunded"].includes(j.status)],
  ];
  const live = j.status === "ProofSubmitted" && j.agentState !== "needs_human";
  const isClient = useDemo() || (wallet && wallet.account.toLowerCase() === j.client.toLowerCase());
  const isPayee = useDemo() || (wallet && wallet.account.toLowerCase() === j.payee.toLowerCase());
  const b = j.brief;
  el.innerHTML = `
    <div class="row between"><h2>Job #${esc(j.jobId)} · ${esc(j.amount)} tUSD8</h2><span class="status s-${esc(j.status)}">${esc(label(j))}</span></div>
    <div class="muted">${esc(b?.title ?? "")}</div>
    <div class="timeline">${steps.map(([t, done], i) => `<div class="step ${done ? (t === "Refunded" ? "bad" : "done") : ""} ${live && i === 2 ? "live" : ""}">${t}</div>`).join("")}</div>
    <div class="kv" style="margin-top:12px">
      <div>Client</div><div>${addrLink(j.client)}</div>
      <div>Payee</div><div>${addrLink(j.payee)}${b?.payeeHandle ? ` (@${esc(b.payeeHandle)})` : ""}</div>
      <div>Deadline</div><div>${new Date(j.deadline * 1000).toLocaleString()}</div>
      ${b ? `<div>Done when</div><div>${esc(b.proof.notes)}<br><span class="muted">Must include: ${esc(b.proof.mustInclude.join(", ") || "—")}${b.proof.mustLinkTo.length ? ` · links: ${esc(b.proof.mustLinkTo.join(", "))}` : ""}</span></div>` : ""}
      ${j.proofUrl ? `<div>Proof</div><div>${/^https?:\/\//i.test(j.proofUrl) ? `<a href="${esc(j.proofUrl)}" target="_blank" rel="noopener nofollow">${esc(j.proofUrl)}</a>` : esc(j.proofUrl)} ${txLink(j.proofTx, "submit tx")}</div>` : ""}
      ${j.createTx ? `<div>Escrow tx</div><div>${txLink(j.createTx)}</div>` : ""}
      <div>On-chain hashes</div><div class="mono">brief ${esc(short(j.briefHash))} · proof ${esc(short(j.proofHash))} · verdict ${esc(short(j.verdictHash))}</div>
    </div>
    ${live ? `<div class="verdict"><span class="spinner"></span> ${esc(j.agentNote || "AI agent is fetching the proof and checking it against the brief…")}</div>` : ""}
    ${r ? verdictCard(j, r) : ""}
    ${j.agentState === "error" ? `<div class="warn">Agent error: ${esc(j.agentNote)} <button class="ghost small" id="retryBtn">Retry verification</button></div>` : ""}
    ${j.status === "Funded" && isPayee ? `<h3>Deliver: paste your public proof link</h3><div class="row gap"><input type="text" id="proofUrl" placeholder="https://x.com/you/status/…" style="flex:1"/><button id="proofBtn" class="blue">Submit proof</button></div>${j.rejections ? `<div class="warn">Previous proof was rejected (${j.rejections}/3). Fix it and resubmit before the deadline.</div>` : ""}` : ""}
    ${isClient && ["Funded", "ProofSubmitted"].includes(j.status) ? `<h3>Client controls</h3><div class="row gap"><button class="ghost" id="approveBtn">Approve & pay manually</button>${j.refundable ? `<button class="danger" id="refundBtn">Refund me</button>` : `<span class="muted" style="font-size:13px">Refund unlocks after the deadline${j.status === "ProofSubmitted" ? " + 24h review window" : " or after a rejected proof"}.</span>`}</div>` : ""}
  `;
  const on = (id, fn) => $(id) && ($(id).onclick = () => busy($(id), fn));
  on("#proofBtn", async () => {
    const url = $("#proofUrl").value.trim();
    if (!/^https?:\/\//.test(url)) throw new Error("Paste a full public link starting with https://");
    if (useDemo()) await api("/api/demo/proof", { method: "POST", body: { jobId: j.jobId, url } });
    else {
      const r = await walletWrite(CFG.escrow, ABI.escrow, "submitProof", [BigInt(j.jobId), url]);
      await api(`/api/jobs/${j.jobId}/proof`, { method: "POST", body: { url, txHash: r.hash } });
    }
    toast("Proof is on-chain. The agent is checking it now…");
    openJob(j.jobId);
  });
  on("#approveBtn", async () => {
    if (!confirm(`Pay ${j.amount} tUSD8 to ${j.payee} now?`)) return;
    if (useDemo()) await api("/api/demo/approve", { method: "POST", body: { jobId: j.jobId } });
    else await walletWrite(CFG.escrow, ABI.escrow, "approveRelease", [BigInt(j.jobId), "0x" + "00".repeat(31) + "01"]);
    toast("Paid by client approval.");
    openJob(j.jobId);
    renderWallets();
  });
  on("#refundBtn", async () => {
    if (useDemo()) await api("/api/demo/refund", { method: "POST", body: { jobId: j.jobId } });
    else await walletWrite(CFG.escrow, ABI.escrow, "refund", [BigInt(j.jobId)]);
    toast("Refunded.");
    openJob(j.jobId);
    renderWallets();
  });
  on("#retryBtn", async () => {
    await api(`/api/jobs/${j.jobId}/verify`, { method: "POST", body: {} });
    openJob(j.jobId);
  });
  if (["Released", "Refunded"].includes(j.status)) renderWallets();
}

function verdictCard(j, r) {
  const d = r.body.decision;
  const title = { release: "✅ Proof accepted — paid", reject: "❌ Proof rejected", needs_human: "✋ Needs your review" }[d];
  const ai = r.body.llm;
  return `<div class="verdict ${esc(d)}">
    <div class="big">${title}</div>
    <p>${esc(r.body.reasoning)}</p>
    <ul class="checks">${r.body.checks.map((c) => `<li><span class="${c.pass ? "ok" : "no"}">${c.pass ? "✓" : "✗"}</span> ${esc(c.label)}${c.detail ? ` <span class="muted">(${esc(c.detail)})</span>` : ""}</li>`).join("")}</ul>
    ${ai ? `<div class="muted" style="font-size:13px">AI judge: ${esc(ai.provider)}/${esc(ai.model)} · ${ai.error ? "unavailable: " + esc(ai.error) : `${ai.meetsBrief ? "meets brief" : "does not meet brief"} · ${Math.round(ai.confidence * 100)}%`}</div>` : `<div class="muted" style="font-size:13px">AI judge: ${r.body.checks.some((c) => !c.pass) ? "skipped (a hard rule failed)" : "rules-only mode"}</div>`}
    ${r.body.injectionFlags.length ? `<div class="warn">Prompt-injection signals in the proof: ${esc(r.body.injectionFlags.join(", "))}</div>` : ""}
    <div class="row between" style="font-size:13px">
      <span class="mono">receipt ${esc(short(r.receiptHash))} ${r.txHash ? "= on-chain verdictHash" : ""}</span>
      <span class="row gap">${txLink(r.txHash, r.action === "agentRelease" ? "payout tx" : "verdict tx")}<a href="/api/jobs/${esc(j.jobId)}/receipt" download>Download receipt</a></span>
    </div>
    ${r.error ? `<div class="warn">${esc(r.error)}</div>` : ""}
  </div>`;
}

boot().catch((e) => toast(e.message, true));
