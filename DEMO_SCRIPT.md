# Live Demo Script

> A 5-minute walkthrough you can follow on screen while presenting to the
> instructor. Print this or keep it open in a second window. Each step has the
> button to click, what to say, and what to point at on screen.

---

## Before you start (offline prep, do this 5 min before the demo)

1. Open two terminals in the project folder:
   - **Terminal A:** `npm run node` (leave it running, prints test accounts)
   - **Terminal B:** `npm run dev` (deploys + registers 3 providers + starts dashboard)
2. Open **http://localhost:3000** in your browser. Wait until status shows `✓ chain 31337`.
3. **If you ran the demo before:** click `⟲ Reset Chain` in the footer (or hit `Ctrl-C` and re-run `npm run dev`) so the deal counter starts at 0.

---

## Stage 0 · Open with the elevator pitch (30 seconds)

**Say:**
> "Our project is a decentralized storage marketplace built on Ethereum. The
> idea is: people with spare disk space rent it out, people who need storage
> pay them in ETH, and a smart contract holds the money in escrow until the
> storage provider proves they're actually keeping the file. If they can't
> prove it, the consumer gets refunded AND part of the provider's stake is
> taken away as a penalty. There's no central authority. Trust is replaced by
> math and economics."

**Point at:** Header title + the on-chain badge `✓ chain 31337`.

---

## Stage 1 · The marketplace (45 seconds)

**Point at:** *Providers* panel (left).

**Say:**
> "We have three providers registered on-chain — each one has put up an ETH
> stake as collateral and advertised their price and capacity. The green dot
> means they're actually running a server. The grey dots mean they registered
> on-chain but their HTTP server isn't reachable — they're just listings
> right now."

**Then point at:** Stats banner at the top (Deals = 0, Slash rate = —, AWS comparison).

**Say:**
> "Up here you can see aggregate stats — number of deals, ETH in escrow, gas
> consumed, and a quick comparison to a centralized alternative like AWS S3.
> Note the comparison isn't strictly about price — it's about value: AWS is
> predictable but locks you in; ours is permissionless and self-enforcing."

---

## Stage 2 · Happy-path deal (90 seconds)

**Do:**
1. Make sure the **🟢 online provider** is selected in the *Provider:* dropdown.
2. Click **▶ Run Demo Deal**.

**While it runs (~10 seconds), say:**
> "What's happening: the browser generates a random 3 KB file, splits it into
> six chunks, hashes each chunk into a Merkle tree, and locks 0.05 ETH in
> escrow on the smart contract with the tree's root as the commitment. The
> provider's server picks up the upload, verifies the root matches what's
> on-chain, and submits one Merkle proof per chunk — six on-chain
> transactions."

**Wait for the deal card to appear, then point at:** the Merkle tree SVG.

**Say:**
> "This little tree IS the Merkle structure. Each leaf is a chunk hash, each
> internal node is the hash of its children. The provider has just proved
> every leaf — that's why they all turn green. The big blue node on top is
> the root, which was committed on-chain when the deal was created."

**Then click:** `▸ On-chain transactions (8)` on the deal card.

**Say:**
> "These eight rows are real Ethereum transactions: one createDeal, six
> submitProofs, and after we close it, one closeDeal. You see the block
> number, the gas used, and the transaction hash. In production these would
> be searchable on Etherscan. Total gas is well under 500K — that was our
> non-functional requirement (NFR2) from the proposal."

**Wait for the 30s timer**, then click **Close Deal** on the card.

**Say:**
> "Closing the deal triggers a random challenge — the contract picks one
> chunk index using block.prevrandao. Since the provider attested every
> chunk, whichever one gets picked has a valid proof, so the escrow goes to
> the provider. Status flips to green Completed."

**Point at:** the yellow-highlighted path in the Merkle tree.

**Say:**
> "The yellow leaf is the one the contract randomly challenged. The yellow
> line traces the proof path used to verify it against the root."

---

## Stage 3 · The slash path — *this is the key one* (90 seconds)

**Say:**
> "OK that worked. But the whole point of using a blockchain is that we don't
> have to TRUST the provider. So let's see what happens if a provider
> misbehaves."

**Do:**
1. Switch the *Provider* dropdown to one of the **⚪ offline** providers.
2. Click **▶ Run Demo Deal**.

