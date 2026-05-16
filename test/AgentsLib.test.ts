import { expect } from "chai";
import { ethers } from "hardhat";
import { randomBytes } from "node:crypto";
import { buildMerkleTree, hashPair } from "../agents/lib/merkle";
import { chunkFile } from "../agents/lib/chunks";

// We pre-deploy a tiny verifier contract is overkill; instead we re-use
// StorageDeal's MerkleProof flow via a minimal harness: deploy + create deal
// + submitProof. If submitProof doesn't revert, the proof matches OZ's verify.

describe("agents/lib", () => {
  describe("merkle.buildMerkleTree", () => {
    it("single leaf is its own root and the proof is empty", () => {
      const leaves = [ethers.keccak256(ethers.toUtf8Bytes("only"))];
      const t = buildMerkleTree(leaves);
      expect(t.root).to.equal(leaves[0]);
      expect(t.getProof(0)).to.deep.equal([]);
    });

    it("4-leaf tree: proofs verify with sorted-pair hashing (OZ-compatible)", () => {
      const leaves = ["a", "b", "c", "d"].map((s) => ethers.keccak256(ethers.toUtf8Bytes(s)));
      const tree = buildMerkleTree(leaves);

      for (let i = 0; i < leaves.length; i++) {
        let computed = leaves[i];
        for (const sibling of tree.getProof(i)) {
          computed = hashPair(computed, sibling);
        }
        expect(computed).to.equal(tree.root);
      }
    });

    it("odd-sized layer duplicates the last node", () => {
      const leaves = ["a", "b", "c"].map((s) => ethers.keccak256(ethers.toUtf8Bytes(s)));
      const tree = buildMerkleTree(leaves);
      // leaf 2 is paired with itself at the first level
      let computed = leaves[2];
      for (const sibling of tree.getProof(2)) {
        computed = hashPair(computed, sibling);
      }
      expect(computed).to.equal(tree.root);
    });

    it("getProof rejects out-of-range index", () => {
      const leaves = [ethers.keccak256(ethers.toUtf8Bytes("x"))];
      const tree = buildMerkleTree(leaves);
      expect(() => tree.getProof(5)).to.throw(/out of range/);
    });
  });

  describe("chunks.chunkFile", () => {
    it("round-trips: concatenating chunks gives original buffer", () => {
      const data = randomBytes(4096 + 137); // not aligned to chunk size
      const f = chunkFile(data, 1024);
      expect(f.totalChunks).to.equal(5);
      const reconstructed = Buffer.concat(f.chunks);
      expect(reconstructed.equals(data)).to.equal(true);
    });

    it("leaves are keccak256 of each chunk", () => {
      const data = Buffer.from("hello world".repeat(200));
      const f = chunkFile(data, 256);
      for (let i = 0; i < f.totalChunks; i++) {
        expect(f.leaves[i]).to.equal(ethers.keccak256(f.chunks[i]));
      }
    });

    it("rejects empty input", () => {
      expect(() => chunkFile(Buffer.alloc(0))).to.throw(/empty/);
    });

    it("end-to-end with on-chain MerkleProof: chunkFile → submitProof passes", async () => {
      // Spin up the real contracts and verify chunkFile's tree is accepted by
      // StorageDeal.submitProof — which uses OpenZeppelin's MerkleProof.verify.
      const [_, provider, consumer] = await ethers.getSigners();
      const Registry = await ethers.getContractFactory("ProviderRegistry");
      const registry = await Registry.deploy();
      const StorageDeal = await ethers.getContractFactory("StorageDeal");
      const storageDeal = await StorageDeal.deploy(await registry.getAddress());
      await registry.setStorageDealContract(await storageDeal.getAddress());
      await registry
        .connect(provider)
        .registerProvider(1n, 1n, { value: ethers.parseEther("1") });

      const data = randomBytes(3000);
      const f = chunkFile(data, 512); // 6 chunks
      expect(f.totalChunks).to.equal(6);

      await storageDeal
        .connect(consumer)
        .createDeal(provider.address, f.tree.root, f.totalChunks, 3600n, {
          value: ethers.parseEther("0.01"),
        });

      for (let i = 0; i < f.totalChunks; i++) {
        await storageDeal
          .connect(provider)
          .submitProof(0n, i, f.tree.getProof(i), f.leaves[i]);
        expect(await storageDeal.isChunkVerified(0n, i)).to.equal(true);
      }
    });
  });
});
