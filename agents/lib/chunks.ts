import { keccak256 } from "ethers";
import { buildMerkleTree, type MerkleTree } from "./merkle";

export const DEFAULT_CHUNK_SIZE = 1024; // 1KB per chunk — small enough for tests

export type ChunkedFile = {
  chunks: Buffer[];
  leaves: string[];      // keccak256(chunk_i) — Merkle tree leaves
  tree: MerkleTree;
  totalChunks: number;
};

/**
 * Splits a file buffer into fixed-size chunks (last chunk may be shorter),
 * hashes each chunk into a leaf, and builds the Merkle tree.
 */
export function chunkFile(data: Buffer, chunkSize: number = DEFAULT_CHUNK_SIZE): ChunkedFile {
  if (data.length === 0) throw new Error("chunkFile: empty file");
  if (chunkSize <= 0) throw new Error("chunkFile: chunkSize must be > 0");

  const chunks: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    chunks.push(data.subarray(offset, Math.min(offset + chunkSize, data.length)));
  }

  const leaves = chunks.map((c) => keccak256(c));
  const tree = buildMerkleTree(leaves);
  return { chunks, leaves, tree, totalChunks: chunks.length };
}
