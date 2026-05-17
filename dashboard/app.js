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

// Per-deal in-browser memory for demo deals we created here. The chain stores
// only the root + status, so we keep the chunked leaves + tree locally so we
// can render the full Merkle tree visualization.
const dealMemory = new Map(); // dealId (string) -> { leaves, tree, txHashes: { createDeal, closeDeal } }
// Cached "is the provider HTTP server reachable?" flag (per provider address)
const providerOnline = new Map(); // address -> boolean
// Per-provider URL lookup, built from cfg.providers (online providers only)
const providerUrls = new Map(); // address (lowercase) -> url
// Per-provider stats (served / slashed counts) computed from on-chain events
const providerStats = new Map(); // address (lowercase) -> { served, slashed }
// Deals whose Transactions panel is expanded — preserved across the 2s refresh
// loop that re-renders the entire deals list.
const openTxDetails = new Set(); // dealId (string)

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

  // Build the URL lookup + ping each online provider's HTTP server. Any
  // registered provider not in cfg.providers is treated as offline (on-chain
  // listing only — no server running anywhere we know about).
  (cfg.providers ?? []).forEach((p) => providerUrls.set(p.address.toLowerCase(), p.url));
  await pingAllProviders();

  await refresh();
  setInterval(refresh, 2000);
  // Re-ping the online providers every 10s in case one goes up/down mid-demo.
  setInterval(pingAllProviders, 10_000);
}

async function pingAllProviders() {
  await Promise.all(
    (cfg.providers ?? []).map(async (p) => {
      try {
        const r = await fetch(`${p.url}/health`, { method: "GET" });
        providerOnline.set(p.address.toLowerCase(), r.ok);
      } catch {
        providerOnline.set(p.address.toLowerCase(), false);
      }
    })
  );
}

function setStatus(text, ok) {
  const el = document.getElementById("status");
  el.textContent = text;
  el.className = "badge " + (ok ? "ok" : "err");
}

// ===== periodic refresh =====

async function refresh() {
  try {
    await Promise.all([
      refreshProviders(),
      refreshProviderSelect(),
      refreshDeals(),
      refreshEvents(),
      refreshStats(),
    ]);
  } catch (e) {
    console.error("refresh:", e);
  }
}

// Aggregate stats shown in the top banner. Computed by iterating all deals
// (we cap at 50 to keep the dashboard responsive at very large scales).
async function refreshStats() {
  const next = Number(await storageDeal.getNextDealId());
  if (next === 0) {
    document.getElementById("stat-deals").textContent = "0";
    document.getElementById("stat-deals-sub").textContent = "0 completed · 0 slashed";
    document.getElementById("stat-escrow").textContent = "0";
    document.getElementById("stat-gas").textContent = "—";
    document.getElementById("stat-slash").textContent = "—";
    return;
  }
  const max = Math.min(next, 50);
  const deals = await Promise.all(
    Array.from({ length: max }, (_, i) => storageDeal.getDeal(next - 1 - i))
  );
  let completed = 0, slashed = 0, escrowLocked = 0n;
  for (const d of deals) {
    const st = Number(d.status);
    if (st === 1) completed++;
    else if (st === 2) slashed++;
    else escrowLocked += d.escrow;
  }
  const total = deals.length;
  const closed = completed + slashed;

  document.getElementById("stat-deals").textContent = total.toString();
  document.getElementById("stat-deals-sub").textContent =
    `${completed} completed · ${slashed} slashed · ${total - closed} active`;
  document.getElementById("stat-escrow").textContent =
    `${Number(ethers.formatEther(escrowLocked)).toFixed(3)} ETH`;
  document.getElementById("stat-slash").textContent =
    closed === 0 ? "—" : `${Math.round((slashed / closed) * 100)}%`;

  // Total gas: query the contract address' transactions via block scan would be
  // expensive — we approximate by summing the gas in tx receipts of all events
  // we know about for the closed deals. This is "gas in this dashboard's view"
  // rather than every tx ever, but it's the honest visible number.
  const evFilters = [
    storageDeal.filters.DealCreated(),
    storageDeal.filters.ProofSubmitted(),
    storageDeal.filters.DealCompleted(),
    storageDeal.filters.DealSlashed(),
  ];
  const evGroups = await Promise.all(
    evFilters.map((f) => storageDeal.queryFilter(f, 0, "latest"))
  );
  const uniqueTxs = new Set();
  evGroups.flat().forEach((e) => uniqueTxs.add(e.transactionHash));
  let totalGas = 0;
  await Promise.all(
    [...uniqueTxs].map(async (h) => {
      const r = await provider.getTransactionReceipt(h);
      if (r) totalGas += Number(r.gasUsed);
    })
  );
  document.getElementById("stat-gas").textContent =
    totalGas === 0 ? "—" : totalGas.toLocaleString();
}

