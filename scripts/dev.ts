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
 *   1. Deploys both contracts via Ignition (clearing any stale Ignition cache).
 *   2. Registers 5 providers (3 with HTTP servers, 2 on-chain-only).
 *   3. Starts one HTTP server per online provider (ports 8080, 8081, 8082).
 *   4. Writes dashboard/addresses.json so the front-end can find everything.
 *   5. Serves dashboard/ on :3000 as a static site + exposes POST /redeploy
 *      so the dashboard's "Reset Chain" button can self-heal after wiping
 *      the chain (otherwise the user has to restart this script manually).
 *   6. Runs until you press Ctrl-C.
 */
import http from "node:http";
import fsp from "node:fs/promises";
import path from "node:path";
import { Mnemonic, HDNodeWallet } from "ethers";
import { ethers, ignition } from "hardhat";
import DePIN from "../ignition/modules/DePIN";
import { startProviderServer } from "../agents/provider/server";
import { ProviderRegistry__factory } from "../typechain-types";

const DASHBOARD_PORT = 3000;
const RPC_URL = "http://127.0.0.1:8545";
const PROVIDER_STORAGE_ROOT = "./.provider-storage";

// Hardhat's default-mnemonic accounts are deterministic — we derive each
// signer's private key from the same mnemonic so each provider HTTP server
// can sign as the correct on-chain address. Public knowledge; only safe
// because these accounts only ever fund local dev networks.
const HARDHAT_MNEMONIC = "test test test test test test test test test test test junk";
function privateKeyForSigner(index: number): string {
  const mnemonic = Mnemonic.fromPhrase(HARDHAT_MNEMONIC);
  const wallet = HDNodeWallet.fromMnemonic(mnemonic, `m/44'/60'/0'/0/${index}`);
  return wallet.privateKey;
}

// Five providers register on-chain. The first three run an HTTP server each
// (different ports) — they are "online" providers actually capable of
// fulfilling deals. The last two are listed in the registry but unreachable,
// to demonstrate that the on-chain marketplace doesn't guarantee
// availability and the protocol's slash mechanism protects consumers.
type ProviderSpec = {
  signerIndex: number;
  capacityGB: bigint;
  pricePerGB: bigint;
  stake: bigint;
  port?: number; // if set, an HTTP server is spawned for this provider
};
const PROVIDER_REGISTRATIONS: ProviderSpec[] = [
  { signerIndex: 1, capacityGB: 1000n, pricePerGB: 100n, stake: 5_000_000_000_000_000_000n,  port: 8080 },
  { signerIndex: 3, capacityGB:  500n, pricePerGB:  50n, stake: 3_000_000_000_000_000_000n,  port: 8081 }, // cheapest
  { signerIndex: 4, capacityGB: 2000n, pricePerGB: 200n, stake: 10_000_000_000_000_000_000n, port: 8082 }, // biggest
  { signerIndex: 5, capacityGB:  750n, pricePerGB:  75n, stake: 4_000_000_000_000_000_000n  }, // offline
  { signerIndex: 6, capacityGB: 1500n, pricePerGB: 150n, stake: 7_000_000_000_000_000_000n  }, // offline
];

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

type ProviderEntry = { address: string; url: string };
type Addresses = {
  chainId: number;
  rpcUrl: string;
  registry: string;
  storageDeal: string;
  providers: ProviderEntry[]; // online providers only — those with HTTP servers
};

const DASHBOARD_DIR = path.resolve("dashboard");
const ADDRESSES_FILE = path.join(DASHBOARD_DIR, "addresses.json");
const IGNITION_CACHE_DIR = path.join("ignition", "deployments", "chain-31337");

/**
 * Idempotently bring the on-chain state to "ready":
 * - deploy contracts via Ignition (clearing the cache first so a freshly
 *   hardhat_reset'd chain doesn't trip Ignition's stale-deployment check)
 * - register all five provider signers if they're not already active
 * - write the dashboard addresses file
 */
