// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {StorageDeal} from "../StorageDeal.sol";

/// @title MaliciousConsumer
/// @notice Test-only attacker contract. Acts as a consumer that re-enters
///         `closeDeal` from its receive() callback when StorageDeal refunds
///         escrow on the slash path. Used by Adversarial.test.ts to prove
///         that ReentrancyGuard (and CEI ordering) actually block re-entry.
/// @dev Only deployed by tests. Never wire this into production.
contract MaliciousConsumer {
    StorageDeal public immutable storageDeal;
    uint256 public targetDealId;
    uint256 public reentryAttempts;
    bool public reentrySucceeded;

    constructor(address _storageDeal) {
        storageDeal = StorageDeal(_storageDeal);
    }

    function makeDeal(
        address provider,
        bytes32 root,
        uint32 totalChunks,
        uint64 duration
    ) external payable returns (uint256 dealId) {
        return storageDeal.createDeal{value: msg.value}(provider, root, totalChunks, duration);
    }

    function attack(uint256 dealId) external {
        targetDealId = dealId;
        storageDeal.closeDeal(dealId);
    }

    receive() external payable {
        // We're being refunded — try to re-enter while the original close
        // is still on the stack. Swallow the revert so the outer call can
        // complete cleanly; the test asserts that reentrySucceeded stays false.
        if (targetDealId != 0 || reentryAttempts == 0) {
            reentryAttempts++;
            try storageDeal.closeDeal(targetDealId) {
                reentrySucceeded = true;
            } catch {
                // expected — ReentrancyGuard or DealNotActive should fire
            }
        }
    }
}