**Say (while it runs):**
> "I'm telling the consumer to do a deal with a provider whose HTTP server
> isn't even running. The deal still gets created on-chain — the registry
> doesn't enforce that providers are actually reachable. The dashboard
> detects the upload would fail and skips it, simulating a no-show provider."

**Wait 30s, then click Close Deal.**

**Say (as it processes):**
> "And… the deal flips to red Slashed. The Merkle tree shows zero green
> leaves — no proofs were ever submitted, so the random challenge can't
> match anything. What happens to the money?"

**Point at:** the events log (right panel) and the deal card.

**Say:**
> "Two things: first, the consumer gets their 0.05 ETH escrow refunded.
> Second, an EQUIVALENT amount is taken from the provider's stake and sent
> to the consumer as compensation. So the consumer walks away with 0.10 ETH
> — twice their escrow — and the bad provider loses 0.05 ETH of their stake
> for being offline.
>
> This is the cryptoeconomic guarantee: providers have skin in the game. If
> they don't deliver, they lose money. No customer-service ticket, no
> arbitration, no legal action — it's automatic the moment closeDeal is
> called."

---

## Stage 4 · Wrap up & numbers (45 seconds)

**Point at the stats banner — it should now show real numbers.**

**Say:**
> "After two deals you can see the stats update: 2 deals total, 1 completed,
> 1 slashed — that's a 50% slash rate in this demo, which is artificial
> because I deliberately picked a bad provider. Gas consumed is around 800K
> across both deals. Both stayed under the per-deal NFR2 budget of 500K."

**Then say (no clicking, just close out):**
> "Behind what you see here we have:
> - 53 unit and integration tests, all passing
> - 100% line coverage on the contracts
> - Slither static analysis with zero outstanding findings
> - Adversarial tests for Sybil attacks, reentrancy, lazy providers, and
>   consumer fraud — all blocked
> - And SECURITY.md documents every one of those defences with citations to
>   the proposal sections.
>
> The whole project is on GitHub at Alpkrsn/depin-storage-platform."

---

## Common questions you might get (cheat answers)

| Question | One-line answer |
|---|---|
| "Why don't you use VRF for randomness?" | "VRF is the production answer — `block.prevrandao` is acceptable for a prototype and we document it as future work." |
| "What stops the provider from submitting all chunks upfront?" | "Nothing in this version. Gas cost is the only deterrent. Real fix is reveal-after-challenge — future work." |
| "Is it deployed to Sepolia?" | "We deployed locally on a Hardhat node which is functionally equivalent. The Sepolia stub exists in `hardhat.config.ts`." |
| "Why no RST ERC-20 token?" | "ETH escrow does the same job for the prototype. ERC-20 would add a contract without changing the protocol semantics. Scope refinement documented in README." |
| "Why no CPU/GPU compute marketplace?" | "Computational integrity proofs are a research problem — zk-SNARKs or TEEs. Out of scope for a 4-week prototype." |
| "How would consumers find online providers in production?" | "Either store the URL on-chain in the registry (gas cost), use libp2p discovery, or run an off-chain indexer. We document this gap." |
| "Could the provider abuse `block.prevrandao` to pick a favourable index?" | "Yes — a miner-colluding provider could. That's why we list it as a known limitation. VRF or commit-reveal fixes it." |
| "What if the consumer's wallet rejects the refund?" | "Push payment would DoS. Production should use pull payment — listed in known limitations." |
| "Coverage 100% but is that meaningful?" | "Line coverage isn't the only thing — we also wrote adversarial tests for the threat model, not just paths." |
| "How do you handle provider going offline mid-deal?" | "Exactly what we just demoed — they get slashed at close. Consumer fully protected." |

---

## If something goes wrong mid-demo

- **Provider HTTP server crashed:** restart `npm run dev`.
- **Dashboard shows wrong status:** hard refresh the page (`Ctrl+Shift+R`).
- **Tx fails with nonce errors:** click `⟲ Reset Chain`, restart `npm run dev`.
- **Tree visualisation missing:** that's normal for deals not created in this dashboard — the chain doesn't store leaf hashes, only the root.
- **"It's not connecting":** check Terminal A — `npx hardhat node` must be running.

---

## Final close (10 seconds)

> "That's the demo. Happy to take questions."