async function refreshProviderSelect() {
  const sel = document.getElementById("provider-select");
  const previous = sel.value;
  const actives = await registry.getActiveProviders();
  if (actives.length === 0) {
    sel.innerHTML = `<option value="">(no active providers)</option>`;
    return;
  }
  const opts = await Promise.all(
    actives.map(async (addr) => {
      const p = await registry.getProvider(addr);
      const online = providerOnline.get(addr.toLowerCase()) === true;
      const dot = online ? "🟢" : "⚪";
      const label = `${dot} ${shortAddr(addr)} · ${p.pricePerGB} wei/GB · ${p.capacityGB} GB`;
      return `<option value="${addr}" data-online="${online}">${label}</option>`;
    })
  );
  sel.innerHTML = opts.join("");
  // Preserve user's selection across refreshes if still valid.
  if (previous && Array.from(sel.options).some((o) => o.value === previous)) {
    sel.value = previous;
  }
}

function getSelectedProvider() {
  const sel = document.getElementById("provider-select");
  const opt = sel.options[sel.selectedIndex];
  if (!opt || !opt.value) return null;
  return { address: opt.value, online: opt.dataset.online === "true" };
}

async function refreshProviders() {
  const actives = await registry.getActiveProviders();
  if (actives.length === 0) {
    document.getElementById("providers-tbody").innerHTML =
      `<tr><td colspan="7"><em>No active providers</em></td></tr>`;
    return;
  }
  // Refresh per-provider deal stats from on-chain events.
  await refreshProviderStats();

  const rows = await Promise.all(
    actives.map(async (addr) => {
      const p = await registry.getProvider(addr);
      const online = providerOnline.get(addr.toLowerCase()) === true;
      const statusBadge = online
        ? `<span class="badge ok" title="HTTP server reachable">🟢 Online</span>`
        : `<span class="badge offline" title="Registered on-chain but no HTTP server reachable">⚪ Offline</span>`;
      const stats = providerStats.get(addr.toLowerCase()) ?? { served: 0, slashed: 0 };
      const servedCell = stats.served > 0
        ? `<span class="prov-stat-ok">${stats.served}</span>`
        : `<span class="prov-stat-zero">0</span>`;
      const slashedCell = stats.slashed > 0
        ? `<span class="prov-stat-err">${stats.slashed}</span>`
        : `<span class="prov-stat-zero">0</span>`;
      return `
        <tr>
          <td><code>${shortAddr(addr)}</code></td>
          <td>${p.capacityGB}</td>
          <td>${p.pricePerGB}</td>
          <td>${ethers.formatEther(p.stake)}</td>
          <td title="Deals successfully completed by this provider">${servedCell}</td>
          <td title="Times this provider's stake was slashed (failed proof / no-show)">${slashedCell}</td>
          <td>${statusBadge}</td>
        </tr>`;
    })
  );
  document.getElementById("providers-tbody").innerHTML = rows.join("");
}

