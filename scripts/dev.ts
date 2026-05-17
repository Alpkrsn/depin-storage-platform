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
 *   2. Registers 3 providers (one online, two offline-but-on-chain).
 *   3. Starts the provider HTTP server on :8080.
 *   4. Writes dashboard/addresses.json so the front-end can find everything.
 *   5. Serves dashboard/ on :3000 as a static site + exposes POST /redeploy
 *      so the dashboard's "Reset Chain" button can self-heal after wiping
 *      the chain (otherwise the user has to restart this script manually).
 *   6. Runs until you press Ctrl-C.
 */
import http from "node:http";
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

type Addresses = {
  chainId: number;
  rpcUrl: string;
  providerUrl: string;
  registry: string;
  storageDeal: string;
  providerSigner: string;
};

const DASHBOARD_DIR = path.resolve("dashboard");
const ADDRESSES_FILE = path.join(DASHBOARD_DIR, "addresses.json");
const IGNITION_CACHE_DIR = path.join("ignition", "deployments", "chain-31337");

/**
 * Idempotently bring the on-chain state to "ready":
 * - deploy contracts via Ignition (clearing the cache first so a freshly
 *   hardhat_reset'd chain doesn't trip Ignition's stale-deployment check)
 * - register the three provider signers if they're not already active
 * - write the dashboard addresses file
 *
 * Returns the addresses for the caller.
 */
async function deployAndRegister(): Promise<Addresses> {
  // After hardhat_reset, the on-chain bytecode is gone but Ignition still
  // remembers it deployed something at chain-31337 — that mismatch makes
  // future deploys fail. Wiping the cache before each deploy keeps things
  // robust whether or not the chain has been reset.
  await fsp.rm(IGNITION_CACHE_DIR, { recursive: true, force: true });

  const deployed = await ignition.deploy(DePIN);
  const registryAddr = await deployed.registry.getAddress();
  const storageDealAddr = await deployed.storageDeal.getAddress();

  const signers = await ethers.getSigners();
  for (const spec of PROVIDER_REGISTRATIONS) {
    const signer = signers[spec.signerIndex];
    const registry = ProviderRegistry__factory.connect(registryAddr, signer);
    const existing = await registry.getProvider(signer.address);
    if (existing.active) continue;
    await (
      await registry.registerProvider(spec.capacityGB, spec.pricePerGB, { value: spec.stake })
    ).wait();
  }

  const providerSigner = signers[1];
  const addresses: Addresses = {
    chainId: 31337,
    rpcUrl: RPC_URL,
    providerUrl: `http://localhost:${PROVIDER_PORT}`,
    registry: registryAddr,
    storageDeal: storageDealAddr,
    providerSigner: providerSigner.address,
  };
  await fsp.mkdir(DASHBOARD_DIR, { recursive: true });
  await fsp.writeFile(ADDRESSES_FILE, JSON.stringify(addresses, null, 2));
  return addresses;
}

async function main(): Promise<void> {
  console.log("=== DePIN dev stack ===\n");

  // 1+2+4. Deploy + register + write addresses
  console.log("1. Deploying contracts + registering providers...");
  const addresses = await deployAndRegister();
  console.log(`   ProviderRegistry: ${addresses.registry}`);
  console.log(`   StorageDeal:      ${addresses.storageDeal}`);
  console.log(`   Registered ${PROVIDER_REGISTRATIONS.length} providers (signer #1 online, others offline)\n`);

  // 3. Provider HTTP server (the addresses are stable on chain-31337 because
  // Hardhat's signer #0 nonce resets to 0, and CREATE addresses are
  // deterministic from (deployer, nonce). So the URL we pass here is still
  // valid after a hardhat_reset + redeploy.)
  console.log("2. Starting provider HTTP server...");
  const ps = await startProviderServer({
    rpcUrl: RPC_URL,
    privateKey: PROVIDER_KEY,
    registryAddress: addresses.registry,
    storageDealAddress: addresses.storageDeal,
    storageDir: PROVIDER_STORAGE_DIR,
    port: PROVIDER_PORT,
    chunkSize: 512,
  });
  console.log(`   listening on http://localhost:${ps.port}\n`);

  // 5. Static dashboard server + /redeploy endpoint
  const staticServer = http.createServer(async (req, res) => {
    try {
      // CORS preflight + open access so the dashboard (same origin actually,
      // but kept permissive for cross-origin testing) can POST /redeploy.
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        return res.end();
      }

      const url = new URL(req.url ?? "/", `http://localhost:${DASHBOARD_PORT}`);

      // POST /redeploy — the "Reset Chain" button in the dashboard calls this
      // right after a hardhat_reset so the page can self-heal without the
      // user needing to restart this script.
      if (req.method === "POST" && url.pathname === "/redeploy") {
        try {
          const addrs = await deployAndRegister();
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          });
          return res.end(JSON.stringify({ ok: true, addresses: addrs }));
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          res.writeHead(500, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          });
          return res.end(JSON.stringify({ ok: false, error: msg }));
        }
      }

      // Otherwise serve files from dashboard/
      let pathname = url.pathname;
      if (pathname === "/") pathname = "/index.html";
      const filePath = path.join(DASHBOARD_DIR, pathname);
      if (!filePath.startsWith(DASHBOARD_DIR)) {
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
    } catch (e) {
      console.error("static server error:", e);
      res.writeHead(500).end("Internal error");
    }
  });
  staticServer.listen(DASHBOARD_PORT, () => {
    console.log(`3. Dashboard:           http://localhost:${DASHBOARD_PORT}`);
    console.log(`   Provider API:        http://localhost:${PROVIDER_PORT}`);
    console.log(`   Hardhat JSON-RPC:    ${RPC_URL}`);
    console.log(`   Redeploy endpoint:   POST http://localhost:${DASHBOARD_PORT}/redeploy\n`);
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
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
