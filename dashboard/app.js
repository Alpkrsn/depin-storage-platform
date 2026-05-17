/* eslint-disable */
// DePIN dashboard — connects to a local Hardhat node via JSON-RPC and shows
// providers / deals / events in real time. Demo button triggers a full deal
// lifecycle directly from the browser (uses a hardcoded local-only signer).

// Hardhat default-mnemonic signer #2 — only ever funded on local dev networks.
// Embedded here so the demo button works without MetaMask. Never use this on
// a real network.
const CONSUMER_KEY =
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";

const REGISTRY_ABI = [
  "function getProviderCount() view returns (uint256)",
  "function getActiveProviders() view returns (address[])",
  "function getProvider(address) view returns (tuple(uint256 capacityGB, uint256 pricePerGB, uint256 stake, bool active, bool exists))",
];

const STORAGE_DEAL_ABI = [
  "function getNextDealId() view returns (uint256)",
  "function getDeal(uint256) view returns (tuple(address consumer, uint64 deadline, uint32 totalChunks, address provider, uint88 escrow, uint8 status, bytes32 merkleRoot))",
  "function isChunkVerified(uint256 dealId, uint256 chunkIndex) view returns (bool)",
  "function createDeal(address provider, bytes32 merkleRoot, uint32 totalChunks, uint64 duration) payable returns (uint256)",
  "function closeDeal(uint256 dealId)",
  "event DealCreated(uint256 indexed dealId, address indexed consumer, address indexed provider, bytes32 merkleRoot, uint256 totalChunks, uint256 escrow, uint256 deadline)",
  "event DealCompleted(uint256 indexed dealId, uint256 challengeIndex, uint256 paidToProvider)",
  "event DealSlashed(uint256 indexed dealId, uint256 challengeIndex, uint256 refundedToConsumer, uint256 slashRequested)",
  "event ProofSubmitted(uint256 indexed dealId, uint256 chunkIndex, bytes32 leaf)",
];

const STATUS = ["Active", "Completed", "Slashed"];
const STATUS_CLASS = ["active", "completed", "slashed"];

let cfg = null;
let provider = null;
let registry = null;
let storageDeal = null;
let lastBlock = 0;

// ===== bootstrap =====

async function init() {
  try {
    const resp = await fetch("addresses.json", { cache: "no-store" });
    if (!resp.ok) throw new Error("addresses.json not found");
    cfg = await resp.json();
  } catch (e) {
    setStatus("❌ addresses.json missing — start `npx hardhat run scripts/dev.ts --network localhost`", false);
    return;
  }

  try {
    provider = new ethers.JsonRpcProvider(cfg.rpcUrl);
    const network = await provider.getNetwork();
    registry = new ethers.Contract(cfg.registry, REGISTRY_ABI, provider);
    storageDeal = new ethers.Contract(cfg.storageDeal, STORAGE_DEAL_ABI, provider);
    setStatus(`✓ chain ${network.chainId} · registry ${shortAddr(cfg.registry)}`, true);
    lastBlock = await provider.getBlockNumber();
  } catch (e) {
    setStatus(`❌ RPC error: ${e.message}`, false);
    return;
  }

  document.getElementById("demo-btn").addEventListener("click", runDemo);
  document.getElementById("slash-demo-btn").addEventListener("click", runSlashDemo);
  document.getElementById("reset-btn").addEventListener("click", resetChain);

  await refresh();
  setInterval(refresh, 2000);
}

function setStatus(text, ok) {
  const el = document.getElementById("status");
  el.textContent = text;
  el.className = "badge " + (ok ? "ok" : "err");
}

// ===== periodic refresh =====

async function refresh() {
  try {
    await Promise.all([refreshProviders(), refreshDeals(), refreshEvents()]);
  } catch (e) {
    console.error("refresh:", e);
  }
}

async function refreshProviders() {
  const actives = await registry.getActiveProviders();
  if (actives.length === 0) {
    document.getElementById("providers-tbody").innerHTML =
      `<tr><td colspan="5"><em>No active providers</em></td></tr>`;
    return;
  }
  const rows = await Promise.all(
    actives.map(async (addr) => {
      const p = await registry.getProvider(addr);
      return `
        <tr>
          <td><code>${shortAddr(addr)}</code></td>
          <td>${p.capacityGB}</td>
          <td>${p.pricePerGB}</td>
          <td>${ethers.formatEther(p.stake)}</td>
          <td><span class="badge active">Active</span></td>
        </tr>`;
    })
  );
  document.getElementById("providers-tbody").innerHTML = rows.join("");
}

