import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * Deploys the two-contract DePIN storage platform and wires the registry → storageDeal
 * link in one transaction graph. Ignition orders the steps by data dependency:
 *
 *   1. ProviderRegistry()                                  — no deps
 *   2. StorageDeal(registry.address)                       — depends on (1)
 *   3. registry.setStorageDealContract(storageDeal.address)— depends on (1) + (2)
 *
 * The deployer becomes the registry owner (constructor uses msg.sender), so the
 * setStorageDealContract call in step 3 will be authorised by the same key.
 */
export default buildModule("DePIN", (m) => {
  const registry = m.contract("ProviderRegistry");
  const storageDeal = m.contract("StorageDeal", [registry]);

  m.call(registry, "setStorageDealContract", [storageDeal]);

  return { registry, storageDeal };
});
