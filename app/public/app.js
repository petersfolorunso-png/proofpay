// ProofPay UI. Plain ES modules, no build step. All server/proof text is HTML-escaped before rendering.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
let CFG = null;
let ABI = null;
let selected = null;
let pollTimer = null;
let wallet = null; // { client, account, viem, pub, chain } when an injected wallet is connected
let session = null; // { token, owner, expiresAt } after a free personal_sign sign-in
let draft = null;
const eth = () => window.ethereum;
const isMobile = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

const api = async (path, opts = {}) => {
  const headers = { "content-type": "application/json" };
  if (opts.auth && session) headers.authorization = `Bearer ${session.token}`;
  const res = await fetch(path, { headers, method: opts.method, body: opts.body ? JSON.stringify(opts.body) : undefined });
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
const useDemo = () => !!CFG.demo && $("#demoSwitch").checked && !wallet;
const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const faucetHtml = () => `<a href="${esc(CFG.faucet || "https://faucet.qday.info/en")}" target="_blank" rel="noopener">QDay faucet</a>`;
const shareUrl = (id) => `${location.origin}/job/${id}`;
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
  else $("#demoSwitch").checked = false;
  const ex = [
    `Pay @sarah 1 tUSD8 when she posts a tweet saying "ProofPay is live" with #Aevum by tomorrow`,
    `Pay 0x… 1 tUSD8 for a blog post that links qday.io within 3 days`,
    `Pay @sarah $0.5 for a GitHub PR to proofpay with "fix" in the title by friday`,
  ];
  $("#examples").innerHTML = ex.map((e, i) => `<button class="chip" data-i="${i}">Example ${i + 1}</button>`).join("");
  $("#examples").onclick = (e) => {
    const i = e.target.dataset?.i;
    if (i !== undefined) $("#jobText").value = ex[i];
  };
  await reconnectSilently();
  renderAll();
  const m = location.pathname.match(/^\/job\/(\d+)/) || location.search.match(/[?&]job=(\d+)/);
  if (m) {
    await openJob(m[1]);
    $("#jobDetail").scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function renderAll() {
  renderMode();
  renderWallets();
  loadPeople();
  loadJobs();
  if (selected) openJob(selected);
}

function renderMode() {
  const demo = useDemo();
  const b = $("#modeBanner");
  b.className = "mode " + (wallet ? "mode-wallet" : demo ? "mode-demo" : "mode-none");
  b.innerHTML = wallet
    ? `🔐 <b>Your wallet</b> · ${addrLink(wallet.account)} on Aevum testnet. Jobs, saved people and payments use this wallet. <button class="ghost small" id="disconnectBtn">Disconnect</button>`
    : demo
      ? `🧪 <b>Demo mode</b> · shared test wallets anyone can click through, no wallet needed. Connect your own wallet to use ProofPay for real (still free testnet money).`
      : `Connect a wallet to create a job or deliver one. Everything runs on the free Aevum testnet.`;
  $("#connectBtn").textContent = wallet ? short(wallet.account) : "Connect wallet";
  $("#demoSwitchWrap").hidden = !CFG.demo || !!wallet;
  $("#jobsTitle").textContent = wallet ? "2 · My jobs" : demo ? "2 · Jobs (demo)" : "2 · Recent jobs";
  const d = $("#disconnectBtn");
  if (d) d.onclick = disconnect;
}

async function walletBalances(addr) {
  const { pub, viem } = wallet;
  const [t, g] = await Promise.all([
    pub.readContract({ address: CFG.token, abi: ABI.erc20, functionName: "balanceOf", args: [addr] }),
    pub.getBalance({ address: addr }),
  ]);
  return { tUSD8: viem.formatUnits(t, CFG.tokenDecimals), gas: viem.formatUnits(g, 18), rawT: t, rawG: g };
}

async function renderWallets() {
  if (wallet) {
    $("#walletInfo").innerHTML = `<p class="muted">Loading your balances…</p>`;
    try {
      const b = await walletBalances(wallet.account);
      const empty = b.rawT === 0n || b.rawG === 0n;
      $("#walletInfo").innerHTML = `<div class="balances"><div class="bal"><div class="muted">Your wallet</div><div class="big">${Number(b.tUSD8).toLocaleString()} tUSD8</div><div class="mono">${addrLink(wallet.account)} · ${Number(b.gas).toFixed(4)} tQDAY</div><div class="muted" style="font-size:12px">tUSD8 pays jobs · tQDAY pays the tiny network fee</div></div></div>
        ${empty ? `<div class="callout">💧 ${b.rawG === 0n ? "You need a little <b>tQDAY</b> for network fees" : ""}${b.rawG === 0n && b.rawT === 0n ? " and " : b.rawT === 0n ? "You need " : ""}${b.rawT === 0n ? "<b>tUSD8</b> to pay for jobs" : ""}. They're free test tokens: get them from the ${faucetHtml()} (or the faucet bot in the QDay Discord), then tap Refresh. <div class="mono" style="margin-top:6px">Your address: ${esc(wallet.account)} <button class="ghost small" id="copyAddrBtn">Copy</button></div></div>` : ""}`;
      const c = $("#copyAddrBtn");
      if (c) c.onclick = () => copyText(wallet.account, "Address copied");
    } catch (e) {
      $("#walletInfo").innerHTML = `Connected: ${addrLink(wallet.account)}. <span class="muted">Couldn't read balances (${esc(e.message)}).</span>`;
    }
    return;
  }
  if (useDemo()) {
    try {
      const b = await api("/api/demo/balances");
      const card = (t, x, sub) => `<div class="bal"><div class="muted">${t}</div><div class="big">${Number(x.tUSD8).toLocaleString()} tUSD8</div><div class="mono">${addrLink(x.address)} · ${Number(x.gas).toFixed(4)} tQDAY</div><div class="muted" style="font-size:12px">${sub}</div></div>`;
      $("#walletInfo").innerHTML = `<div class="balances">${card("Client (demo)", b.client, "locks funds")}${card("Freelancer (demo)", b.freelancer, "@sarah · gets paid")}${card("Escrow contract", b.escrow, "held until proof")}</div>`;
    } catch (e) {
      $("#walletInfo").textContent = "Demo wallets: " + e.message;
    }
  } else {
    $("#walletInfo").innerHTML = noWalletHelp();
  }
}

function noWalletHelp() {
  const here = `${location.host}${location.pathname}${location.search}`;
  if (eth()) return `<p>Tap <b>Connect wallet</b>. We'll add the Aevum testnet (chain ${CFG.chainId}) to your wallet for you. Free test tokens: ${faucetHtml()}.</p>`;
  if (isMobile())
    return `<p>On a phone, open ProofPay inside your wallet app's browser:</p>
      <div class="row gap"><a class="btn" href="https://metamask.app.link/dapp/${esc(here)}">Open in MetaMask</a><a class="btn ghost" href="https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(location.href)}">Open in Trust Wallet</a></div>
      <p class="muted" style="font-size:13px">Other wallets (OKX, Bitget, Coinbase…): copy this link and paste it into the wallet's built-in browser. <button class="ghost small" id="copyLinkBtn">Copy link</button></p>`;
  return `<p>No browser wallet found. Install <a href="https://metamask.io/download/" target="_blank" rel="noopener">MetaMask</a> (or Rabby), then refresh. Free test tokens: ${faucetHtml()}.</p>`;
}

$("#demoSwitch").onchange = () => renderAll();
document.addEventListener("click", (e) => {
  if (e.target.id === "copyLinkBtn") copyText(location.href, "Link copied");
});

async function copyText(text, msg = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    toast(msg);
  } catch {
    window.prompt("Copy this:", text);
  }
}

// ------------------------------------------------------------------ saved people
const sessKey = (a) => `pp_session_${a.toLowerCase()}`;
function loadSession() {
  session = null;
  if (!wallet) return;
  try {
    const s = JSON.parse(localStorage.getItem(sessKey(wallet.account)) || "null");
    if (s && s.expiresAt > Date.now() + 60_000 && same(s.owner, wallet.account)) session = s;
  } catch {}
}

async function signIn() {
  await ensureChain();
  const nonce = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const message = [
    "ProofPay sign-in",
    "",
    "Sign this to manage your Saved people on ProofPay. It's free: no transaction, no gas.",
    "",
    `Wallet: ${wallet.viem.getAddress(wallet.account)}`,
    `Chain ID: ${CFG.chainId}`,
    `Issued at: ${new Date().toISOString()}`,
    `Nonce: ${nonce}`,
  ].join("\n");
  const signature = await wallet.client.signMessage({ account: wallet.account, message });
  session = await api("/api/auth/login", { method: "POST", body: { message, signature } });
  localStorage.setItem(sessKey(wallet.account), JSON.stringify(session));
  toast("Signed in. Your saved people are private to this wallet.");
  await loadPeople();
}

let peopleSeq = 0;
async function loadPeople() {
  const seq = ++peopleSeq; // ignore stale responses (e.g. the demo list arriving after you connected)
  const note = $("#peopleNote");
  const form = $("#peopleForm");
  note.textContent =
    CFG.storage === "durable"
      ? wallet
        ? "Only you can see or change this list. It's kept safely, even when the server restarts."
        : "This is the shared demo list. It's kept even when the server restarts."
      : "Saved people live on this server and may reset when it restarts. On-chain jobs are not affected.";
  $("#peopleTitle").textContent = wallet ? "My saved people" : "Saved people (demo list)";
  if (wallet && !session) {
    form.hidden = true;
    $("#peopleList").innerHTML = `<div class="callout">Your saved people are private to your wallet. Sign in once to see and edit them. It's a free signature, no gas, no transaction.<div class="row gap"><button id="signInBtn">Sign in with wallet</button></div></div>`;
    $("#signInBtn").onclick = () => busy($("#signInBtn"), signIn);
    return;
  }
  if (!wallet && !useDemo()) {
    form.hidden = true;
    $("#peopleList").innerHTML = `<p class="muted">Connect your wallet to save the people you pay.</p>`;
    return;
  }
  form.hidden = false;
  try {
    const list = await api(peoplePath(), { auth: true });
    if (seq === peopleSeq) renderPeople(list);
  } catch (e) {
    if (seq !== peopleSeq) return;
    if (/sign in/i.test(e.message) && wallet) {
      localStorage.removeItem(sessKey(wallet.account));
      session = null;
      return loadPeople();
    }
    $("#peopleList").innerHTML = `<p class="muted">${esc(e.message)}</p>`;
  }
}
const peoplePath = (name) => {
  const base = name ? `/api/contacts/${encodeURIComponent(name)}` : "/api/contacts";
  return wallet ? `${base}?owner=${wallet.account.toLowerCase()}` : base;
};
function renderPeople(map) {
  const entries = Object.entries(map ?? {});
  if (!entries.length) {
    $("#peopleList").innerHTML = `<p class="muted">No one saved yet. Add someone above, or paste a 0x address in the job box.</p>`;
    return;
  }
  entries.sort((a, b) => {
    const ba = a[1].builtin ? 1 : 0;
    const bb = b[1].builtin ? 1 : 0;
    if (ba !== bb) return ba - bb;
    return a[0].localeCompare(b[0]);
  });
  $("#peopleList").innerHTML = entries
    .map(([name, c]) => {
      const handle = c.handle ? ` <span class="muted">X @${esc(c.handle)}</span>` : "";
      const badge = c.builtin ? ` <span class="badge">demo</span>` : "";
      const note = c.builtin ? `<div class="muted" style="font-size:12px">Built-in demo contact — can't be removed.</div>` : "";
      const remove = c.builtin ? "" : `<button type="button" class="danger small" data-remove="${esc(name)}">Remove</button>`;
      return `<div class="person"><div><div><b>@${esc(name)}</b>${handle}${badge}</div><div class="mono">${addrLink(c.address)}</div>${note}</div>${remove}</div>`;
    })
    .join("");
}
$("#peopleForm").onsubmit = (e) => {
  e.preventDefault();
  busy($("#savePersonBtn"), async () => {
    const name = $("#personName").value.trim();
    const address = $("#personWallet").value.trim();
    const handle = $("#personHandle").value.trim();
    await api("/api/contacts", { method: "POST", auth: true, body: { name, address, handle: handle || undefined, owner: wallet ? wallet.account.toLowerCase() : undefined } });
    toast(`Saved @${name.replace(/^@/, "").toLowerCase()}`);
    $("#peopleForm").reset();
    $("#personName").focus();
    await loadPeople();
  });
};
$("#peopleList").onclick = (e) => {
  const btn = e.target.closest("[data-remove]");
  if (!btn) return;
  const name = btn.dataset.remove;
  if (!confirm(`Remove @${name} from Saved people?`)) return;
  busy(btn, async () => {
    await api(peoplePath(name), { method: "DELETE", auth: true });
    toast(`Removed @${name}`);
    await loadPeople();
  });
};

const chainHex = () => "0x" + CFG.chainId.toString(16);
async function ensureChain() {
  const p = eth();
  if (!p) throw new Error("No wallet found");
  if (parseInt(await p.request({ method: "eth_chainId" }), 16) === CFG.chainId) return;
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainHex() }] });
  } catch (e) {
    if (e?.code === 4001) throw new Error("Please allow switching to the Aevum testnet in your wallet.");
    // 4902 = unknown chain (mobile wallets sometimes wrap it), so add it, then switch.
    await p.request({
      method: "wallet_addEthereumChain",
      params: [{ chainId: chainHex(), chainName: "QDay Aevum Testnet", nativeCurrency: { name: "tQDAY", symbol: "tQDAY", decimals: 18 }, rpcUrls: [CFG.rpcUrl], blockExplorerUrls: [CFG.explorerUrl] }],
    });
    if (parseInt(await p.request({ method: "eth_chainId" }), 16) !== CFG.chainId) await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainHex() }] });
  }
}

