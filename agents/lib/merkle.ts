import { keccak256, concat } from "ethers";

/**
 * Hash a pair the same way OpenZeppelin's MerkleProof does:
 *   parent = keccak256(concat(min(a, b), max(a, b)))
 *
 * Sorting before hashing is what lets the verifier reconstruct the root from
 * just the sibling hashes (no left/right flag per level).
 */
export function hashPair(a: string, b: string): string {
  const [first, second] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  return keccak256(concat([first, second]));
}

export type MerkleTree = {
  root: string;
  getProof: (index: number) => string[];
};

/**
 * Build a Merkle tree over the given leaves. Compatible with
 * `MerkleProof.verify(proof, root, leaf)` on the chain side.
 * Odd-sized layers duplicate the last node (a common convention).
 */
export function buildMerkleTree(leaves: string[]): MerkleTree {
  if (leaves.length === 0) {
    throw new Error("buildMerkleTree: leaves must be non-empty");
  }
  const layers: string[][] = [leaves.slice()];
  let current = leaves.slice();
  while (current.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i];
      const right = i + 1 < current.length ? current[i + 1] : current[i];
      next.push(hashPair(left, right));
    }
    layers.push(next);
    current = next;
  }
  const root = current[0];

  function getProof(index: number): string[] {
    if (index < 0 || index >= leaves.length) {
      throw new Error(`getProof: index ${index} out of range`);
    }
    const proof: string[] = [];
    let idx = index;
    for (let level = 0; level < layers.length - 1; level++) {
      const layer = layers[level];
      const isRight = idx % 2 === 1;
      const siblingIdx = isRight ? idx - 1 : idx + 1;
      const sibling = siblingIdx < layer.length ? layer[siblingIdx] : layer[idx];
      proof.push(sibling);
      idx = Math.floor(idx / 2);
    }
    return proof;
  }

  return { root, getProof };
}