async function countVerifiedChunks(dealId, totalChunks) {
  const calls = [];
  for (let i = 0; i < totalChunks; i++) {
    calls.push(storageDeal.isChunkVerified(dealId, i));
  }
  const results = await Promise.all(calls);
  return results.filter(Boolean).length;
}

// Derive a human-readable lifecycle stage from on-chain state alone.
function computeStage(statusIdx, verified, total, expired) {
  if (statusIdx === 1) return { label: "Completed", cls: "stage-ok",   icon: "✅" };
  if (statusIdx === 2) return { label: "Slashed",   cls: "stage-err",  cls2: "stage-err", icon: "❌" };
  // Active branches
  if (verified === 0 && !expired)  return { label: "Awaiting upload",                cls: "stage-wait", icon: "⏳" };
  if (verified === 0 && expired)   return { label: "Lazy provider — slash on close", cls: "stage-err",  icon: "⚠️" };
  if (verified < total)            return { label: `Storing — ${verified}/${total} proofs`, cls: "stage-progress", icon: "📤" };
  if (!expired)                    return { label: `Stored ✓ — awaiting deadline`,   cls: "stage-progress", icon: "⏱️" };
  return                                   { label: "Ready to close",                cls: "stage-ready", icon: "✓" };
}

async function refreshDeals() {
  const next = Number(await storageDeal.getNextDealId());
  if (next === 0) {
    document.getElementById("deals-list").innerHTML = `<em>No deals yet — click "Run Demo Deal" or "Run Slash Demo" to make one.</em>`;
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  const ids = [];
  for (let i = next - 1; i >= 0 && i >= next - 10; i--) ids.push(i);

  const cards = await Promise.all(
    ids.map(async (id) => {
      const d = await storageDeal.getDeal(id);
      const statusIdx = Number(d.status);
      const status = STATUS[statusIdx];
      const cls = STATUS_CLASS[statusIdx];
      const deadlineDelta = Number(d.deadline) - now;
      const expired = deadlineDelta <= 0;
      const total = Number(d.totalChunks);

      // Per-deal verified-chunks query so the stage indicator can show progress.
      const verified = statusIdx === 0 ? await countVerifiedChunks(id, total) : total;
      const stage = computeStage(statusIdx, verified, total, expired);

      const closeBtn =
        statusIdx === 0
          ? `<button class="close-btn" data-id="${id}" ${expired ? "" : "disabled"}>
               ${expired ? "Close Deal" : `Wait ${deadlineDelta}s`}
             </button>`
          : "";

      // Visual chunk strip: one square per chunk, filled if its proof is verified.
      const chunkStrip = Array.from({ length: total }, (_, i) =>
        `<span class="chunk ${i < verified ? "chunk-on" : "chunk-off"}" title="chunk ${i}"></span>`
      ).join("");

      return `
        <div class="deal ${cls}">
          <div class="deal-head">
            <span class="deal-id">Deal #${id}</span>
            <span class="badge ${cls}">${status}</span>
          </div>
          <div class="stage ${stage.cls}">
            <span class="stage-icon">${stage.icon}</span>
            <span class="stage-label">${stage.label}</span>
          </div>
          <div class="chunks" aria-label="proof attestation per chunk">${chunkStrip}</div>
          <div class="deal-body">
            <span class="label">Consumer</span><code>${shortAddr(d.consumer)}</code>
            <span class="label">Provider</span><code>${shortAddr(d.provider)}</code>
            <span class="label">Escrow</span><span>${ethers.formatEther(d.escrow)} ETH</span>
            <span class="label">Chunks</span><span>${verified}/${total} attested</span>
            <span class="label">Deadline</span><span>${expired ? "<em>expired</em>" : `${deadlineDelta}s left`}</span>
            <span class="label">Root</span><code>${d.merkleRoot.slice(0, 14)}…</code>
          </div>
          ${closeBtn}
        </div>`;
    })
  );
  document.getElementById("deals-list").innerHTML = cards.join("");
  document.querySelectorAll(".close-btn:not(:disabled)").forEach((btn) => {
    btn.addEventListener("click", () => closeDealCmd(BigInt(btn.dataset.id)));
  });
}

async function refreshEvents() {
  const currentBlock = await provider.getBlockNumber();
  if (currentBlock <= lastBlock) return;
  const events = await storageDeal.queryFilter("*", lastBlock + 1, currentBlock);
  for (const e of events) {
    const frag = e.fragment;
    if (!frag) continue;
    const args = frag.inputs
      .map((inp, i) => `${inp.name}=${shortVal(e.args[i])}`)
      .join(" ");
    let cls = "ev-info";
    if (frag.name === "DealCompleted") cls = "ev-success";
    else if (frag.name === "DealSlashed") cls = "ev-err";
    appendEvent(`${frag.name}(${args})`, cls);
  }
  lastBlock = currentBlock;
}

function appendEvent(text, cls = "") {
  const li = document.createElement("li");
  if (cls) li.className = cls;
  const ts = new Date().toISOString().slice(11, 19);
  li.innerHTML = `<span class="ts">${ts}</span>${escapeHtml(text)}`;
  const log = document.getElementById("events-log");
  log.prepend(li);
  while (log.children.length > 80) log.removeChild(log.lastChild);
}

function shortAddr(a) { return `${a.slice(0, 6)}…${a.slice(-4)}`; }
function shortVal(v) {
  const s = String(v);
  if (s.startsWith("0x") && s.length > 16) return `${s.slice(0, 8)}…${s.slice(-4)}`;
  if (s.length > 18) return s.slice(0, 16) + "…";
  return s;
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ===== Merkle (same shape as agents/lib/merkle.ts) =====

function hashPair(a, b) {
  const [first, second] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  return ethers.keccak256(ethers.concat([first, second]));
}

function buildMerkleTree(leaves) {
  const layers = [leaves.slice()];
  let current = leaves.slice();
  while (current.length > 1) {
    const next = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i];
      const right = i + 1 < current.length ? current[i + 1] : current[i];
      next.push(hashPair(left, right));
    }
    layers.push(next);
    current = next;
  }
  const root = current[0];
  function getProof(index) {
    const proof = [];
    let idx = index;
    for (let level = 0; level < layers.length - 1; level++) {
      const layer = layers[level];
      const isRight = idx % 2 === 1;
      const siblingIdx = isRight ? idx - 1 : idx + 1;
      const sibling = siblingIdx < layer.length ? layer[siblingIdx] : layer[idx];
      proof.push(sibling);
      idx = Math.floor(idx / 2);
    }
    return proof;
  }
  return { root, getProof };
}