let viemMod = null;
async function setupWallet(account) {
  viemMod ??= await import("https://esm.sh/viem@2.58.1");
  const viem = viemMod;
  const chain = viem.defineChain({ id: CFG.chainId, name: "QDay Aevum Testnet", nativeCurrency: { name: "tQDAY", symbol: "tQDAY", decimals: 18 }, rpcUrls: { default: { http: [CFG.rpcUrl] } }, blockExplorers: { default: { name: "Explorer", url: CFG.explorerUrl } } });
  const client = viem.createWalletClient({ chain, transport: viem.custom(eth()) });
  const pub = viem.createPublicClient({ chain, transport: viem.http(CFG.rpcUrl) });
  wallet = { client, account: viem.getAddress(account), viem, pub, chain };
  localStorage.setItem("pp_wallet", "1");
  loadSession();
}

async function connect() {
  if (!eth()) {
    $("#walletInfo").innerHTML = noWalletHelp();
    $("#wallets").scrollIntoView({ behavior: "smooth" });
    throw new Error(isMobile() ? "Open this page in your wallet app's browser (buttons below)." : "No browser wallet found. Install MetaMask or Rabby, or use demo mode.");
  }
  const [account] = await eth().request({ method: "eth_requestAccounts" });
  if (!account) throw new Error("No account was shared by the wallet.");
  await ensureChain();
  await setupWallet(account);
  toast("Wallet connected");
  renderAll();
}

