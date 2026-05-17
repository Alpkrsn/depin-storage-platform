import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { buildMerkleTree } from "../agents/lib/merkle";
import { chunkFile } from "../agents/lib/chunks";
import { randomBytes } from "node:crypto";

// Adversarial / security tests aligned with proposal §2.4 + §4.2.
// Each suite maps to one attack class in the proposal's threat model.

describe("Adversarial scenarios", () => {
  async function deploy() {
    const signers = await ethers.getSigners();
    const Registry = await ethers.getContractFactory("ProviderRegistry");
    const registry = await Registry.deploy();
    const StorageDeal = await ethers.getContractFactory("StorageDeal");
    const storageDeal = await StorageDeal.deploy(await registry.getAddress());
    await registry.setStorageDealContract(await storageDeal.getAddress());
    return { registry, storageDeal, signers };
  }

  // ---------- §2.4.1 Sybil attack ----------
  describe("Sybil resistance (proposal §2.4.1)", () => {
    it("N fake providers require N independent stakes (economic deterrence)", async () => {
      const { registry, signers } = await loadFixture(deploy);
      const stakePerIdentity = ethers.parseEther("1");
      const N = 5;

      const totalSpent = stakePerIdentity * BigInt(N);

      // Each identity requires its own deposit — there is no shared / discounted
      // pool. We register N distinct signers and assert the registry holds N*stake.
      for (let i = 1; i <= N; i++) {
        await registry
          .connect(signers[i])
          .registerProvider(100n, 10n, { value: stakePerIdentity });
      }

      const registryBalance = await ethers.provider.getBalance(await registry.getAddress());
      expect(registryBalance).to.equal(totalSpent);
      expect((await registry.getActiveProviders()).length).to.equal(N);

      // The reverse — trying to re-register the SAME identity twice — is rejected,
      // so an attacker cannot inflate active-provider count from one stake.
      await expect(
        registry.connect(signers[1]).registerProvider(200n, 20n, { value: stakePerIdentity })
      ).to.be.revertedWithCustomError(registry, "AlreadyActive");
    });

    it("registration with zero stake is rejected (StakeRequired)", async () => {
      // A Sybil attacker who tries to bypass the cost by sending 0 wei must fail.
      const { registry, signers } = await loadFixture(deploy);
      await expect(
        registry.connect(signers[1]).registerProvider(100n, 10n, { value: 0n })
      ).to.be.revertedWithCustomError(registry, "StakeRequired");
    });
  });

  // ---------- §2.4.2 Lazy provider / free-riding ----------
  describe("Lazy provider (proposal §2.4.2)", () => {
    it("provider submitting invalid proof is rejected (no payment, no attestation)", async () => {
      const { registry, storageDeal, signers } = await loadFixture(deploy);
      const [, provider, consumer] = signers;
      await registry
        .connect(provider)
        .registerProvider(1000n, 100n, { value: ethers.parseEther("1") });

      const data = randomBytes(2048);
      const f = chunkFile(data, 512); // 4 chunks
      await storageDeal
        .connect(consumer)
        .createDeal(provider.address, f.tree.root, f.totalChunks, 60n, {
          value: ethers.parseEther("0.05"),
        });

      // Forge a leaf that doesn't match any real chunk and try to attest it.
      const fakeLeaf = ethers.keccak256(ethers.toUtf8Bytes("not-a-real-chunk"));
      await expect(
        storageDeal.connect(provider).submitProof(0n, 0, f.tree.getProof(0), fakeLeaf)
      ).to.be.revertedWithCustomError(storageDeal, "InvalidMerkleProof");

      expect(await storageDeal.isChunkVerified(0n, 0)).to.equal(false);
    });

    it("provider that never submits proofs is slashed AND consumer is refunded", async () => {
      // Full end-to-end of the lazy-provider attack: provider goes silent,
      // anyone closes the deal after the deadline, ReentrancyGuard-safe
      // double payout to the consumer (escrow refund + slash payout).
      const { registry, storageDeal, signers } = await loadFixture(deploy);
      const [, provider, consumer] = signers;
      const stake = ethers.parseEther("1");
      await registry.connect(provider).registerProvider(1000n, 100n, { value: stake });

      const data = randomBytes(1024);
      const f = chunkFile(data, 512);
      const escrow = ethers.parseEther("0.05");
      await storageDeal
        .connect(consumer)
        .createDeal(provider.address, f.tree.root, f.totalChunks, 60n, {
          value: escrow,
        });

      await time.increase(61);

      await expect(
        storageDeal.connect(consumer).closeDeal(0n)
      ).to.changeEtherBalances(
        [consumer, storageDeal, registry],
        [escrow * 2n, -escrow, -escrow]
      );

      const p = await registry.getProvider(provider.address);
      expect(p.stake).to.equal(stake - escrow);
      const deal = await storageDeal.getDeal(0n);
      expect(deal.status).to.equal(2n); // Slashed
    });
  });

  // ---------- §2.4.3 Consumer fraud (unjustified objection) ----------
  describe("Consumer fraud (proposal §2.4.3)", () => {
    it("consumer cannot block payment if provider submitted valid proofs", async () => {
      // Even though the consumer is the one calling closeDeal, settlement is
      // driven by the on-chain Merkle attestations, not by consumer consent.
      const { registry, storageDeal, signers } = await loadFixture(deploy);
      const [, provider, consumer] = signers;
      await registry
        .connect(provider)
        .registerProvider(1000n, 100n, { value: ethers.parseEther("1") });

      const data = randomBytes(2048);
      const f = chunkFile(data, 512); // 4 chunks
      const escrow = ethers.parseEther("0.05");
      await storageDeal
        .connect(consumer)
        .createDeal(provider.address, f.tree.root, f.totalChunks, 60n, { value: escrow });

      for (let i = 0; i < f.totalChunks; i++) {
        await storageDeal
          .connect(provider)
          .submitProof(0n, i, f.tree.getProof(i), f.leaves[i]);
      }

      await time.increase(61);

      // Consumer (the one with the financial motive to lie) calls closeDeal.
      // Settlement still pays the provider because every chunk is attested.
      await expect(
        storageDeal.connect(consumer).closeDeal(0n)
      ).to.changeEtherBalances([provider, storageDeal], [escrow, -escrow]);

      const deal = await storageDeal.getDeal(0n);
      expect(deal.status).to.equal(1n); // Completed
    });
  });

  // ---------- §2.4.4 Reentrancy ----------
  describe("Reentrancy (proposal §2.4.4)", () => {
    it("malicious consumer cannot re-enter closeDeal during refund", async () => {
      // Deploy MaliciousConsumer as the consumer. On the slash path, refund ETH
      // hits its receive() — which tries to call closeDeal again. Combined
      // defences (ReentrancyGuard + status-set-before-transfer / CEI) must
      // ensure the second call cannot complete settlement.
      const { registry, storageDeal, signers } = await loadFixture(deploy);
      const [funder, provider] = signers;

      await registry
        .connect(provider)
        .registerProvider(1000n, 100n, { value: ethers.parseEther("1") });

      const Mal = await ethers.getContractFactory("MaliciousConsumer");
      const mal = await Mal.deploy(await storageDeal.getAddress());
      await mal.waitForDeployment();

      // Fund the attacker with enough ETH to make a deal.
      const escrow = ethers.parseEther("0.05");
      await funder.sendTransaction({ to: await mal.getAddress(), value: escrow });

      const data = randomBytes(1024);
      const f = chunkFile(data, 512);
      await mal.makeDeal(provider.address, f.tree.root, f.totalChunks, 60n, { value: escrow });

      // Provider goes silent → slash path will refund the consumer (the attacker).
      await time.increase(61);
      await mal.attack(0n);

      // Re-entry was attempted but blocked.
      expect(await mal.reentryAttempts()).to.be.greaterThan(0n);
      expect(await mal.reentrySucceeded()).to.equal(false);

      // Deal still settled cleanly into Slashed, exactly once.
      const deal = await storageDeal.getDeal(0n);
      expect(deal.status).to.equal(2n); // Slashed
    });
  });
});