function chunkFile(data, chunkSize = 512) {
  const chunks = [];
  for (let off = 0; off < data.length; off += chunkSize) {
    chunks.push(data.subarray(off, Math.min(off + chunkSize, data.length)));
  }
  const leaves = chunks.map((c) => ethers.keccak256(c));
  const tree = buildMerkleTree(leaves);
  return { chunks, leaves, tree, totalChunks: chunks.length };
}

// ===== actions =====

async function runDemo() {
  const btn = document.getElementById("demo-btn");
  btn.disabled = true;
  try {
    appendEvent("== Starting demo deal ==", "ev-info");
    const wallet = new ethers.Wallet(CONSUMER_KEY, provider);
    const sd = new ethers.Contract(cfg.storageDeal, STORAGE_DEAL_ABI, wallet);

    const data = new Uint8Array(3000);
    crypto.getRandomValues(data);
    const f = chunkFile(data, 512);
    appendEvent(`Chunked file: ${data.length}B → ${f.totalChunks} chunks, root=${f.tree.root.slice(0, 14)}…`);

    const escrow = ethers.parseEther("0.05");
    const duration = 30n; // seconds
    appendEvent(`createDeal(provider, root, ${f.totalChunks}, ${duration}, value=0.05 ETH)`);
    const tx = await sd.createDeal(cfg.providerSigner, f.tree.root, f.totalChunks, duration, { value: escrow });
    const receipt = await tx.wait();
    const log = receipt.logs.find((l) => l.address.toLowerCase() === cfg.storageDeal.toLowerCase());
    const parsed = sd.interface.parseLog(log);
    const dealId = parsed.args.dealId;
    appendEvent(`Deal #${dealId} created (tx ${tx.hash.slice(0, 10)}…)`, "ev-success");

    appendEvent(`POST ${cfg.providerUrl}/store?dealId=${dealId}`);
    const resp = await fetch(`${cfg.providerUrl}/store?dealId=${dealId}`, {
      method: "POST",
      body: data,
    });
    const body = await resp.json();
    if (resp.status !== 200) throw new Error(`provider rejected: ${body.error}`);
    appendEvent(`Provider stored file + submitted ${body.submittedTxs.length} proofs ✓`, "ev-success");
    appendEvent(`Deadline in ${duration}s — wait for timer, then click "Close Deal"`, "ev-info");
  } catch (e) {
    appendEvent(`ERROR: ${e.message ?? String(e)}`, "ev-err");
  } finally {
    btn.disabled = false;
  }
}