async function deployAndRegister(onlineProviders: ProviderEntry[]): Promise<Addresses> {
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

  const addresses: Addresses = {
    chainId: 31337,
    rpcUrl: RPC_URL,
    registry: registryAddr,
    storageDeal: storageDealAddr,
    providers: onlineProviders,
  };
  await fsp.mkdir(DASHBOARD_DIR, { recursive: true });
  await fsp.writeFile(ADDRESSES_FILE, JSON.stringify(addresses, null, 2));
  return addresses;
}

async function main(): Promise<void> {
  console.log("=== DePIN dev stack ===\n");

  // Spawn an HTTP server for each online provider. We need to do this BEFORE
  // computing the online-providers list for addresses.json so we have the
  // addresses + URLs. Contracts haven't been deployed yet — but the provider
  // server's startup checks (it queries getProvider) tolerate that briefly
  // because we register providers immediately after.
  // To keep things simple we deploy first, then start servers.

  console.log("1. Deploying contracts + registering providers...");
  // First deploy with empty online list — we'll write a fuller addresses.json
  // after we start the servers and know their actual URLs.
  let addresses = await deployAndRegister([]);
  console.log(`   ProviderRegistry: ${addresses.registry}`);
  console.log(`   StorageDeal:      ${addresses.storageDeal}`);
  console.log(`   Registered ${PROVIDER_REGISTRATIONS.length} providers ` +
              `(${PROVIDER_REGISTRATIONS.filter(p => p.port !== undefined).length} online, ` +
              `${PROVIDER_REGISTRATIONS.filter(p => p.port === undefined).length} offline)\n`);

  console.log("2. Starting provider HTTP servers...");
  const signers = await ethers.getSigners();
  const servers: Awaited<ReturnType<typeof startProviderServer>>[] = [];
  const onlineEntries: ProviderEntry[] = [];
  for (const spec of PROVIDER_REGISTRATIONS) {
    if (spec.port === undefined) continue;
    const signer = signers[spec.signerIndex];
    const dir = path.join(PROVIDER_STORAGE_ROOT, `port-${spec.port}`);
    const ps = await startProviderServer({
      rpcUrl: RPC_URL,
      privateKey: privateKeyForSigner(spec.signerIndex),
      registryAddress: addresses.registry,
      storageDealAddress: addresses.storageDeal,
      storageDir: dir,
      port: spec.port,
      chunkSize: 512,
    });
    servers.push(ps);
    onlineEntries.push({ address: signer.address, url: `http://localhost:${spec.port}` });
    console.log(`   - ${signer.address} (signer #${spec.signerIndex})  →  http://localhost:${spec.port}`);
  }
  console.log();

  // Rewrite addresses.json now that we know all the URLs.
  addresses = { ...addresses, providers: onlineEntries };
  await fsp.writeFile(ADDRESSES_FILE, JSON.stringify(addresses, null, 2));

  // Static dashboard server + /redeploy endpoint.
  const staticServer = http.createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        return res.end();
      }

      const url = new URL(req.url ?? "/", `http://localhost:${DASHBOARD_PORT}`);

      // POST /redeploy — the "Reset Chain" button calls this right after a
      // hardhat_reset so the page can self-heal without the user needing to
      // restart this script. Provider HTTP servers stay alive — their
      // hard-coded contract addresses are still valid (deterministic CREATE
      // addresses don't change between resets).
      if (req.method === "POST" && url.pathname === "/redeploy") {
        try {
          const addrs = await deployAndRegister(onlineEntries);
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
    console.log(`   Hardhat JSON-RPC:    ${RPC_URL}`);
    console.log(`   Redeploy endpoint:   POST http://localhost:${DASHBOARD_PORT}/redeploy\n`);
    console.log("Press Ctrl-C to stop.\n");
  });

  // Graceful shutdown — close every provider server in parallel.
  const shutdown = async () => {
    console.log("\nShutting down...");
    await Promise.all(servers.map(s => s.close()));
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
