import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("ProviderRegistry", () => {
  // Common fixture: deploy the registry. `dealStub` plays the role of the StorageDeal
  // contract so we can exercise slash() without actually deploying StorageDeal yet.
  async function deployRegistry() {
    const [owner, provider1, provider2, dealStub, consumer, stranger] =
      await ethers.getSigners();

    const Registry = await ethers.getContractFactory("ProviderRegistry");
    const registry = await Registry.deploy();
    await registry.waitForDeployment();

    return { registry, owner, provider1, provider2, dealStub, consumer, stranger };
  }

  describe("constructor", () => {
    it("sets deployer as owner", async () => {
      const { registry, owner } = await loadFixture(deployRegistry);
      expect(await registry.owner()).to.equal(owner.address);
    });

    it("starts with no providers and no storageDealContract", async () => {
      const { registry } = await loadFixture(deployRegistry);
      expect(await registry.getProviderCount()).to.equal(0n);
      expect(await registry.storageDealContract()).to.equal(ethers.ZeroAddress);
    });
  });

  describe("setStorageDealContract", () => {
    it("only the owner can set", async () => {
      const { registry, stranger, dealStub } = await loadFixture(deployRegistry);
      await expect(
        registry.connect(stranger).setStorageDealContract(dealStub.address)
      ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });

    it("reverts on zero address", async () => {
      const { registry } = await loadFixture(deployRegistry);
      await expect(
        registry.setStorageDealContract(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(registry, "ZeroAddress");
    });

    it("emits StorageDealContractSet and stores the address", async () => {
      const { registry, dealStub } = await loadFixture(deployRegistry);
      await expect(registry.setStorageDealContract(dealStub.address))
        .to.emit(registry, "StorageDealContractSet")
        .withArgs(dealStub.address);
      expect(await registry.storageDealContract()).to.equal(dealStub.address);
    });
  });

  describe("registerProvider", () => {
    it("happy path: stores data, emits event, adds to list", async () => {
      const { registry, provider1 } = await loadFixture(deployRegistry);
      const stake = ethers.parseEther("1");

      await expect(
        registry.connect(provider1).registerProvider(100n, 1000n, { value: stake })
      )
        .to.emit(registry, "ProviderRegistered")
        .withArgs(provider1.address, 100n, 1000n, stake);

      const p = await registry.getProvider(provider1.address);
      expect(p.capacityGB).to.equal(100n);
      expect(p.pricePerGB).to.equal(1000n);
      expect(p.stake).to.equal(stake);
      expect(p.active).to.equal(true);
      expect(p.exists).to.equal(true);

      expect(await registry.getProviderCount()).to.equal(1n);
    });

    it("reverts when msg.value is zero (StakeRequired)", async () => {
      const { registry, provider1 } = await loadFixture(deployRegistry);
      await expect(
        registry.connect(provider1).registerProvider(100n, 1000n, { value: 0n })
      ).to.be.revertedWithCustomError(registry, "StakeRequired");
    });

    it("reverts when already active (AlreadyActive)", async () => {
      const { registry, provider1 } = await loadFixture(deployRegistry);
      await registry
        .connect(provider1)
        .registerProvider(100n, 1000n, { value: ethers.parseEther("1") });

      await expect(
        registry
          .connect(provider1)
          .registerProvider(200n, 2000n, { value: ethers.parseEther("1") })
      ).to.be.revertedWithCustomError(registry, "AlreadyActive");
    });

    it("re-register after deactivate adds to existing stake and overwrites params", async () => {
      const { registry, provider1 } = await loadFixture(deployRegistry);
      await registry
        .connect(provider1)
        .registerProvider(100n, 1000n, { value: ethers.parseEther("1") });
      await registry.connect(provider1).deactivateProvider();

      await registry
        .connect(provider1)
        .registerProvider(500n, 9999n, { value: ethers.parseEther("2") });

      const p = await registry.getProvider(provider1.address);
      expect(p.capacityGB).to.equal(500n);
      expect(p.pricePerGB).to.equal(9999n);
      expect(p.stake).to.equal(ethers.parseEther("3"));
      expect(p.active).to.equal(true);

      // still one entry in providerList
      expect(await registry.getProviderCount()).to.equal(1n);
    });
  });

  describe("deactivateProvider", () => {
    it("happy path: flips active=false and emits event", async () => {
      const { registry, provider1 } = await loadFixture(deployRegistry);
      await registry
        .connect(provider1)
        .registerProvider(100n, 1000n, { value: ethers.parseEther("1") });

      await expect(registry.connect(provider1).deactivateProvider())
        .to.emit(registry, "ProviderDeactivated")
        .withArgs(provider1.address);

      const p = await registry.getProvider(provider1.address);
      expect(p.active).to.equal(false);
      expect(p.stake).to.equal(ethers.parseEther("1")); // stake stays locked
    });

    it("reverts when not active (NotActive)", async () => {
      const { registry, provider1 } = await loadFixture(deployRegistry);
      await expect(
        registry.connect(provider1).deactivateProvider()
      ).to.be.revertedWithCustomError(registry, "NotActive");
    });
  });

  describe("withdrawStake", () => {
    it("happy path: transfers stake, zeros it, emits", async () => {
      const { registry, provider1 } = await loadFixture(deployRegistry);
      const stake = ethers.parseEther("1");
      await registry
        .connect(provider1)
        .registerProvider(100n, 1000n, { value: stake });
      await registry.connect(provider1).deactivateProvider();

      // Two separate awaits because hardhat-chai-matchers v2 forbids chaining
      // async matchers like changeEtherBalances after emit (each runs the tx once).
      const tx = registry.connect(provider1).withdrawStake;
      await expect(tx()).to.changeEtherBalances(
        [provider1, registry],
        [stake, -stake]
      );

      // Re-stake + redeactivate so we can fire one more tx to assert the event.
      await registry
        .connect(provider1)
        .registerProvider(100n, 1000n, { value: stake });
      await registry.connect(provider1).deactivateProvider();
      await expect(registry.connect(provider1).withdrawStake())
        .to.emit(registry, "StakeWithdrawn")
        .withArgs(provider1.address, stake);

      const p = await registry.getProvider(provider1.address);
      expect(p.stake).to.equal(0n);
    });

    it("reverts while active (StakeLocked)", async () => {
      const { registry, provider1 } = await loadFixture(deployRegistry);
      await registry
        .connect(provider1)
        .registerProvider(100n, 1000n, { value: ethers.parseEther("1") });

      await expect(
        registry.connect(provider1).withdrawStake()
      ).to.be.revertedWithCustomError(registry, "StakeLocked");
    });

    it("reverts when never registered (ProviderNotFound)", async () => {
      const { registry, stranger } = await loadFixture(deployRegistry);
      await expect(
        registry.connect(stranger).withdrawStake()
      ).to.be.revertedWithCustomError(registry, "ProviderNotFound");
    });

    it("reverts when stake already zero (NothingToWithdraw)", async () => {
      const { registry, provider1 } = await loadFixture(deployRegistry);
      await registry
        .connect(provider1)
        .registerProvider(100n, 1000n, { value: ethers.parseEther("1") });
      await registry.connect(provider1).deactivateProvider();
      await registry.connect(provider1).withdrawStake();

      await expect(
        registry.connect(provider1).withdrawStake()
      ).to.be.revertedWithCustomError(registry, "NothingToWithdraw");
    });
  });

  describe("slash", () => {
    async function deployAndWire() {
      const fixt = await loadFixture(deployRegistry);
      await fixt.registry.setStorageDealContract(fixt.dealStub.address);
      const stake = ethers.parseEther("2");
      await fixt.registry
        .connect(fixt.provider1)
        .registerProvider(100n, 1000n, { value: stake });
      return { ...fixt, stake };
    }

    it("reverts when called by non-StorageDeal caller (NotAuthorized)", async () => {
      const { registry, stranger, provider1, consumer } = await deployAndWire();
      await expect(
        registry
          .connect(stranger)
          .slash(provider1.address, ethers.parseEther("1"), consumer.address)
      ).to.be.revertedWithCustomError(registry, "NotAuthorized");
    });

    it("reverts on zero beneficiary (ZeroAddress)", async () => {
      const { registry, dealStub, provider1 } = await deployAndWire();
      await expect(
        registry
          .connect(dealStub)
          .slash(provider1.address, ethers.parseEther("1"), ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(registry, "ZeroAddress");
    });

    it("reverts when provider unknown (ProviderNotFound)", async () => {
      const { registry, dealStub, stranger, consumer } = await deployAndWire();
      await expect(
        registry
          .connect(dealStub)
          .slash(stranger.address, ethers.parseEther("1"), consumer.address)
      ).to.be.revertedWithCustomError(registry, "ProviderNotFound");
    });

    it("happy path: reduces stake, sends ETH to beneficiary, emits", async () => {
      const { registry, dealStub, provider1, consumer, stake } = await deployAndWire();
      const amount = ethers.parseEther("0.5");

      // First call asserts balance shift, second call asserts event — chai-matchers v2
      // forbids chaining async matchers (each one re-runs the transaction).
      await expect(
        registry.connect(dealStub).slash(provider1.address, amount, consumer.address)
      ).to.changeEtherBalances([consumer, registry], [amount, -amount]);

      await expect(
        registry.connect(dealStub).slash(provider1.address, amount, consumer.address)
      )
        .to.emit(registry, "ProviderSlashed")
        .withArgs(provider1.address, amount, consumer.address);

      const p = await registry.getProvider(provider1.address);
      expect(p.stake).to.equal(stake - amount * 2n);
    });

    it("caps slash amount at remaining stake", async () => {
      const { registry, dealStub, provider1, consumer, stake } = await deployAndWire();
      const overlyLarge = stake * 10n;

      await expect(
        registry
          .connect(dealStub)
          .slash(provider1.address, overlyLarge, consumer.address)
      )
        .to.emit(registry, "ProviderSlashed")
        .withArgs(provider1.address, stake, consumer.address);

      const p = await registry.getProvider(provider1.address);
      expect(p.stake).to.equal(0n);
    });
  });

  describe("getActiveProviders", () => {
    it("returns only active providers", async () => {
      const { registry, provider1, provider2 } = await loadFixture(deployRegistry);

      await registry
        .connect(provider1)
        .registerProvider(100n, 1000n, { value: ethers.parseEther("1") });
      await registry
        .connect(provider2)
        .registerProvider(200n, 2000n, { value: ethers.parseEther("1") });
      await registry.connect(provider1).deactivateProvider();

      const active = await registry.getActiveProviders();
      expect(active).to.deep.equal([provider2.address]);
      expect(await registry.getProviderCount()).to.equal(2n);
    });

    it("returns empty array when nothing registered", async () => {
      const { registry } = await loadFixture(deployRegistry);
      expect(await registry.getActiveProviders()).to.deep.equal([]);
    });
  });
});
