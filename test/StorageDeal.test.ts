import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

// ---------- minimal Merkle tree (matches OpenZeppelin MerkleProof) ----------
// OZ MerkleProof.verify uses sorted-pair keccak256 hashing:
//   parent = keccak256(concat(min(a,b), max(a,b)))
// We mirror that exactly so proofs generated here verify on-chain.

function hashPair(a: string, b: string): string {
  const [first, second] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  return ethers.keccak256(ethers.concat([first, second]));
}

function buildMerkleTree(leaves: string[]): {
  root: string;
  getProof: (index: number) => string[];
} {
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

// helper: 4 leaves derived from chunk indices
function makeLeaves(count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    ethers.keccak256(ethers.toUtf8Bytes(`chunk-${i}`))
  );
}

describe("StorageDeal", () => {
  async function deployAll() {
    const [owner, provider, consumer, other] = await ethers.getSigners();

    const Registry = await ethers.getContractFactory("ProviderRegistry");
    const registry = await Registry.deploy();
    await registry.waitForDeployment();

    const StorageDeal = await ethers.getContractFactory("StorageDeal");
    const storageDeal = await StorageDeal.deploy(await registry.getAddress());
    await storageDeal.waitForDeployment();

    // Wire registry → storageDeal so slash() is callable from StorageDeal.
    await registry.setStorageDealContract(await storageDeal.getAddress());

    // Register the provider with 2 ETH stake.
    const stake = ethers.parseEther("2");
    await registry
      .connect(provider)
      .registerProvider(1000n, 100n, { value: stake });

    return { registry, storageDeal, owner, provider, consumer, other, stake };
  }

  describe("constructor", () => {
    it("reverts on zero registry address", async () => {
      const StorageDeal = await ethers.getContractFactory("StorageDeal");
      await expect(
        StorageDeal.deploy(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(StorageDeal, "ZeroAddress");
    });

    it("stores registry reference", async () => {
      const { storageDeal, registry } = await loadFixture(deployAll);
      expect(await storageDeal.registry()).to.equal(await registry.getAddress());
      expect(await storageDeal.getNextDealId()).to.equal(0n);
    });
  });

  describe("createDeal", () => {
    const totalChunks = 4;
    const duration = 3600n; // 1 hour

    it("happy path: stores deal, emits event, increments dealId", async () => {
      const { storageDeal, provider, consumer } = await loadFixture(deployAll);
      const leaves = makeLeaves(totalChunks);
      const { root } = buildMerkleTree(leaves);
      const escrow = ethers.parseEther("0.5");

      const tx = await storageDeal
        .connect(consumer)
        .createDeal(provider.address, root, totalChunks, duration, { value: escrow });
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);
      const expectedDeadline = BigInt(block!.timestamp) + duration;

      await expect(tx)
        .to.emit(storageDeal, "DealCreated")
        .withArgs(
          0n,
          consumer.address,
          provider.address,
          root,
          BigInt(totalChunks),
          escrow,
          expectedDeadline
        );

      const deal = await storageDeal.getDeal(0n);
      expect(deal.consumer).to.equal(consumer.address);
      expect(deal.provider).to.equal(provider.address);
      expect(deal.merkleRoot).to.equal(root);
      expect(deal.totalChunks).to.equal(BigInt(totalChunks));
      expect(deal.escrow).to.equal(escrow);
      expect(deal.status).to.equal(0n); // Active
      expect(deal.deadline).to.equal(expectedDeadline);

      expect(await storageDeal.getNextDealId()).to.equal(1n);
    });

    it("reverts on zero escrow (ZeroEscrow)", async () => {
      const { storageDeal, provider, consumer } = await loadFixture(deployAll);
      const { root } = buildMerkleTree(makeLeaves(totalChunks));
      await expect(
        storageDeal
          .connect(consumer)
          .createDeal(provider.address, root, totalChunks, duration, { value: 0n })
      ).to.be.revertedWithCustomError(storageDeal, "ZeroEscrow");
    });

    it("reverts on totalChunks == 0 (TotalChunksZero)", async () => {
      const { storageDeal, provider, consumer } = await loadFixture(deployAll);
      const { root } = buildMerkleTree(makeLeaves(totalChunks));
      await expect(
        storageDeal
          .connect(consumer)
          .createDeal(provider.address, root, 0, duration, {
            value: ethers.parseEther("0.1"),
          })
      ).to.be.revertedWithCustomError(storageDeal, "TotalChunksZero");
    });

    it("reverts on duration == 0 (DurationZero)", async () => {
      const { storageDeal, provider, consumer } = await loadFixture(deployAll);
      const { root } = buildMerkleTree(makeLeaves(totalChunks));
      await expect(
        storageDeal
          .connect(consumer)
          .createDeal(provider.address, root, totalChunks, 0n, {
            value: ethers.parseEther("0.1"),
          })
      ).to.be.revertedWithCustomError(storageDeal, "DurationZero");
    });

    it("reverts when provider is not active (InvalidProvider)", async () => {
      const { storageDeal, other, consumer } = await loadFixture(deployAll);
      const { root } = buildMerkleTree(makeLeaves(totalChunks));
      await expect(
        storageDeal
          .connect(consumer)
          .createDeal(other.address, root, totalChunks, duration, {
            value: ethers.parseEther("0.1"),
          })
      ).to.be.revertedWithCustomError(storageDeal, "InvalidProvider");
    });
  });

  describe("submitProof", () => {
    const totalChunks = 4;
    const duration = 3600n;

    async function dealFixture() {
      const fixt = await loadFixture(deployAll);
      const leaves = makeLeaves(totalChunks);
      const tree = buildMerkleTree(leaves);
      const tx = await fixt.storageDeal
        .connect(fixt.consumer)
        .createDeal(fixt.provider.address, tree.root, totalChunks, duration, {
          value: ethers.parseEther("0.5"),
        });
      await tx.wait();
      return { ...fixt, leaves, tree, dealId: 0n };
    }

    it("happy path: verifies, marks chunk, emits", async () => {
      const { storageDeal, provider, leaves, tree, dealId } = await dealFixture();
      const proof = tree.getProof(2);
      await expect(storageDeal.connect(provider).submitProof(dealId, 2, proof, leaves[2]))
        .to.emit(storageDeal, "ProofSubmitted")
        .withArgs(dealId, 2n, leaves[2]);
      expect(await storageDeal.isChunkVerified(dealId, 2)).to.equal(true);
      expect(await storageDeal.isChunkVerified(dealId, 0)).to.equal(false);
    });

    it("reverts when caller is not provider (NotProvider)", async () => {
      const { storageDeal, consumer, leaves, tree, dealId } = await dealFixture();
      const proof = tree.getProof(0);
      await expect(
        storageDeal.connect(consumer).submitProof(dealId, 0, proof, leaves[0])
      ).to.be.revertedWithCustomError(storageDeal, "NotProvider");
    });

    it("reverts on out-of-range chunkIndex (InvalidChunkIndex)", async () => {
      const { storageDeal, provider, leaves, tree, dealId } = await dealFixture();
      const proof = tree.getProof(0);
      await expect(
        storageDeal.connect(provider).submitProof(dealId, 99, proof, leaves[0])
      ).to.be.revertedWithCustomError(storageDeal, "InvalidChunkIndex");
    });

    it("reverts on bad proof (InvalidMerkleProof)", async () => {
      const { storageDeal, provider, leaves, tree, dealId } = await dealFixture();
      const wrongProof = tree.getProof(1); // proof for chunk 1, but we claim leaf 0
      await expect(
        storageDeal.connect(provider).submitProof(dealId, 0, wrongProof, leaves[0])
      ).to.be.revertedWithCustomError(storageDeal, "InvalidMerkleProof");
    });

    it("reverts when deal is not active (DealNotActive)", async () => {
      const { storageDeal, provider, consumer, leaves, tree, dealId } =
        await dealFixture();

      // Submit proofs for every chunk so closeDeal succeeds deterministically.
      for (let i = 0; i < totalChunks; i++) {
        await storageDeal
          .connect(provider)
          .submitProof(dealId, i, tree.getProof(i), leaves[i]);
      }
      await time.increase(Number(duration) + 1);
      await storageDeal.connect(consumer).closeDeal(dealId);

      const proof = tree.getProof(0);
      await expect(
        storageDeal.connect(provider).submitProof(dealId, 0, proof, leaves[0])
      ).to.be.revertedWithCustomError(storageDeal, "DealNotActive");
    });
  });

  describe("closeDeal", () => {
    const totalChunks = 4;
    const duration = 3600n;

    async function dealFixture() {
      const fixt = await loadFixture(deployAll);
      const leaves = makeLeaves(totalChunks);
      const tree = buildMerkleTree(leaves);
      const escrow = ethers.parseEther("0.5");
      await fixt.storageDeal
        .connect(fixt.consumer)
        .createDeal(fixt.provider.address, tree.root, totalChunks, duration, {
          value: escrow,
        });
      return { ...fixt, leaves, tree, dealId: 0n, escrow };
    }

    it("reverts before deadline (DeadlineNotReached)", async () => {
      const { storageDeal, consumer, dealId } = await dealFixture();
      await expect(
        storageDeal.connect(consumer).closeDeal(dealId)
      ).to.be.revertedWithCustomError(storageDeal, "DeadlineNotReached");
    });

    it("happy path success: proofs submitted for all chunks → escrow → provider", async () => {
      const { storageDeal, provider, consumer, leaves, tree, dealId, escrow } =
        await dealFixture();

      for (let i = 0; i < totalChunks; i++) {
        await storageDeal
          .connect(provider)
          .submitProof(dealId, i, tree.getProof(i), leaves[i]);
      }
      await time.increase(Number(duration) + 1);

      // Balance change assertion (must be its own await — cannot chain async matchers).
      await expect(
        storageDeal.connect(consumer).closeDeal(dealId)
      ).to.changeEtherBalances(
        [provider, storageDeal],
        [escrow, -escrow]
      );

      const deal = await storageDeal.getDeal(dealId);
      expect(deal.status).to.equal(1n); // Completed
    });

    it("happy path slash: no proofs → consumer refund + provider slash", async () => {
      const { storageDeal, registry, provider, consumer, dealId, escrow, stake } =
        await dealFixture();

      await time.increase(Number(duration) + 1);

      // 1) Balance assertion: consumer gets escrow refund + slash payout (= 2x escrow);
      //    storageDeal loses escrow; registry loses slashed amount (= escrow).
      await expect(
        storageDeal.connect(consumer).closeDeal(dealId)
      ).to.changeEtherBalances(
        [consumer, storageDeal, registry],
        [escrow * 2n, -escrow, -escrow]
      );

      // State assertions
      const deal = await storageDeal.getDeal(dealId);
      expect(deal.status).to.equal(2n); // Slashed
      const p = await registry.getProvider(provider.address);
      expect(p.stake).to.equal(stake - escrow);
    });

    it("reverts when called twice (DealNotActive)", async () => {
      const { storageDeal, consumer, dealId } = await dealFixture();
      await time.increase(Number(duration) + 1);
      await storageDeal.connect(consumer).closeDeal(dealId);
      await expect(
        storageDeal.connect(consumer).closeDeal(dealId)
      ).to.be.revertedWithCustomError(storageDeal, "DealNotActive");
    });
  });
});