async function reconnectSilently() {
  if (!eth() || localStorage.getItem("pp_wallet") !== "1") return;
  try {
    const [account] = await eth().request({ method: "eth_accounts" });
    if (account) await setupWallet(account);
  } catch {}
}

function disconnect() {
  wallet = null;
  session = null;
  localStorage.removeItem("pp_wallet");
  toast(CFG.demo ? "Disconnected. Back to demo mode." : "Disconnected.");
  renderAll();
}

$("#connectBtn").onclick = () => (wallet ? disconnect() : busy($("#connectBtn"), connect));
if (eth()?.on) {
  eth().on("accountsChanged", async (accts) => {
    if (!wallet) return;
    if (!accts?.length) return disconnect();
    await setupWallet(accts[0]);
    renderAll();
  });
  eth().on("chainChanged", () => wallet && renderWallets());
}

async function walletWrite(address, abi, functionName, args) {
  if (!wallet) throw new Error("Connect your wallet first");
  await ensureChain();
  const { client, account, pub, chain } = wallet;
  const { request, result } = await pub.simulateContract({ address, abi, functionName, args, account });
  toast("Confirm in your wallet…");
  const hash = await client.writeContract({ ...request, chain, account });
  toast("Sent. Waiting for the network to confirm…");
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (r.status !== "success") throw new Error("Transaction reverted");
  return { hash, result };
}

