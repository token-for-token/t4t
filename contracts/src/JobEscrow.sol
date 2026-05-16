// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "./IERC20.sol";
import {ProviderRegistry} from "./ProviderRegistry.sol";

/// @title  JobEscrow
/// @notice Holds client payment + slash collateral for each job and settles
///         on delivery, cancellation, or timeout. See `docs/spec.md` §4.2.
contract JobEscrow {
    enum JobStatus {None, Pending, Acked, Delivered, Claimed, Cancelled, TimedOut}

    struct Job {
        address client;
        address provider;
        bytes32 requestHash;
        bytes32 responseHash;
        string  modelId;
        uint128 maxPayment;
        uint64  postedAt;
        uint64  ackedAt;
        uint64  ackDeadline;
        uint64  deliveryDeadline;
        JobStatus status;
    }

    uint64  public constant ACK_WINDOW = 30;
    // xBZZ has 16 decimals on Gnosis (not 18). MIN_SLASH = 1 BZZ.
    uint128 public constant MIN_SLASH = 1 * 1e16;
    /// @dev Slash multipliers used to size collateral checks and penalties.
    uint256 public constant SLASH_MULT_NO_ACK = 2;
    uint256 public constant SLASH_MULT_TIMEOUT = 3;

    IERC20 public immutable xbzz;
    ProviderRegistry public immutable registry;

    mapping(bytes32 => Job) public jobs;
    uint256 public jobCounter;

    event JobPosted(bytes32 indexed jobId, address indexed client, address indexed provider);
    event JobAcked(bytes32 indexed jobId);
    event JobClaimed(bytes32 indexed jobId, bytes32 responseHash, uint128 paid);
    event JobCancelled(bytes32 indexed jobId, uint128 slash);
    event JobTimedOut(bytes32 indexed jobId, uint128 slash);

    error NotProvider();
    error NotClient();
    error BadStatus();
    error DeadlinePassed();
    error DeadlineNotPassed();
    error PaymentTooHigh();
    error ProviderNotLive();
    error InsufficientStakeForJob();
    error TransferFailed();
    error BadDeadline();

    constructor(IERC20 _xbzz, ProviderRegistry _registry) {
        xbzz = _xbzz;
        registry = _registry;
    }

    function postJob(
        address provider,
        bytes32 requestHash,
        string  calldata modelId,
        uint128 maxPayment,
        uint64  deliveryDeadline
    ) external returns (bytes32 jobId) {
        if (!registry.isLive(provider)) revert ProviderNotLive();
        if (deliveryDeadline <= block.timestamp + ACK_WINDOW) revert BadDeadline();

        uint128 stake = registry.getStake(provider);
        uint32  open  = registry.openJobs(provider);
        // Concurrency cap from spec §4.2: enforce that the provider's worst-case
        // exposure across all open jobs stays within posted stake.
        uint256 needed = (uint256(open) + 1) * SLASH_MULT_TIMEOUT * uint256(maxPayment);
        if (needed > stake) revert InsufficientStakeForJob();

        if (!xbzz.transferFrom(msg.sender, address(this), maxPayment)) revert TransferFailed();

        jobCounter += 1;
        jobId = keccak256(abi.encode(block.chainid, address(this), msg.sender, jobCounter));

        uint64 nowT = uint64(block.timestamp);
        jobs[jobId] = Job({
            client: msg.sender,
            provider: provider,
            requestHash: requestHash,
            responseHash: bytes32(0),
            modelId: modelId,
            maxPayment: maxPayment,
            postedAt: nowT,
            ackedAt: 0,
            ackDeadline: nowT + ACK_WINDOW,
            deliveryDeadline: deliveryDeadline,
            status: JobStatus.Pending
        });
        registry.recordJobStart(provider);

        emit JobPosted(jobId, msg.sender, provider);
    }

    function ackJob(bytes32 jobId) external {
        Job storage j = jobs[jobId];
        if (j.provider != msg.sender) revert NotProvider();
        if (j.status != JobStatus.Pending) revert BadStatus();
        if (block.timestamp > j.ackDeadline) revert DeadlinePassed();
        j.status = JobStatus.Acked;
        j.ackedAt = uint64(block.timestamp);
        emit JobAcked(jobId);
    }

    /// @notice Provider claims payment after delivering off-chain. `clientSig`
    ///         is reserved for the fast-settlement path described in spec
    ///         §13; v1 settles purely on the provider's word + deadlines.
    function claimJob(
        bytes32 jobId,
        bytes32 responseHash,
        uint128 actualPayment,
        bytes calldata /* clientSig */
    ) external {
        Job storage j = jobs[jobId];
        if (j.provider != msg.sender) revert NotProvider();
        if (j.status != JobStatus.Acked && j.status != JobStatus.Pending) revert BadStatus();
        if (actualPayment > j.maxPayment) revert PaymentTooHigh();
        if (block.timestamp > j.deliveryDeadline) revert DeadlinePassed();

        j.responseHash = responseHash;
        j.status = JobStatus.Claimed;

        uint128 refund = j.maxPayment - actualPayment;
        if (actualPayment > 0 && !xbzz.transfer(j.provider, actualPayment)) revert TransferFailed();
        if (refund > 0 && !xbzz.transfer(j.client, refund)) revert TransferFailed();

        registry.recordJobSuccess(j.provider);
        emit JobClaimed(jobId, responseHash, actualPayment);
    }

    function cancelJob(bytes32 jobId) external {
        Job storage j = jobs[jobId];
        if (j.client != msg.sender) revert NotClient();
        if (j.status != JobStatus.Pending) revert BadStatus();
        if (block.timestamp <= j.ackDeadline) revert DeadlineNotPassed();

        j.status = JobStatus.Cancelled;
        if (!xbzz.transfer(j.client, j.maxPayment)) revert TransferFailed();

        uint128 slashAmount = _settle(jobId, j, SLASH_MULT_NO_ACK);
        emit JobCancelled(jobId, slashAmount);
    }

    function timeoutJob(bytes32 jobId) external {
        Job storage j = jobs[jobId];
        if (j.client != msg.sender) revert NotClient();
        if (j.status != JobStatus.Acked) revert BadStatus();
        if (block.timestamp <= j.deliveryDeadline) revert DeadlineNotPassed();

        j.status = JobStatus.TimedOut;
        if (!xbzz.transfer(j.client, j.maxPayment)) revert TransferFailed();

        uint128 slashAmount = _settle(jobId, j, SLASH_MULT_TIMEOUT);
        emit JobTimedOut(jobId, slashAmount);
    }

    function _settle(bytes32 jobId, Job storage j, uint256 mult) private returns (uint128) {
        uint256 raw = mult * uint256(j.maxPayment);
        uint256 capped = raw < MIN_SLASH ? MIN_SLASH : raw;
        uint128 slashAmount = capped > type(uint128).max ? type(uint128).max : uint128(capped);

        // Slashed stake is burned, not paid out — see ProviderRegistry.BURN_ADDRESS.
        // The client's only recovery is the refund already issued above.
        registry.slash(j.provider, slashAmount, jobId);
        registry.recordJobFail(j.provider);
        return slashAmount;
    }
}