// Iterate completed + slashed deals to build a per-provider tally.
// Cached in providerStats Map; recomputed every refresh cycle (cheap: 2 event
// queries + N getDeal calls).
async function refreshProviderStats() {
  const [completedEvs, slashedEvs] = await Promise.all([
    storageDeal.queryFilter(storageDeal.filters.DealCompleted(), 0, "latest"),
    storageDeal.queryFilter(storageDeal.filters.DealSlashed(), 0, "latest"),
  ]);
  const fresh = new Map();
  const tally = async (events, key) => {
    for (const ev of events) {
      const dealId = ev.args.dealId;
      const deal = await storageDeal.getDeal(dealId);
      const addr = deal.provider.toLowerCase();
      const s = fresh.get(addr) ?? { served: 0, slashed: 0 };
      s[key]++;
      fresh.set(addr, s);
    }
  };
  await tally(completedEvs, "served");
  await tally(slashedEvs, "slashed");
  providerStats.clear();
  fresh.forEach((v, k) => providerStats.set(k, v));
}

async function fetchVerifiedFlags(dealId, totalChunks) {
  const calls = [];
  for (let i = 0; i < totalChunks; i++) {
    calls.push(storageDeal.isChunkVerified(dealId, i));
  }
  return Promise.all(calls);
}

async function countVerifiedChunks(dealId, totalChunks) {
  const flags = await fetchVerifiedFlags(dealId, totalChunks);
  return flags.filter(Boolean).length;
}

async function fetchChallengeIndex(dealId) {
  // DealCompleted and DealSlashed both carry the challengeIndex as their
  // second arg. Query both filters for the deal.
  const completedFilter = storageDeal.filters.DealCompleted(dealId);
  const slashedFilter = storageDeal.filters.DealSlashed(dealId);
  const [c, s] = await Promise.all([
    storageDeal.queryFilter(completedFilter, 0, "latest"),
    storageDeal.queryFilter(slashedFilter, 0, "latest"),
  ]);
  const ev = c[0] ?? s[0];
  return ev ? Number(ev.args.challengeIndex) : null;
}

// ===== Merkle tree SVG =====

function buildFullTree(leaves) {
  // Same algorithm as buildMerkleTree but returns every layer (not just root).
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
  return layers; // layers[0] = leaves, layers[layers.length-1] = [root]
}

// Returns the (layer, index) sequence from a challenged leaf up to the root.
function pathToRoot(leafIndex, layers) {
  const path = [];
  let idx = leafIndex;
  for (let l = 0; l < layers.length; l++) {
    path.push({ layer: l, index: idx });
    idx = Math.floor(idx / 2);
  }
  return path;
}

function renderMerkleSvg(leaves, verifiedFlags, challengeIndex) {
  const layers = buildFullTree(leaves);
  return renderTreeSvgFromLayers(layers, verifiedFlags, challengeIndex, /*havePreimages=*/ true);
}

function renderMerkleSvgPlaceholder(totalChunks, verifiedFlags, challengeIndex) {
  // No leaf hashes available — fabricate placeholders just to draw shape.
  const placeholderLeaves = Array.from({ length: totalChunks }, (_, i) =>
    "0x" + i.toString(16).padStart(64, "0")
  );
  const layers = buildFullTree(placeholderLeaves);
  return renderTreeSvgFromLayers(layers, verifiedFlags, challengeIndex, /*havePreimages=*/ false);
}

