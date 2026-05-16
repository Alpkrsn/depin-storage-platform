# CLAUDE.md

Project context for Claude Code sessions in this repository.

## Project

**DePIN-Style Resource Sharing Platform** — university blockchain course project (COM4532 *Blockchain Technology and Public Ledgers*, Group 19, 3 members).

A decentralized **storage** marketplace: providers rent unused disk space, consumers pay via on-chain escrow, and the contract releases payments only after the provider submits a valid Merkle proof-of-storage. Failed proofs slash the provider's stake.

## Scope (narrowed from original proposal)

The original proposal mentions a broader system; the prototype is intentionally scoped down:

- **Storage only** — no CPU/GPU compute (note as "scope refinement" in report)
- **Plain ETH payments** — no RST ERC-20 token
- **Two contracts only**: `ProviderRegistry.sol`, `StorageDeal.sol`
- **Single challenge per deal** — `closeDeal` triggers one Merkle challenge using `block.prevrandao` (acknowledge VRF as future work)
- **Simple HTTP file transfer** between agents — no libp2p
- **Hardcoded slashing/fee params** — no governance contract

## NFR targets (Table 4.3 in proposal)

- **NFR2**: ≤ 500K gas total for a full deal lifecycle
- **NFR3**: ≥ 80% line coverage

## Stack

- Hardhat 2 (TypeScript) + `@nomicfoundation/hardhat-toolbox` v5
- `@openzeppelin/contracts` v5 (use `ReentrancyGuard`, `MerkleProof` — do not reinvent)
- Solidity **0.8.28**, optimizer enabled (runs: 200)
- Mocha + Chai matchers + ethers v6 for tests
- Node v24 / Windows / PowerShell

## Repo layout

```
contracts/         # Solidity sources
test/              # Mocha tests (TypeScript)
ignition/modules/  # Hardhat Ignition deploy modules
hardhat.config.ts  # Solidity 0.8.28 + optimizer, Sepolia stub, gasReporter, 60s mocha timeout
.env.example       # Copy to .env and fill in for Sepolia deploys
```

## Common commands

Run from the repo root:

```powershell
npx hardhat compile        # build contracts
npx hardhat test           # run all tests
$env:REPORT_GAS="true"; npx hardhat test   # tests with gas report
```

## Coding conventions

- One file at a time: write contract → write tests → compile + test green → commit → next file.
- Use OpenZeppelin libraries instead of hand-rolling primitives.
- `ReentrancyGuard` on any function that handles ETH transfers (payable / withdraw).
- Custom errors (`error Foo();`) instead of `require(..., "string")` — cheaper gas.
- Emit an event for every state transition (provider registered, deal created, proof submitted, deal closed/slashed).
- Brief inline comments explaining *why* a design choice was made (e.g. why prevrandao, why this storage layout) — not what the code does line-by-line.

## What is in scope this week (Week 1)

1. `ProviderRegistry.sol` — Provider struct, register/deactivate/withdrawStake, getActiveProviders view, events, ReentrancyGuard.
2. `StorageDeal.sol` skeleton — Deal struct + status enum, createDeal (escrow), submitProof (OZ MerkleProof), closeDeal (prevrandao challenge + settle/slash), events. Calls into ProviderRegistry to slash stake.
3. Happy-path tests for both.

## Out of scope this week

- Provider/consumer off-chain agents (HTTP file transfer)
- Frontend
- Sepolia deploy scripts (Ignition modules are scaffolded but not written yet)
- VRF, governance, multi-challenge protocols