// Slash-path demo: create a deal but deliberately SKIP the upload step.
// The provider never gets a chance to submit proofs, so closeDeal after the
// deadline takes the slash branch — consumer is refunded escrow AND paid out
// from the provider's stake. Demonstrates the protocol's cryptoeconomic
// guarantee: "trust = math + economics".
async function runSlashDemo() {
  const btn = document.getElementById("slash-demo-btn");
  btn.disabled = true;
  try {
    appendEvent("== Starting slash demo (provider goes silent) ==", "ev-info");
    const wallet = new ethers.Wallet(CONSUMER_KEY, provider);
    const sd = new ethers.Contract(cfg.storageDeal, STORAGE_DEAL_ABI, wallet);

    const data = new Uint8Array(3000);
    crypto.getRandomValues(data);
    const f = chunkFile(data, 512);
    appendEvent(`Chunked: ${f.totalChunks} chunks, root=${f.tree.root.slice(0, 14)}…`);

    const escrow = ethers.parseEther("0.05");
    const duration = 30n;
    appendEvent(`createDeal(provider, root, ${f.totalChunks}, ${duration}, value=0.05 ETH)`);
    const tx = await sd.createDeal(cfg.providerSigner, f.tree.root, f.totalChunks, duration, { value: escrow });
    const receipt = await tx.wait();
    const log = receipt.logs.find((l) => l.address.toLowerCase() === cfg.storageDeal.toLowerCase());
    const parsed = sd.interface.parseLog(log);
    const dealId = parsed.args.dealId;
    appendEvent(`Deal #${dealId} created — file NOT uploaded. 0 proofs will be submitted.`, "ev-info");
    appendEvent(`Wait ${duration}s, then Close. Consumer will receive 2× escrow (0.10 ETH).`, "ev-info");
  } catch (e) {
    appendEvent(`ERROR: ${e.message ?? String(e)}`, "ev-err");
  } finally {
    btn.disabled = false;
  }
}

async function closeDealCmd(dealId) {
  try {
    appendEvent(`== Closing deal #${dealId} ==`, "ev-info");
    const wallet = new ethers.Wallet(CONSUMER_KEY, provider);
    const sd = new ethers.Contract(cfg.storageDeal, STORAGE_DEAL_ABI, wallet);
    const tx = await sd.closeDeal(dealId);
    await tx.wait();
    appendEvent(`Deal #${dealId} close tx mined (tx ${tx.hash.slice(0, 10)}…)`, "ev-success");
  } catch (e) {
    appendEvent(`ERROR: ${e.message ?? String(e)}`, "ev-err");
  }
}

async function resetChain() {
  if (!confirm("Reset the local chain? All deals + providers will be wiped. You'll need to re-run the dev script.")) return;
  try {
    appendEvent("== hardhat_reset ==", "ev-info");
    await fetch(cfg.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "hardhat_reset", params: [], id: 1 }),
    });
    appendEvent("Chain reset. Restart `scripts/dev.ts` to re-deploy.", "ev-info");
  } catch (e) {
    appendEvent(`ERROR: ${e.message}`, "ev-err");
  }
}

init();