function renderTreeSvgFromLayers(layers, verifiedFlags, challengeIndex, havePreimages) {
  const W = 320;
  const NODE_R = 11;
  const LAYER_H = 46;
  const H = layers.length * LAYER_H + 10;

  // x for each layer's nodes — leaves evenly, parents at midpoint of their children.
  const xPositions = layers.map((layer, l) =>
    l === 0
      ? layer.map((_, i) => ((i + 0.5) * W) / layer.length)
      : []
  );
  for (let l = 1; l < layers.length; l++) {
    xPositions[l] = layers[l].map((_, i) => {
      const leftX = xPositions[l - 1][i * 2];
      const rightX = xPositions[l - 1][Math.min(i * 2 + 1, xPositions[l - 1].length - 1)];
      return (leftX + rightX) / 2;
    });
  }

  // y: top layer (root) near top, leaves at bottom.
  const yFor = (l) => H - 10 - l * LAYER_H;

  // Highlighted path = leaf -> root for the challenge.
  const highlightSet = new Set();
  if (challengeIndex !== null && challengeIndex >= 0) {
    for (const { layer, index } of pathToRoot(challengeIndex, layers)) {
      highlightSet.add(`${layer}:${index}`);
    }
  }

  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" class="merkle-svg">`;

  // Edges first so nodes draw on top.
  for (let l = 0; l < layers.length - 1; l++) {
    layers[l].forEach((_, i) => {
      const parentIdx = Math.floor(i / 2);
      const x1 = xPositions[l][i];
      const y1 = yFor(l);
      const x2 = xPositions[l + 1][parentIdx];
      const y2 = yFor(l + 1);
      const onPath = highlightSet.has(`${l}:${i}`) && highlightSet.has(`${l + 1}:${parentIdx}`);
      svg += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="${onPath ? "edge edge-hl" : "edge"}"/>`;
    });
  }

  // Nodes.
  layers.forEach((layer, l) => {
    layer.forEach((hash, i) => {
      const x = xPositions[l][i];
      const y = yFor(l);
      const isLeaf = l === 0;
      const verified = isLeaf && verifiedFlags[i] === true;
      const onPath = highlightSet.has(`${l}:${i}`);
      const isChallenged = onPath && isLeaf;
      const classes = [
        "node",
        isLeaf ? "leaf" : "internal",
        l === layers.length - 1 ? "root" : "",
        verified ? "verified" : "",
        isChallenged ? "challenged" : "",
        onPath ? "on-path" : "",
      ].filter(Boolean).join(" ");
      const label = havePreimages ? hash.slice(2, 6) : (isLeaf ? `c${i}` : "");
      svg += `<circle cx="${x}" cy="${y}" r="${NODE_R}" class="${classes}"/>`;
      if (label) {
        svg += `<text x="${x}" y="${y + 3}" text-anchor="middle" class="node-label">${label}</text>`;
      }
    });
  });

  svg += `</svg>`;
  return svg;
}

// ===== Transaction details =====

// Friendly per-row explanation. Each blockchain action gets a one-line caption
// so a viewer who has never seen a tx table can still follow what each row did.
const TX_EXPLAIN = {
  createDeal: "Consumer locked the escrow ETH in the StorageDeal contract.",
  closeDeal:  "Anyone called closeDeal after the deadline — the contract picked a random challenge chunk and either paid the provider or slashed them.",
};
function explainProofRow(chunkIndex) {
  return `Provider proved chunk #${chunkIndex} is stored by submitting a Merkle proof; the contract verified it on-chain.`;
}

async function renderTxDetails(dealId, mem) {
  // Aggregate every tx hash we know about for this deal:
  // - createDeal hash from local memory (only if dashboard made the deal)
  // - submitProof tx hashes from on-chain ProofSubmitted events
  // - closeDeal hash from local memory or DealCompleted/Slashed events
  const rows = [];

  if (mem && mem.txHashes && mem.txHashes.createDeal) {
    rows.push({ label: "createDeal", hash: mem.txHashes.createDeal, explain: TX_EXPLAIN.createDeal });
  }

  // Proof submissions are public — anyone can find them via events.
  const proofFilter = storageDeal.filters.ProofSubmitted(dealId);
  const proofEvents = await storageDeal.queryFilter(proofFilter, 0, "latest");
  proofEvents.forEach((e) => {
    const chunkIndex = Number(e.args.chunkIndex);
    rows.push({
      label: `submitProof[${chunkIndex}]`,
      hash: e.transactionHash,
      explain: explainProofRow(chunkIndex),
    });
  });

  const closeFilter1 = storageDeal.filters.DealCompleted(dealId);
  const closeFilter2 = storageDeal.filters.DealSlashed(dealId);
  const [c, s] = await Promise.all([
    storageDeal.queryFilter(closeFilter1, 0, "latest"),
    storageDeal.queryFilter(closeFilter2, 0, "latest"),
  ]);
  const closeEv = c[0] ?? s[0];
  if (closeEv) rows.push({ label: "closeDeal", hash: closeEv.transactionHash, explain: TX_EXPLAIN.closeDeal });

  if (rows.length === 0) {
    return {
      count: 0,
      html: `<div class="tx-intro">No on-chain transactions for this deal yet.</div>`,
    };
  }

  // Fetch receipts in parallel for gas + block.
  const enriched = await Promise.all(
    rows.map(async (r) => {
      const rec = await provider.getTransactionReceipt(r.hash);
      return {
        ...r,
        block: rec ? Number(rec.blockNumber) : null,
        gas: rec ? Number(rec.gasUsed) : null,
        ok: rec ? rec.status === 1 : null,
      };
    })
  );

  const totalGas = enriched.reduce((s, r) => s + (r.gas ?? 0), 0);
  const usd = (totalGas * 20e-9 * 3500).toFixed(4);

  const html = `
    <div class="tx-intro">
      Every action you take here writes a real transaction to the local Ethereum chain.
      Each row below is one of those transactions — the action it performed, which block it
      landed in, the gas (computation) it consumed, and its unique identifier (hash).
      In production these would be searchable on Etherscan.
    </div>
    <table class="tx-table">
      <thead><tr>
        <th title="What the transaction did">Action</th>
        <th title="Which block the transaction was mined into">Block</th>
        <th title="Computation units consumed — units of work on the EVM">Gas</th>
        <th title="32-byte unique identifier; this is what you would paste into Etherscan">Tx hash</th>
      </tr></thead>
      <tbody>
        ${enriched
          .map(
            (r) => `
          <tr>
            <td><div class="tx-action">${r.label}</div><div class="tx-explain">${r.explain ?? ""}</div></td>
            <td>${r.block ?? "—"}</td>
            <td>${r.gas != null ? r.gas.toLocaleString() : "—"}</td>
            <td><code title="${r.hash}">${r.hash.slice(0, 10)}…${r.hash.slice(-6)}</code></td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>
    <div class="tx-foot">
      <strong>Total gas: ${totalGas.toLocaleString()}</strong> · estimated mainnet cost @ 20 gwei ≈ <strong>$${usd}</strong>
      (ETH @ $3500). Target from the proposal (NFR2): ≤ 500,000 gas for the full deal lifecycle.
    </div>`;

  return { count: enriched.length, html };
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

  const cards = await Promise.all(ids.map((id) => renderDealCard(id, now)));
  document.getElementById("deals-list").innerHTML = cards.join("");
  document.querySelectorAll(".close-btn:not(:disabled)").forEach((btn) => {
    btn.addEventListener("click", () => closeDealCmd(BigInt(btn.dataset.id)));
  });
  // Restore any "Transactions" panels the user had open before the refresh
  // wiped the DOM, so refreshes don't close panels under the user's nose.
  openTxDetails.forEach((dealId) => {
    const el = document.getElementById(`tx-${dealId}`);
    const btn = document.querySelector(`.details-toggle[data-target="tx-${dealId}"]`);
    if (el && btn) {
      el.classList.add("open");
      btn.classList.add("open");
    }
  });
  // Wire collapsible details and remember which ones the user opened.
  document.querySelectorAll(".details-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetId = btn.dataset.target;
      const tgt = document.getElementById(targetId);
      if (!tgt) return;
      const willOpen = !tgt.classList.contains("open");
      tgt.classList.toggle("open", willOpen);
      btn.classList.toggle("open", willOpen);
      const dealId = targetId.replace("tx-", "");
      if (willOpen) openTxDetails.add(dealId);
      else openTxDetails.delete(dealId);
    });
  });
}

async function renderDealCard(id, now) {
  const d = await storageDeal.getDeal(id);
  const statusIdx = Number(d.status);
  const status = STATUS[statusIdx];
  const cls = STATUS_CLASS[statusIdx];
  const deadlineDelta = Number(d.deadline) - now;
  const expired = deadlineDelta <= 0;
  const total = Number(d.totalChunks);

  const verified = statusIdx === 0 ? await countVerifiedChunks(id, total) : total;
  const stage = computeStage(statusIdx, verified, total, expired);

  // For closed deals we need the challengeIndex (emitted in DealCompleted /
  // DealSlashed). It tells us which leaf the contract challenged so we can
  // highlight the Merkle path used for settlement.
  let challengeIndex = null;
  if (statusIdx !== 0) {
    challengeIndex = await fetchChallengeIndex(id);
  }

  // Merkle tree visualization. We need the actual leaf hashes (chain only
  // stores the root). If this dashboard created the deal, we have them in
  // dealMemory; otherwise we render a placeholder tree with anonymous nodes.
  const mem = dealMemory.get(id.toString());
  const verifiedFlags = await fetchVerifiedFlags(id, total);
  const treeSvg = mem
    ? renderMerkleSvg(mem.leaves, verifiedFlags, challengeIndex)
    : renderMerkleSvgPlaceholder(total, verifiedFlags, challengeIndex);

  const closeBtn =
    statusIdx === 0
      ? `<button class="close-btn" data-id="${id}" ${expired ? "" : "disabled"}>
           ${expired ? "Close Deal" : `Wait ${deadlineDelta}s`}
         </button>`
      : "";

  const txDetailsId = `tx-${id}`;
  const txDetails = await renderTxDetails(id, mem);

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
      <div class="deal-body">
        <span class="label">Consumer</span><code>${shortAddr(d.consumer)}</code>
        <span class="label">Provider</span><code>${shortAddr(d.provider)}</code>
        <span class="label">Escrow</span><span>${ethers.formatEther(d.escrow)} ETH</span>
        <span class="label">Chunks</span><span>${verified}/${total} attested${challengeIndex !== null ? ` · challenged #${challengeIndex}` : ""}</span>
        <span class="label">Deadline</span><span>${expired ? "<em>expired</em>" : `${deadlineDelta}s left`}</span>
        <span class="label">Root</span><code title="${d.merkleRoot}">${d.merkleRoot.slice(0, 14)}…</code>
      </div>
      <div class="merkle-block">
        <div class="merkle-caption">Merkle tree — ${mem ? "live leaves" : "placeholder (deal created outside dashboard)"}</div>
        ${treeSvg}
      </div>
      <button class="details-toggle" data-target="${txDetailsId}">
        <span class="caret">▸</span> On-chain transactions ${txDetails.count > 0 ? `(${txDetails.count})` : ""}
      </button>
      <div class="tx-details" id="${txDetailsId}">${txDetails.html}</div>
      ${closeBtn}
    </div>`;
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
    const sel = getSelectedProvider();
    if (!sel) {
      appendEvent("ERROR: no provider selected", "ev-err");
      return;
    }
    appendEvent(`== Starting demo deal with ${sel.online ? "🟢 ONLINE" : "⚪ OFFLINE"} provider ${shortAddr(sel.address)} ==`, "ev-info");
    const wallet = new ethers.Wallet(CONSUMER_KEY, provider);
    const sd = new ethers.Contract(cfg.storageDeal, STORAGE_DEAL_ABI, wallet);

    const data = new Uint8Array(3000);
    crypto.getRandomValues(data);
    const f = chunkFile(data, 512);
    appendEvent(`Chunked file: ${data.length}B → ${f.totalChunks} chunks, root=${f.tree.root.slice(0, 14)}…`);

    const escrow = ethers.parseEther("0.05");
    const duration = 30n; // seconds
    appendEvent(`createDeal(provider, root, ${f.totalChunks}, ${duration}, value=0.05 ETH)`);
    const tx = await sd.createDeal(sel.address, f.tree.root, f.totalChunks, duration, { value: escrow });
    const receipt = await tx.wait();
    const log = receipt.logs.find((l) => l.address.toLowerCase() === cfg.storageDeal.toLowerCase());
    const parsed = sd.interface.parseLog(log);
    const dealId = parsed.args.dealId;
    dealMemory.set(dealId.toString(), {
      leaves: f.leaves,
      tree: f.tree,
      totalChunks: f.totalChunks,
      txHashes: { createDeal: tx.hash },
    });
    appendEvent(`Deal #${dealId} created (tx ${tx.hash.slice(0, 10)}…)`, "ev-success");

    if (!sel.online) {
      // Selected provider has no HTTP server — there's nothing to POST to.
      // Skip upload entirely. The deal is on-chain but no proofs will ever
      // be submitted, so closeDeal will take the slash path. This is the
      // protocol's exact value proposition: you're protected from absent
      // providers automatically.
      appendEvent(`⚠️ Provider is OFFLINE — upload skipped. Wait ${duration}s, then close: consumer will receive 2× escrow (0.10 ETH), provider stake slashed.`, "ev-info");
      return;
    }

    const providerUrl = providerUrls.get(sel.address.toLowerCase());
    if (!providerUrl) {
      throw new Error(`No HTTP URL configured for provider ${sel.address}`);
    }
    appendEvent(`POST ${providerUrl}/store?dealId=${dealId}`);
    const resp = await fetch(`${providerUrl}/store?dealId=${dealId}`, {
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
    const sel = getSelectedProvider();
    if (!sel) {
      appendEvent("ERROR: no provider selected", "ev-err");
      return;
    }
    appendEvent(`== Starting slash demo with ${sel.online ? "🟢 ONLINE" : "⚪ OFFLINE"} provider ${shortAddr(sel.address)} (silent regardless) ==`, "ev-info");
    const wallet = new ethers.Wallet(CONSUMER_KEY, provider);
    const sd = new ethers.Contract(cfg.storageDeal, STORAGE_DEAL_ABI, wallet);

    const data = new Uint8Array(3000);
    crypto.getRandomValues(data);
    const f = chunkFile(data, 512);
    appendEvent(`Chunked: ${f.totalChunks} chunks, root=${f.tree.root.slice(0, 14)}…`);

    const escrow = ethers.parseEther("0.05");
    const duration = 30n;
    appendEvent(`createDeal(provider, root, ${f.totalChunks}, ${duration}, value=0.05 ETH)`);
    const tx = await sd.createDeal(sel.address, f.tree.root, f.totalChunks, duration, { value: escrow });
    const receipt = await tx.wait();
    const log = receipt.logs.find((l) => l.address.toLowerCase() === cfg.storageDeal.toLowerCase());
    const parsed = sd.interface.parseLog(log);
    const dealId = parsed.args.dealId;
    dealMemory.set(dealId.toString(), {
      leaves: f.leaves,
      tree: f.tree,
      totalChunks: f.totalChunks,
      txHashes: { createDeal: tx.hash },
    });
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
    // Remember the close tx hash so the Transactions panel can show it.
    const mem = dealMemory.get(dealId.toString());
    if (mem) {
      mem.txHashes = { ...(mem.txHashes ?? {}), closeDeal: tx.hash };
    }
    appendEvent(`Deal #${dealId} close tx mined (tx ${tx.hash.slice(0, 10)}…)`, "ev-success");
  } catch (e) {
    appendEvent(`ERROR: ${e.message ?? String(e)}`, "ev-err");
  }
}

async function resetChain() {
  if (!confirm(
    "Wipe the local chain and re-deploy everything from scratch?\n\n" +
    "All deals, providers, and balances will be reset. The dashboard will " +
    "automatically redeploy the contracts and re-register all 3 providers, " +
    "then reload — no terminal action needed."
  )) return;
  const btn = document.getElementById("reset-btn");
  btn.disabled = true;
  const originalText = btn.textContent;
  try {
    btn.textContent = "⟲ Resetting…";
    appendEvent("== hardhat_reset + redeploy ==", "ev-info");

    // Step 1: wipe chain state.
    await fetch(cfg.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "hardhat_reset", params: [], id: 1 }),
    });

    // Step 2: ask the dev script (same origin) to redeploy + re-register.
    btn.textContent = "⟲ Redeploying…";
    const resp = await fetch("/redeploy", { method: "POST" });
    const body = await resp.json();
    if (!resp.ok || !body.ok) throw new Error(body.error ?? `HTTP ${resp.status}`);

    appendEvent(`Redeployed: registry=${shortAddr(body.addresses.registry)}, storageDeal=${shortAddr(body.addresses.storageDeal)}. Reloading…`, "ev-success");

    // Step 3: reload the page so all dashboard state (addresses, dealMemory,
    // openTxDetails, etc.) starts fresh and consistent with the new chain.
    setTimeout(() => window.location.reload(), 600);
  } catch (e) {
    appendEvent(`ERROR: ${e.message ?? String(e)}`, "ev-err");
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

init();
