// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ProviderRegistry} from "./ProviderRegistry.sol";

/// @title StorageDeal
/// @notice Escrowed storage deals between a consumer and a registered provider, settled by a
///         single Merkle proof-of-storage challenge after the deadline.
/// @dev Prototype: the challenge index is derived from `block.prevrandao`, which is predictable
///      one block in advance. Production would use a VRF (acknowledged as future work in the
///      project report). A provider can defeat the challenge by submitting proofs for every
///      chunk — gas cost is the only deterrent at this scale.
contract StorageDeal is ReentrancyGuard {
    enum Status {
        Active,
        Completed,
        Slashed
    }

    struct Deal {
        // slot 0 — consumer (20) + deadline (8) + totalChunks (4) = 32
        address consumer;
        uint64 deadline;
        uint32 totalChunks;
        // slot 1 — provider (20) + escrow (11) + status (1) = 32
        address provider;
        uint88 escrow; // wei. uint88 max ≈ 3.1e26 wei ≈ 309 ETH — plenty for a prototype
        Status status;
        // slot 2
        bytes32 merkleRoot;
    }

    ProviderRegistry public immutable registry;

    uint256 private nextDealId;
    mapping(uint256 => Deal) private deals;
    // dealId -> chunkIndex -> attested?
    mapping(uint256 => mapping(uint256 => bool)) private verifiedChunks;

    event DealCreated(
        uint256 indexed dealId,
        address indexed consumer,
        address indexed provider,
        bytes32 merkleRoot,
        uint256 totalChunks,
        uint256 escrow,
        uint256 deadline
    );
    event ProofSubmitted(uint256 indexed dealId, uint256 chunkIndex, bytes32 leaf);
    event DealCompleted(uint256 indexed dealId, uint256 challengeIndex, uint256 paidToProvider);
    event DealSlashed(
        uint256 indexed dealId,
        uint256 challengeIndex,
        uint256 refundedToConsumer,
        uint256 slashRequested
    );

    error InvalidProvider();
    error ZeroEscrow();
    error EscrowOverflow();
    error TotalChunksZero();
    error DurationZero();
    error DealNotActive();
    error NotProvider();
    error InvalidChunkIndex();
    error InvalidMerkleProof();
    error DeadlineNotReached();
    error TransferFailed();
    error ZeroAddress();

    constructor(address registryAddr) {
        if (registryAddr == address(0)) revert ZeroAddress();
        registry = ProviderRegistry(registryAddr);
    }

    /// @notice Consumer locks ETH in escrow for a new deal with the given provider.
    /// @param provider     Active, registered provider address.
    /// @param merkleRoot   Root of the Merkle tree over the file's chunks.
    /// @param totalChunks  Number of leaves in the Merkle tree (challenge index range).
    /// @param duration     Deal lifetime in seconds.
    function createDeal(
        address provider,
        bytes32 merkleRoot,
        uint32 totalChunks,
        uint64 duration
    ) external payable nonReentrant returns (uint256 dealId) {
        if (msg.value == 0) revert ZeroEscrow();
        if (msg.value > type(uint88).max) revert EscrowOverflow();
        if (totalChunks == 0) revert TotalChunksZero();
        if (duration == 0) revert DurationZero();

        // Provider must currently be active in the registry.
        ProviderRegistry.Provider memory p = registry.getProvider(provider);
        if (!p.active) revert InvalidProvider();

        uint64 deadline = uint64(block.timestamp) + duration;

        dealId = nextDealId++;
        deals[dealId] = Deal({
            consumer: msg.sender,
            deadline: deadline,
            totalChunks: totalChunks,
            provider: provider,
            escrow: uint88(msg.value),
            status: Status.Active,
            merkleRoot: merkleRoot
        });

        emit DealCreated(
            dealId,
            msg.sender,
            provider,
            merkleRoot,
            totalChunks,
            msg.value,
            deadline
        );
    }

    /// @notice Provider attests that they store a given chunk by submitting a Merkle proof.
    /// @dev Verifies against the deal's merkleRoot using OZ MerkleProof. Records the attestation
    ///      so closeDeal can check whether the challenged chunk was proven.
    function submitProof(
        uint256 dealId,
        uint256 chunkIndex,
        bytes32[] calldata proof,
        bytes32 leaf
    ) external {
        Deal storage d = deals[dealId];
        if (d.status != Status.Active) revert DealNotActive();
        if (msg.sender != d.provider) revert NotProvider();
        if (chunkIndex >= d.totalChunks) revert InvalidChunkIndex();
        if (!MerkleProof.verify(proof, d.merkleRoot, leaf)) revert InvalidMerkleProof();

        verifiedChunks[dealId][chunkIndex] = true;
        emit ProofSubmitted(dealId, chunkIndex, leaf);
    }

    /// @notice After the deadline, settle the deal. Anyone may call.
    /// @dev Picks `challengeIndex = block.prevrandao % totalChunks`. If the provider has a
    ///      verified proof for that index → escrow released to provider. Otherwise → escrow
    ///      refunded to consumer AND provider stake slashed (by escrow amount) into consumer.
    function closeDeal(uint256 dealId) external nonReentrant {
        Deal storage d = deals[dealId];
        if (d.status != Status.Active) revert DealNotActive();
        if (block.timestamp < d.deadline) revert DeadlineNotReached();

        uint256 challengeIndex = block.prevrandao % uint256(d.totalChunks);

        // Cache to memory: cheaper reads + lets us zero out storage before external calls.
        uint256 escrow = uint256(d.escrow);
        address consumer = d.consumer;
        address provider = d.provider;
        bool ok = verifiedChunks[dealId][challengeIndex];

        if (ok) {
            // Effects before interaction: prevent re-entry re-running settlement.
            d.status = Status.Completed;
            (bool sent, ) = provider.call{value: escrow}("");
            if (!sent) revert TransferFailed();
            emit DealCompleted(dealId, challengeIndex, escrow);
        } else {
            d.status = Status.Slashed;
            // Refund the consumer.
            (bool sent, ) = consumer.call{value: escrow}("");
            if (!sent) revert TransferFailed();
            // Penalise the provider — slash() caps the amount at remaining stake, so this
            // never reverts on under-collateralised providers.
            registry.slash(provider, escrow, consumer);
            emit DealSlashed(dealId, challengeIndex, escrow, escrow);
        }
    }

    // ---------- views ----------

    function getDeal(uint256 dealId) external view returns (Deal memory) {
        return deals[dealId];
    }

    function getNextDealId() external view returns (uint256) {
        return nextDealId;
    }

    function isChunkVerified(uint256 dealId, uint256 chunkIndex) external view returns (bool) {
        return verifiedChunks[dealId][chunkIndex];
    }
}
