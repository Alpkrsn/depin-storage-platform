# Security Analysis

This document captures the security evaluation of the DePIN storage prototype, mapped one-to-one against the attack vectors and defences declared in the project proposal (§2.4, §4.2).

It is the artefact referenced by **success criterion (iii)** — *no high-severity findings remain unresolved in the Slither report* — and by **proposal §4.2** *Security Evaluation*.

---

## Tools and methodology

| Tool | Version | Purpose |
|---|---|---|
| Slither | 0.11.5 | Static analysis (detector pass) |
| solc-select | 1.2.0 | Pin compiler to Solidity 0.8.28 |
| Hardhat + Mocha + Chai | Toolbox 5 | Adversarial test scenarios (see [`test/Adversarial.test.ts`](test/Adversarial.test.ts)) |
| OpenZeppelin Contracts | 5.6.1 | `ReentrancyGuard`, `Ownable`, `MerkleProof` (audited primitives) |

Run locally:

```powershell
slither . --exclude-dependencies --filter-paths "node_modules|test|contracts/test"
npx hardhat test test/Adversarial.test.ts
```

---

## Slither static analysis

**Result on current `main`: `0 result(s) found`** across 9 contracts and 101 detectors.

The first run produced 7 informational / low-severity findings. Each was addressed as follows:

| # | Detector | Severity | Resolution |
|---|---|---|---|
| 1 | `uninitialized-local` (`count`, `j` in `getActiveProviders`) | Informational | **Fixed** — replaced implicit zero-init with explicit `uint256 x = 0;`. |
| 2 | `naming-convention` (`_storageDeal` param) | Informational | **Fixed** — renamed to `dealContract` to drop the leading underscore. |
| 3 | `timestamp` (`block.timestamp < d.deadline` in `closeDeal`) | Low | **Accepted by design**, suppressed inline. Deadlines are on the order of minutes to hours, so the ±15 second drift a miner can introduce is operationally irrelevant. |
| 4 | `low-level-calls` (`.call{value: x}("")` × 4) | Informational | **Accepted by design**, suppressed inline. These are the standard OpenZeppelin-style ETH transfer pattern; success is checked immediately, all are guarded by `ReentrancyGuard`, and they sit after every state effect (checks-effects-interactions). |

No high- or medium-severity issues were ever reported.

---

## Adversarial scenarios

Six adversarial tests in [`test/Adversarial.test.ts`](test/Adversarial.test.ts) validate each defence in proposal §2.4. All pass.

### §2.4.1 — Sybil attack

| Defence | Validation |
|---|---|
| ETH stake required per provider identity | `N fake providers require N independent stakes (economic deterrence)` — registers 5 distinct addresses, asserts registry holds `5 × stake` |
| | `registration with zero stake is rejected (StakeRequired)` — the cheapest possible Sybil attempt is rejected |
| Cannot inflate from one stake | Re-registering the same address while active reverts `AlreadyActive` |

**Conclusion.** An attacker creating *N* identities pays exactly *N × stake* — there is no shared pool, no discount, no escape from the per-identity cost. Sybil scaling is bounded by the attacker's ETH balance.

### §2.4.2 — Lazy provider / free-riding

| Defence | Validation |
|---|---|
| Invalid Merkle proofs are rejected | `provider submitting invalid proof is rejected (no payment, no attestation)` — forging a leaf reverts `InvalidMerkleProof`; the on-chain `verifiedChunks[N][i]` stays `false` |
| Silent provider is slashed | `provider that never submits proofs is slashed AND consumer is refunded` — after the deadline, `closeDeal` refunds `escrow` to the consumer AND `slash`es the same amount from the provider's stake (consumer nets `2 × escrow`, provider stake loses `1 × escrow`) |

**Conclusion.** A provider who takes payment and walks away is *worse off* than one who never registered — they lose `escrow` of stake on top of getting zero payment.

### §2.4.3 — Consumer fraud (unjustified objection)

| Defence | Validation |
|---|---|
| Settlement is driven by cryptographic proofs, not user consent | `consumer cannot block payment if provider submitted valid proofs` — the consumer (the party with the financial motive to lie) calls `closeDeal` themselves and the escrow still settles to the provider, because every chunk is attested |

**Conclusion.** "User decision is bypassed" — exactly the property proposal §2.4.3 promised.

### §2.4.4 — Reentrancy

Two layers of defence:

1. **`ReentrancyGuard`** on every payable / refund / slash function (OZ-audited).
2. **Checks-effects-interactions** ordering — state transitions (`d.status = Slashed`) happen *before* the external `.call{value:…}`. Even if the guard were absent, a re-entered `closeDeal` would revert with `DealNotActive` because the status is no longer `Active`.

| Defence | Validation |
|---|---|
| Combined re-entry protection | `malicious consumer cannot re-enter closeDeal during refund` — deploys [`MaliciousConsumer.sol`](contracts/test/MaliciousConsumer.sol), which on receiving the slash-path refund tries to call `closeDeal` again from its `receive()`. Assertions: re-entry was *attempted* (`reentryAttempts > 0`) and *failed* (`reentrySucceeded == false`); the deal still cleanly reaches `Slashed`. |

**Conclusion.** Both layers verified independently — guard fires, and even hypothetically past the guard the CEI ordering would still block the re-entry.

### SWC vulnerability classes

| SWC | Class | Mitigation in this code base |
|---|---|---|
| SWC-101 | Integer overflow / underflow | Solidity 0.8+ checked arithmetic (no `unchecked` blocks anywhere) |
| SWC-107 | Reentrancy | OZ `ReentrancyGuard` + CEI ordering (see above) |
| SWC-115 | `tx.origin` authentication | Not used — all auth checks compare `msg.sender` |
| SWC-104 | Unchecked call return value | Every `.call{value:}` checks `(bool ok)` and reverts on failure with `TransferFailed` |
| SWC-105 | Unprotected ether withdrawal | `withdrawStake()` checks `p.exists` and `!p.active`; only the staker withdraws their own stake |
| SWC-114 | Transaction order dependence | Single-challenge model: a malicious miner could try to pick a block whose `prevrandao` is favourable. Acknowledged as a **known limitation** — see `README.md` *Known limitations*. |

---

## Acknowledged residual risks

These are *not* defects — they are deliberate scope decisions for a prototype, documented in `README.md` *Known limitations*.

1. **`block.prevrandao` is predictable one block in advance.** A provider colluding with a miner could pick favourable challenge indices. *Mitigation in production:* Chainlink VRF or a commit-reveal scheme.
2. **A provider can pre-attest every chunk** to defeat the single-challenge model (gas is the only deterrent). *Mitigation in production:* a three-step `challenge → respond → settle` lifecycle that only accepts proofs *after* the challenge index is published.
3. **Push-payment refund.** A consumer contract that reverts on receive can DoS `closeDeal`. *Mitigation in production:* pull-payment pattern (consumer calls `withdraw()` later).
4. **Unbounded `providerList`** — `getActiveProviders` is O(n) over every provider that ever registered. Fine at prototype scale.

---

## Summary against proposal success criteria

| Criterion | Status |
|---|---|
| (iii) No high-severity Slither findings remain | ✅ 0 results (all severities) |
| Sybil-resistance scenario validated | ✅ 2 tests |
| Lazy-provider scenario validated | ✅ 2 tests |
| Consumer-fraud scenario validated | ✅ 1 test |
| Reentrancy scenario validated (with malicious contract) | ✅ 1 test + custom `MaliciousConsumer.sol` |
| OpenZeppelin libraries used for audited primitives | ✅ ReentrancyGuard, Ownable, MerkleProof |
