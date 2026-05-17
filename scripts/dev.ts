/**
 * Local dev stack for the DePIN dashboard.
 *
 * Run in two terminals:
 *   A) npx hardhat node
 *   B) npx hardhat run scripts/dev.ts --network localhost
 *
 * Then open http://localhost:3000 in a browser.
 *
 * This script:
 *   1. Deploys both contracts via Ignition (no-ops if already deployed).
 *   2. Registers signer #1 as a provider (5 ETH stake) if not already active.
 *   3. Starts the provider HTTP server on :8080.
 *   4. Writes dashboard/addresses.json so the front-end can find everything.
 *   5. Serves dashboard/ on :3000 as a static site.
 *   6. Runs until you press Ctrl-C.
 */
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { ethers, ignition } from "hardhat";
import DePIN from "../ignition/modules/DePIN";
import { startProviderServer } from "../agents/provider/server";
import { ProviderRegistry__factory } from "../typechain-types";

const PROVIDER_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // signer 1 (online provider)
const DASHBOARD_PORT = 3000;
const PROVIDER_PORT = 8080;
const RPC_URL = "http://127.0.0.1:8545";
const PROVIDER_STORAGE_DIR = "./.provider-storage";

// Three providers are registered to make the marketplace visible in the
// dashboard. Only the first one runs an HTTP server (PROVIDER_KEY above),
// so deals created in the demo go to signer #1. The others demonstrate
// that the on-chain registry is a real list, not a single hardcoded slot.
type ProviderSpec = { signerIndex: number; capacityGB: bigint; pricePerGB: bigint; stake: bigint };
const PROVIDER_REGISTRATIONS: ProviderSpec[] = [
  { signerIndex: 1, capacityGB: 1000n, pricePerGB: 100n, stake: 5_000_000_000_000_000_000n }, // 5 ETH
  { signerIndex: 3, capacityGB:  500n, pricePerGB:  50n, stake: 3_000_000_000_000_000_000n }, // 3 ETH (cheapest)
  { signerIndex: 4, capacityGB: 2000n, pricePerGB: 200n, stake: 10_000_000_000_000_000_000n },// 10 ETH (largest)
];

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

async function main(): Promise<void> {
  console.log("=== DePIN dev stack ===\n");

  // 1. Deploy (Ignition skips if already deployed at the expected addresses)
  console.log("1. Deploying contracts via Ignition...");
  const deployed = await ignition.deploy(DePIN);
  const registryAddr = await deployed.registry.getAddress();
  const storageDealAddr = await deployed.storageDeal.getAddress();
  console.log(`   ProviderRegistry: ${registryAddr}`);
  console.log(`   StorageDeal:      ${storageDealAddr}\n`);

  // 2. Register providers (skip any already-active to make the script idempotent)
  console.log("2. Registering providers...");
  const signers = await ethers.getSigners();
  for (const spec of PROVIDER_REGISTRATIONS) {
    const signer = signers[spec.signerIndex];
    const registry = ProviderRegistry__factory.connect(registryAddr, signer);
    const existing = await registry.getProvider(signer.address);
    if (existing.active) {
      console.log(`   - ${signer.address} already active (signer #${spec.signerIndex})`);
      continue;
    }
    await (
      await registry.registerProvider(spec.capacityGB, spec.pricePerGB, { value: spec.stake })
    ).wait();
    console.log(
      `   - ${signer.address} registered (signer #${spec.signerIndex}, ` +
        `cap=${spec.capacityGB}GB, price=${spec.pricePerGB} wei/GB, stake=${ethers.formatEther(spec.stake)} ETH)`
    );
  }
  console.log();

  // Signer #1 is the one running the HTTP server, so demos route deals to it.
  const providerSigner = signers[1];

  // 3. Provider HTTP server
  console.log("3. Starting provider HTTP server...");
  const ps = await startProviderServer({
    rpcUrl: RPC_URL,
    privateKey: PROVIDER_KEY,
    registryAddress: registryAddr,
    storageDealAddress: storageDealAddr,
    storageDir: PROVIDER_STORAGE_DIR,
    port: PROVIDER_PORT,
    chunkSize: 512,
  });
  console.log(`   listening on http://localhost:${ps.port}\n`);

  // 4. Write addresses for the dashboard
  const dashboardDir = path.resolve("dashboard");
  await fsp.mkdir(dashboardDir, { recursive: true });
  const addresses = {
    chainId: 31337,
    rpcUrl: RPC_URL,
    providerUrl: `http://localhost:${ps.port}`,
    registry: registryAddr,
    storageDeal: storageDealAddr,
    providerSigner: providerSigner.address,
  };
  await fsp.writeFile(
    path.join(dashboardDir, "addresses.json"),
    JSON.stringify(addresses, null, 2)
  );

  // 5. Static dashboard server
  const staticServer = http.createServer(async (req, res) => {
    let url = (req.url ?? "/").split("?")[0];
    if (url === "/") url = "/index.html";
    const filePath = path.join(dashboardDir, url);
    if (!filePath.startsWith(dashboardDir)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    try {
      const data = await fsp.readFile(filePath);
      const ext = path.extname(filePath);
      res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
      res.end(data);
    } catch {
      res.writeHead(404).end("Not found");
    }
  });
  staticServer.listen(DASHBOARD_PORT, () => {
    console.log(`4. Dashboard:           http://localhost:${DASHBOARD_PORT}`);
    console.log(`   Provider API:        http://localhost:${PROVIDER_PORT}`);
    console.log(`   Hardhat JSON-RPC:    ${RPC_URL}\n`);
    console.log("Press Ctrl-C to stop.\n");
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\nShutting down...");
    await ps.close();
    staticServer.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep the script alive (servers do this implicitly via libuv handles).
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
