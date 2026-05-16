# Off-chain agents

Two Node.js processes that talk to the on-chain contracts and to each other
over plain HTTP. Storage-only (no compute), file transfer (no libp2p).

```
agents/
  lib/             # shared utilities (Merkle tree, chunk-splitter)
    merkle.ts
    chunks.ts
  provider/
    server.ts      # HTTP server: stores files, submits Merkle proofs on-chain
  consumer/
    cli.ts         # CLI: chunks files, createDeal, POST upload, closeDeal
```

## Quick demo (one command)

The fully-scripted end-to-end demo is at [`scripts/demo-e2e.ts`](../scripts/demo-e2e.ts):

```powershell
# Terminal A — start a local Hardhat node and leave it running:
npx hardhat node

# Terminal B — run the demo against that node:
npx hardhat run scripts/demo-e2e.ts --network localhost
```

The demo deploys both contracts, registers a provider, spawns the provider
HTTP server in-process, runs the full deal lifecycle (create → upload + attest
→ advance time → close), and prints balance deltas.

## Manual run

### 1. Start a local node

```powershell
npx hardhat node
```

This prints 20 pre-funded test accounts with their private keys. The default
mnemonic is `"test test test test test test test test test test test junk"`.

### 2. Deploy contracts

```powershell
npx hardhat ignition deploy ignition/modules/DePIN.ts --network localhost
```

Note the printed `DePIN#ProviderRegistry` and `DePIN#StorageDeal` addresses.

### 3. Register the provider

Use any signer (e.g. the second hardhat account). One option:

```powershell
npx hardhat console --network localhost
> const r = await ethers.getContractAt("ProviderRegistry", "<registry-addr>")
> const [_, prov] = await ethers.getSigners()
> await r.connect(prov).registerProvider(1000n, 100n, { value: ethers.parseEther("1") })
```

### 4. Start the provider server

```powershell
$env:RPC_URL="http://127.0.0.1:8545"
$env:PROVIDER_PRIVATE_KEY="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
$env:REGISTRY_ADDRESS="<registry-addr>"
$env:STORAGE_DEAL_ADDRESS="<deal-addr>"
$env:PROVIDER_PORT="8080"
npx ts-node agents/provider/server.ts
```

### 5. Run the consumer

```powershell
$env:CONSUMER_PRIVATE_KEY="0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"
$env:REGISTRY_ADDRESS="<registry-addr>"
$env:STORAGE_DEAL_ADDRESS="<deal-addr>"

# Create a deal: chunks the file, calls createDeal, POSTs file to the provider
npx ts-node agents/consumer/cli.ts create `
  --provider <provider-signer-addr> `
  --provider-url http://localhost:8080 `
  --file ./somefile.bin `
  --escrow 0.05 `
  --duration 60

# Inspect a deal
npx ts-node agents/consumer/cli.ts inspect <dealId>

# Close after the deadline
npx ts-node agents/consumer/cli.ts close <dealId>
```

## Protocol

```
consumer                                      provider                  chain
   |                                              |                       |
   | chunkFile(data) -> {chunks, root, totalCh}   |                       |
   | createDeal(provider, root, totalCh, dur)     |                       |
   |--------------------------------------------------------------------->|
   |   <- dealId                                                          |
   |                                                                      |
   | POST /store?dealId=N  (raw file bytes)       |                       |
   |--------------------------------------------->|                       |
   |                                              | chunkFile + verify    |
   |                                              | root against deal     |
   |                                              | persist chunks        |
   |                                              | submitProof(N,i,...)  |
   |                                              |---------------------->|
   |                                              |   (one tx per chunk)  |
   |   <- 200 { submittedTxs: [...] }             |                       |
   |                                                                      |
   |   ...wait for deadline...                                            |
   |                                                                      |
   | closeDeal(N)                                                         |
   |--------------------------------------------------------------------->|
   |   challengeIndex = prevrandao % totalCh                              |
   |   verifiedChunks[N][index] ?                                         |
   |     -> yes: escrow -> provider (Completed)                           |
   |     -> no:  refund consumer + slash provider stake (Slashed)         |
```