// ------------------------------------------------------------------ drafting
$("#draftBtn").onclick = () =>
  busy($("#draftBtn"), async () => {
    const text = $("#jobText").value.trim();
    const owner = wallet ? (session ? wallet.account.toLowerCase() : "none") : undefined;
    let r;
    try {
      r = await api("/api/parse", { method: "POST", auth: true, body: { text, owner } });
    } catch (e) {
      if (wallet && !session && /Saved people/.test(e.message)) throw new Error(e.message + " (Sign in under My saved people to use names.)");
      throw e;
    }
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
    const bal = await walletBalances(wallet.account);
    if (bal.rawG === 0n) throw new Error("You need a little free tQDAY for network fees first. Get it from the QDay faucet (link under Wallets).");
    if (bal.rawT < amount) throw new Error(`You have ${bal.tUSD8} tUSD8 but this job needs ${b.amount}. Get free tUSD8 from the faucet, or lower the amount.`);
    if (same(b.payee, wallet.account)) throw new Error("You can't pay your own wallet. Pick the person you're paying.");
    const allowance = await wallet.pub.readContract({ address: CFG.token, abi: ABI.erc20, functionName: "allowance", args: [wallet.account, CFG.escrow] });
    if (allowance < amount) await walletWrite(CFG.token, ABI.erc20, "approve", [CFG.escrow, amount]);
    const r = await walletWrite(CFG.escrow, ABI.escrow, "createAndFund", [b.payee, amount, BigInt(b.deadline), draft.briefHash]);
    jobId = r.result.toString();
    await api(`/api/jobs/${jobId}/created`, { method: "POST", body: { txHash: r.hash } });
    toast("Locked in escrow! Send the job link to the person you're paying.");
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
    const jobs = await api(wallet ? `/api/jobs?wallet=${wallet.account}` : "/api/jobs");
    const role = (j) => (j.role === "client" ? `<span class="badge">you pay</span>` : j.role === "payee" ? `<span class="badge paid">you get paid</span>` : j.role === "both" ? `<span class="badge">you</span>` : "");
    $("#jobs").innerHTML = jobs.length
      ? jobs
          .map((j) => `<div class="job ${selected === j.jobId ? "sel" : ""}" data-id="${esc(j.jobId)}"><span class="muted">#${esc(j.jobId)}</span><span class="jt">${esc(j.brief?.title ?? "(job details not saved on this server)")} ${role(j)}</span><span class="amt">${esc(j.amount)} tUSD8</span><span class="status s-${esc(j.status)}">${esc(label(j))}</span></div>`)
          .join("")
      : wallet
        ? `<p class="muted">No jobs for this wallet yet. Create one above, or open a job link someone sent you.</p>`
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
  const me = wallet ? wallet.account : useDemo() ? null : undefined;
  const isClient = wallet ? same(me, j.client) : useDemo() && same(CFG.demo.client, j.client);
  const isPayee = wallet ? same(me, j.payee) : useDemo() && same(CFG.demo.freelancer, j.payee);
  const open = ["Funded", "ProofSubmitted"].includes(j.status);
  const payeeHint =
    j.status === "Funded" && !isPayee
      ? `<div class="callout">📬 <b>Are you the one getting paid?</b> Only the payee wallet ${addrLink(j.payee)} can submit proof. ${wallet ? "You're connected with a different wallet. Switch accounts in your wallet app." : `<button class="small" id="payeeConnectBtn">Connect wallet</button>`}</div>`
      : "";
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
    ${open ? `<div class="share"><div><b>Share this job</b> <span class="muted">· send it to the person you're paying, so they can paste their proof link.</span></div><div class="row gap"><input type="text" readonly id="shareUrl" value="${esc(shareUrl(j.jobId))}" style="flex:1;min-width:0"/><button class="ghost" id="copyShareBtn">Copy link</button>${navigator.share ? `<button class="ghost" id="nativeShareBtn">Share</button>` : ""}</div></div>` : ""}
    ${payeeHint}
    ${j.status === "Funded" && isPayee ? `<h3>Deliver: paste your public proof link</h3><div class="row gap"><input type="text" id="proofUrl" placeholder="https://x.com/you/status/…" style="flex:1"/><button id="proofBtn" class="blue">Submit proof</button></div>${j.rejections ? `<div class="warn">Previous proof was rejected (${j.rejections}/3). Fix it and resubmit before the deadline.</div>` : ""}` : ""}
    ${isClient && ["Funded", "ProofSubmitted"].includes(j.status) ? `<h3>Client controls</h3><div class="row gap"><button class="ghost" id="approveBtn">Approve & pay manually</button>${j.refundable ? `<button class="danger" id="refundBtn">Refund me</button>` : `<span class="muted" style="font-size:13px">Refund unlocks after the deadline${j.status === "ProofSubmitted" ? " + 24h review window" : " or after a rejected proof"}.</span>`}</div>` : ""}
  `;
  const on = (id, fn) => $(id) && ($(id).onclick = () => busy($(id), fn));
  if ($("#copyShareBtn")) $("#copyShareBtn").onclick = () => copyText(shareUrl(j.jobId), "Job link copied. Send it to the freelancer.");
  if ($("#nativeShareBtn")) $("#nativeShareBtn").onclick = () => navigator.share({ title: `ProofPay job #${j.jobId}`, text: `You have ${j.amount} tUSD8 waiting on ProofPay. Open the link, connect your wallet and paste your proof link:`, url: shareUrl(j.jobId) }).catch(() => {});
  on("#payeeConnectBtn", connect);
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

$("#refreshWalletBtn").onclick = () => renderWallets();

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
