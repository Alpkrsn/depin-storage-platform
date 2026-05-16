import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { JsonRpcProvider, Wallet } from "ethers";
import {
  ProviderRegistry__factory,
  StorageDeal__factory,
} from "../../typechain-types";
import { chunkFile, DEFAULT_CHUNK_SIZE } from "../lib/chunks";

type Config = {
  rpcUrl: string;
  privateKey: string;
  registryAddress: string;
  storageDealAddress: string;
  storageDir: string;
  port: number;
  chunkSize: number;
};

function loadConfig(): Config {
  const required = ["PROVIDER_PRIVATE_KEY", "REGISTRY_ADDRESS", "STORAGE_DEAL_ADDRESS"];
  for (const k of required) {
    if (!process.env[k]) throw new Error(`Missing env var ${k}`);
  }
  return {
    rpcUrl: process.env.RPC_URL ?? "http://127.0.0.1:8545",
    privateKey: process.env.PROVIDER_PRIVATE_KEY!,
    registryAddress: process.env.REGISTRY_ADDRESS!,
    storageDealAddress: process.env.STORAGE_DEAL_ADDRESS!,
    storageDir: process.env.PROVIDER_STORAGE_DIR ?? "./.provider-storage",
    port: Number(process.env.PROVIDER_PORT ?? 8080),
    chunkSize: Number(process.env.CHUNK_SIZE ?? DEFAULT_CHUNK_SIZE),
  };
}

async function readRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of req) {
    parts.push(chunk as Buffer);
  }
  return Buffer.concat(parts);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function parseDealId(req: http.IncomingMessage): bigint {
  const url = new URL(req.url ?? "", "http://localhost");
  const raw = url.searchParams.get("dealId") ?? url.pathname.split("/").pop();
  if (!raw || !/^\d+$/.test(raw)) throw new Error("invalid dealId");
  return BigInt(raw);
}

export async function startProviderServer(cfg: Config = loadConfig()): Promise<{
  close: () => Promise<void>;
  address: string;
  port: number;
}> {
  await fs.mkdir(cfg.storageDir, { recursive: true });

  const provider = new JsonRpcProvider(cfg.rpcUrl);
  const wallet = new Wallet(cfg.privateKey, provider);
  const registry = ProviderRegistry__factory.connect(cfg.registryAddress, wallet);
  const storageDeal = StorageDeal__factory.connect(cfg.storageDealAddress, wallet);

  // Sanity check: this wallet should be a registered, active provider.
  const me = await registry.getProvider(wallet.address);
  if (!me.active) {
    console.warn(
      `[provider] WARNING: wallet ${wallet.address} is not active in the registry — ` +
        `deals will be rejected until registerProvider() is called.`
    );
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "", "http://localhost");

      if (req.method === "GET" && url.pathname === "/health") {
        return sendJson(res, 200, { ok: true, address: wallet.address });
      }

      if (req.method === "POST" && url.pathname === "/store") {
        const dealId = parseDealId(req);
        const body = await readRequestBody(req);
        if (body.length === 0) return sendJson(res, 400, { error: "empty body" });

        const deal = await storageDeal.getDeal(dealId);
        if (deal.provider.toLowerCase() !== wallet.address.toLowerCase()) {
          return sendJson(res, 403, {
            error: `deal ${dealId} is not assigned to this provider`,
          });
        }

        const file = chunkFile(body, cfg.chunkSize);

        if (file.totalChunks !== Number(deal.totalChunks)) {
          return sendJson(res, 400, {
            error: `chunk count mismatch: file=${file.totalChunks} deal=${deal.totalChunks}`,
          });
        }
        if (file.tree.root.toLowerCase() !== deal.merkleRoot.toLowerCase()) {
          return sendJson(res, 400, {
            error: `merkleRoot mismatch: file=${file.tree.root} deal=${deal.merkleRoot}`,
          });
        }

        // Persist each chunk to disk so we can serve GET /file later.
        const dealDir = path.join(cfg.storageDir, dealId.toString());
        await fs.mkdir(dealDir, { recursive: true });
        await Promise.all(
          file.chunks.map((c, i) =>
            fs.writeFile(path.join(dealDir, `${i}.bin`), c)
          )
        );

        // Submit proofs for every chunk. Explicit nonces avoid the ethers v6 +
        // hardhat-automine race where "pending" nonce queries can return stale
        // values inside a tight loop.
        const startNonce = await wallet.getNonce("latest");
        const txs: string[] = [];
        for (let i = 0; i < file.totalChunks; i++) {
          const proof = file.tree.getProof(i);
          const tx = await storageDeal.submitProof(
            dealId,
            i,
            proof,
            file.leaves[i],
            { nonce: startNonce + i }
          );
          await tx.wait();
          txs.push(tx.hash);
        }

        return sendJson(res, 200, {
          ok: true,
          dealId: dealId.toString(),
          totalChunks: file.totalChunks,
          merkleRoot: file.tree.root,
          submittedTxs: txs,
        });
      }

      if (req.method === "GET" && url.pathname.startsWith("/file/")) {
        const dealId = parseDealId(req);
        const dealDir = path.join(cfg.storageDir, dealId.toString());
        let files: string[];
        try {
          files = await fs.readdir(dealDir);
        } catch {
          return sendJson(res, 404, { error: "deal not found" });
        }
        const sorted = files
          .filter((f) => f.endsWith(".bin"))
          .sort((a, b) => Number(a.replace(".bin", "")) - Number(b.replace(".bin", "")));
        const parts: Buffer[] = [];
        for (const f of sorted) {
          parts.push(await fs.readFile(path.join(dealDir, f)));
        }
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        return res.end(Buffer.concat(parts));
      }

      sendJson(res, 404, { error: "not found" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      sendJson(res, 500, { error: msg });
    }
  });

  await new Promise<void>((resolve) => server.listen(cfg.port, resolve));
  const port = (server.address() as { port: number }).port;
  console.log(`[provider] listening on http://127.0.0.1:${port} as ${wallet.address}`);

  return {
    address: wallet.address,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// Allow `npx ts-node agents/provider/server.ts` to start the server directly.
if (require.main === module) {
  startProviderServer().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
