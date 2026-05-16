import fs from "node:fs/promises";
import { JsonRpcProvider, Wallet, parseEther, formatEther, EventLog } from "ethers";
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
  chunkSize: number;
};

function loadConfig(): Config {
  const required = ["CONSUMER_PRIVATE_KEY", "REGISTRY_ADDRESS", "STORAGE_DEAL_ADDRESS"];
  for (const k of required) {
    if (!process.env[k]) throw new Error(`Missing env var ${k}`);
  }
  return {
    rpcUrl: process.env.RPC_URL ?? "http://127.0.0.1:8545",
    privateKey: process.env.CONSUMER_PRIVATE_KEY!,
    registryAddress: process.env.REGISTRY_ADDRESS!,
    storageDealAddress: process.env.STORAGE_DEAL_ADDRESS!,
    chunkSize: Number(process.env.CHUNK_SIZE ?? DEFAULT_CHUNK_SIZE),
  };
}

function getArg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i === process.argv.length - 1) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required arg --${name}`);
  }
  return process.argv[i + 1];
}

export async function createDealCmd(cfg: Config = loadConfig()): Promise<{
  dealId: bigint;
  txHash: string;
  storeStatus: number;
  storeBody: unknown;
}> {
  const providerAddress = getArg("provider");
  const providerUrl = getArg("provider-url");
  const filePath = getArg("file");
  const escrowEth = getArg("escrow", "0.1");
  const durationSec = BigInt(getArg("duration", "3600"));

  const data = await fs.readFile(filePath);
  const file = chunkFile(data, cfg.chunkSize);

  const provider = new JsonRpcProvider(cfg.rpcUrl);
  const wallet = new Wallet(cfg.privateKey, provider);
  const storageDeal = StorageDeal__factory.connect(cfg.storageDealAddress, wallet);

  const escrow = parseEther(escrowEth);
  console.log(`[consumer] file=${filePath} chunks=${file.totalChunks} root=${file.tree.root}`);
  console.log(`[consumer] creating deal: provider=${providerAddress} escrow=${escrowEth} ETH duration=${durationSec}s`);

  const tx = await storageDeal.createDeal(
    providerAddress,
    file.tree.root,
    file.totalChunks,
    durationSec,
    { value: escrow }
  );
  const receipt = await tx.wait();
  if (!receipt) throw new Error("no receipt");

  // Pull dealId from the DealCreated event log.
  const dealCreatedTopic = storageDeal.interface.getEvent("DealCreated").topicHash;
  const log = receipt.logs.find(
    (l) => l.address.toLowerCase() === cfg.storageDealAddress.toLowerCase() && l.topics[0] === dealCreatedTopic
  );
  if (!log) throw new Error("DealCreated event not found in receipt");
  const parsed = storageDeal.interface.parseLog(log)!;
  const dealId = parsed.args.dealId as bigint;
  console.log(`[consumer] dealId=${dealId} tx=${tx.hash}`);

  // Upload file to the provider's HTTP server, which will verify the
  // merkleRoot matches the on-chain deal and submit per-chunk proofs.
  const url = `${providerUrl.replace(/\/$/, "")}/store?dealId=${dealId.toString()}`;
  console.log(`[consumer] POST ${url} (${data.length} bytes)`);
  const resp = await fetch(url, { method: "POST", body: data });
  const body = await resp.json();
  console.log(`[consumer] provider responded ${resp.status}:`, body);

  return { dealId, txHash: tx.hash, storeStatus: resp.status, storeBody: body };
}

export async function closeDealCmd(
  dealIdArg?: bigint,
  cfg: Config = loadConfig()
): Promise<{ status: number; txHash: string }> {
  const dealId =
    dealIdArg ?? BigInt(process.argv[3] ?? (() => { throw new Error("dealId arg required"); })());

  const provider = new JsonRpcProvider(cfg.rpcUrl);
  const wallet = new Wallet(cfg.privateKey, provider);
  const storageDeal = StorageDeal__factory.connect(cfg.storageDealAddress, wallet);

  const before = await storageDeal.getDeal(dealId);
  console.log(
    `[consumer] dealId=${dealId} status(before)=${before.status} ` +
      `escrow=${formatEther(before.escrow)} ETH deadline=${before.deadline}`
  );

  const tx = await storageDeal.closeDeal(dealId);
  const receipt = await tx.wait();
  if (!receipt) throw new Error("no receipt");
  const after = await storageDeal.getDeal(dealId);
  const statusName = ["Active", "Completed", "Slashed"][Number(after.status)] ?? "?";
  console.log(`[consumer] dealId=${dealId} status(after)=${after.status} (${statusName}) tx=${tx.hash}`);
  return { status: Number(after.status), txHash: tx.hash };
}

export async function inspectCmd(cfg: Config = loadConfig()): Promise<void> {
  const dealId = BigInt(process.argv[3] ?? (() => { throw new Error("dealId arg required"); })());

  const provider = new JsonRpcProvider(cfg.rpcUrl);
  const storageDeal = StorageDeal__factory.connect(cfg.storageDealAddress, provider);
  const registry = ProviderRegistry__factory.connect(cfg.registryAddress, provider);

  const d = await storageDeal.getDeal(dealId);
  const statusName = ["Active", "Completed", "Slashed"][Number(d.status)] ?? "?";
  console.log(`Deal ${dealId}:`);
  console.log(`  consumer    : ${d.consumer}`);
  console.log(`  provider    : ${d.provider}`);
  console.log(`  merkleRoot  : ${d.merkleRoot}`);
  console.log(`  totalChunks : ${d.totalChunks}`);
  console.log(`  escrow      : ${formatEther(d.escrow)} ETH`);
  console.log(`  deadline    : ${d.deadline} (${new Date(Number(d.deadline) * 1000).toISOString()})`);
  console.log(`  status      : ${d.status} (${statusName})`);

  const p = await registry.getProvider(d.provider);
  console.log(`Provider ${d.provider}:`);
  console.log(`  capacityGB  : ${p.capacityGB}`);
  console.log(`  pricePerGB  : ${p.pricePerGB}`);
  console.log(`  stake       : ${formatEther(p.stake)} ETH`);
  console.log(`  active      : ${p.active}`);
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  switch (cmd) {
    case "create":
      await createDealCmd();
      return;
    case "close":
      await closeDealCmd();
      return;
    case "inspect":
      await inspectCmd();
      return;
    default:
      console.error(
        "Usage:\n" +
          "  consumer create --provider <addr> --provider-url <url> --file <path> [--escrow 0.1] [--duration 3600]\n" +
          "  consumer close <dealId>\n" +
          "  consumer inspect <dealId>\n"
      );
      process.exit(1);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
