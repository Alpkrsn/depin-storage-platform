// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title ProviderRegistry
/// @notice Tracks storage providers, their advertised capacity/price, and their staked collateral.
/// @dev Stake is locked while a provider is active. Only an authorised StorageDeal contract may slash.
contract ProviderRegistry is ReentrancyGuard, Ownable {
    struct Provider {
        uint256 capacityGB;
        uint256 pricePerGB; // wei per GB (per deal, not per time-unit — kept simple for the prototype)
        uint256 stake;      // wei
        bool active;
        bool exists;        // distinguishes "never registered" from "deactivated"
    }

    mapping(address => Provider) private providers;
    address[] private providerList;

    /// @notice Address of the StorageDeal contract authorised to call slash().
    address public storageDealContract;

    event ProviderRegistered(
        address indexed provider,
        uint256 capacityGB,
        uint256 pricePerGB,
        uint256 stake
    );
    event ProviderDeactivated(address indexed provider);
    event StakeWithdrawn(address indexed provider, uint256 amount);
    event ProviderSlashed(address indexed provider, uint256 amount, address indexed beneficiary);
    event StorageDealContractSet(address indexed storageDealContract);

    error StakeRequired();
    error AlreadyActive();
    error NotActive();
    error ProviderNotFound();
    error StakeLocked();
    error NothingToWithdraw();
    error NotAuthorized();
    error ZeroAddress();
    error TransferFailed();

    constructor() Ownable(msg.sender) {}

    /// @notice One-shot wiring: the deployer points the registry at the StorageDeal contract.
    /// @dev Required because StorageDeal cannot exist at registry deploy time (circular dependency).
    function setStorageDealContract(address dealContract) external onlyOwner {
        if (dealContract == address(0)) revert ZeroAddress();
        storageDealContract = dealContract;
        emit StorageDealContractSet(dealContract);
    }

    /// @notice Register (or re-activate) the caller as a provider. msg.value is added to stake.
    /// @param capacityGB Advertised disk space in GB.
    /// @param pricePerGB Quoted wei per GB.
    function registerProvider(uint256 capacityGB, uint256 pricePerGB)
        external
        payable
        nonReentrant
    {
        if (msg.value == 0) revert StakeRequired();
        Provider storage p = providers[msg.sender];
        if (p.active) revert AlreadyActive();

        if (!p.exists) {
            providerList.push(msg.sender);
            p.exists = true;
        }

        p.capacityGB = capacityGB;
        p.pricePerGB = pricePerGB;
        p.stake += msg.value;
        p.active = true;

        emit ProviderRegistered(msg.sender, capacityGB, pricePerGB, p.stake);
    }

    /// @notice Mark caller inactive. Stake stays locked until withdrawStake() is called.
    function deactivateProvider() external {
        Provider storage p = providers[msg.sender];
        if (!p.active) revert NotActive();
        p.active = false;
        emit ProviderDeactivated(msg.sender);
    }

    /// @notice Withdraw the remaining stake. Only allowed when the provider is inactive.
    function withdrawStake() external nonReentrant {
        Provider storage p = providers[msg.sender];
        if (!p.exists) revert ProviderNotFound();
        if (p.active) revert StakeLocked();
        uint256 amount = p.stake;
        if (amount == 0) revert NothingToWithdraw();

        p.stake = 0;
        // slither-disable-next-line low-level-calls — standard ETH transfer; status checked below.
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit StakeWithdrawn(msg.sender, amount);
    }

    /// @notice Reduce a provider's stake (failed proof-of-storage). Forwarded to `beneficiary`.
    /// @dev Only callable by the wired StorageDeal contract. Caps `amount` at the remaining stake.
    function slash(address provider, uint256 amount, address beneficiary)
        external
        nonReentrant
    {
        if (msg.sender != storageDealContract) revert NotAuthorized();
        if (beneficiary == address(0)) revert ZeroAddress();
        Provider storage p = providers[provider];
        if (!p.exists) revert ProviderNotFound();

        uint256 slashed = amount > p.stake ? p.stake : amount;
        if (slashed == 0) return; // nothing to do, no event spam

        p.stake -= slashed;
        // slither-disable-next-line low-level-calls — standard ETH transfer; status checked below.
        (bool ok, ) = beneficiary.call{value: slashed}("");
        if (!ok) revert TransferFailed();
        emit ProviderSlashed(provider, slashed, beneficiary);
    }

    // ---------- views ----------

    function getProvider(address provider) external view returns (Provider memory) {
        return providers[provider];
    }

    /// @notice Returns addresses of all currently-active providers.
    /// @dev O(n) over every provider that has ever registered. Fine for the prototype scale.
    function getActiveProviders() external view returns (address[] memory) {
        uint256 total = providerList.length;
        uint256 count = 0;
        for (uint256 i = 0; i < total; ++i) {
            if (providers[providerList[i]].active) ++count;
        }

        address[] memory active = new address[](count);
        uint256 j = 0;
        for (uint256 i = 0; i < total; ++i) {
            address a = providerList[i];
            if (providers[a].active) {
                active[j] = a;
                ++j;
            }
        }
        return active;
    }

    function getProviderCount() external view returns (uint256) {
        return providerList.length;
    }
}
