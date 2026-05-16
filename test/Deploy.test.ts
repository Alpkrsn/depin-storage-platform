import { expect } from "chai";
import { ignition, ethers } from "hardhat";
import DePIN from "../ignition/modules/DePIN";

describe("DePIN Ignition module", () => {
  it("deploys both contracts and wires registry → storageDeal", async () => {
    const { registry, storageDeal } = await ignition.deploy(DePIN);

    const registryAddr = await registry.getAddress();
    const storageDealAddr = await storageDeal.getAddress();

    // 1. StorageDeal points at the registry it was constructed with.
    expect(await storageDeal.registry()).to.equal(registryAddr);

    // 2. Registry knows about the storageDeal (the wired slash() caller).
    expect(await registry.storageDealContract()).to.equal(storageDealAddr);

    // 3. Deployer is the owner.
    const [deployer] = await ethers.getSigners();
    expect(await registry.owner()).to.equal(deployer.address);
  });
});
