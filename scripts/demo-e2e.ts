/**
 * End-to-end demo for the DePIN storage platform.
 *
 * Prerequisites — run in two terminals:
 *   1) npx hardhat node                          (in terminal A — keep running)
 *   2) npx hardhat run scripts/demo-e2e.ts --network localhost   (in terminal B)
 *
 * The script:
 *   1. Deploys both contracts via the DePIN Ignition module.
 *   2. Registers signer #1 as a provider (1 ETH stake).
 *   3. Spawns the provider HTTP server (in-process) for that signer.
 *   4. Builds a random ~3KB demo file, chunks it, computes the Merkle root.
 *   5. Consumer (signer #2) calls createDeal — escrow 0.05 ETH, totalChunks=6.
 *   6. Consumer POSTs the file to the provider. Provider verifies the root
 *      against the on-chain deal and submits one proof per chunk.
 *   7. Fast-forwards past the deadline via `evm_increaseTime`.
 *   8. Anyone closes the deal — since every chunk was attested, any
 *      challengeIndex passes → escrow paid to provider.
 *   9. Prints balances + deal status.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ethers, ignition, network } from "hardhat";
import DePIN from "../ignition/modules/DePIN";
import { startProviderServer } from "../agents/provider/server";
import { chunkFile } from "../agents/lib/chunks";
import {
  ProviderRegistry__factory,
  StorageDeal__factory,
} from "../typechain-types";
import type { Log } from "ethers";

// Hardhat's well-known default-mnemonic accounts (public knowledge — these are
// only safe to embed because they only ever fund local dev networks).
const DEFAULT_PRIVATE_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // signer 0
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", // signer 1 (provider)
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // signer 2 (consumer)
];

async function main(): Promise<void> {
  console.log("=== DePIN demo ===\n");

  // 1. Deploy
  console.log("1. Deploying contracts via Ignition...");
  const deployed = await ignition.deploy(DePIN);
  const registryAddr = await deployed.registry.getAddress();
  const storageDealAddr = await deployed.storageDeal.getAddress();
  console.log(`   ProviderRegistry: ${registryAddr}`);
  console.log(`   StorageDeal:      ${storageDealAddr}\n`);

  const [, providerSigner, consumerSigner] = await ethers.getSigners();
  console.log(`   provider signer:  ${providerSigner.address}`);
  console.log(`   consumer signer:  ${consumerSigner.address}\n`);

  // Re-bind to typed factories — Ignition returns generic BaseContract.
  const registry = ProviderRegistry__factory.connect(registryAddr, providerSigner);
  const storageDeal = StorageDeal__factory.connect(storageDealAddr, consumerSigner);

  // 2. Register provider
  console.log("2. Registering provider with 1 ETH stake...");
  await (
    await registry.registerProvider(1000n, 100n, { value: ethers.parseEther("1") })
  ).wait();

  // 3. Start provider HTTP server in this process
  console.log("3. Starting provider HTTP server (in-process)...");
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "depin-prov-"));
  const server = await startProviderServer({
    rpcUrl: "http://127.0.0.1:8545",
    privateKey: DEFAULT_PRIVATE_KEYS[1],
    registryAddress: registryAddr,
    storageDealAddress: storageDealAddr,
    storageDir,
    port: 0, // let the OS pick a free port
    chunkSize: 512,
  });
  console.log(`   listening on port ${server.port}\n`);

  try {
    // 4. Build demo file
    console.log("4. Generating random ~3KB demo file...");
    const fileData = randomBytes(3000);
    const f = chunkFile(fileData, 512);
    console.log(`   ${fileData.length} bytes -> ${f.totalChunks} chunks, root=${f.tree.root}\n`);

    // 5. Consumer creates deal
    console.log("5. Consumer createDeal (escrow 0.05 ETH, duration 60s)...");
    const escrow = ethers.parseEther("0.05");
    const durationSec = 60n;
    const createTx = await storageDeal.createDeal(
      providerSigner.address,
      f.tree.root,
      f.totalChunks,
      durationSec,
      { value: escrow }
    );
    const receipt = await createTx.wait();
    const sdInterface = StorageDeal__factory.createInterface();
    const dealCreated = receipt!.logs
      .map((l: Log) => {
        try {
          return sdInterface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((l) => l?.name === "DealCreated");
    const dealId = dealCreated!.args.dealId as bigint;
    console.log(`   dealId=${dealId}  tx=${createTx.hash}\n`);

    // 6. POST file to provider, which submits proofs for every chunk
    console.log("6. POSTing file to provider /store...");
    const url = `http://127.0.0.1:${server.port}/store?dealId=${dealId}`;
    const resp = await fetch(url, { method: "POST", body: fileData });
    const body = (await resp.json()) as { submittedTxs?: string[]; error?: string };
    console.log(`   provider responded ${resp.status}: ${body.submittedTxs?.length ?? 0} proofs submitted\n`);
    if (resp.status !== 200) throw new Error(`provider rejected: ${JSON.stringify(body)}`);

    // 7. Fast-forward past the deadline
    console.log("7. Advancing time past the deadline...");
    await network.provider.send("evm_increaseTime", [Number(durationSec) + 1]);
    await network.provider.send("evm_mine", []);

    // 8. Close deal
    const providerBalBefore = await ethers.provider.getBalance(providerSigner.address);
    console.log("8. Closing deal...");
    const closeTx = await storageDeal.closeDeal(dealId);
    await closeTx.wait();
    const providerBalAfter = await ethers.provider.getBalance(providerSigner.address);

    const deal = await storageDeal.getDeal(dealId);
    const statusName = ["Active", "Completed", "Slashed"][Number(deal.status)] ?? "?";
    console.log(`   tx=${closeTx.hash}  status=${deal.status} (${statusName})`);
    console.log(`   provider balance: ${ethers.formatEther(providerBalBefore)} -> ${ethers.formatEther(providerBalAfter)} ETH`);
    console.log(`   delta = +${ethers.formatEther(providerBalAfter - providerBalBefore)} ETH (expected ≈ ${ethers.formatEther(escrow)})\n`);

    // 9. Verify file retrieval works
    console.log("9. Retrieving file from provider /file/<dealId>...");
    const getResp = await fetch(`http://127.0.0.1:${server.port}/file/${dealId}`);
    const got = Buffer.from(await getResp.arrayBuffer());
    console.log(`   got ${got.length} bytes, matches=${got.equals(fileData)}\n`);

    console.log("=== Demo complete ✓ ===");
  } finally {
    await server.close();
    await fs.rm(storageDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
