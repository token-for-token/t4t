// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "./IERC20.sol";

/// @title  ProviderRegistry
/// @notice On-chain directory of T4T providers. Holds stake, tracks heartbeats,
///         publishes model offerings, and exposes hooks the JobEscrow uses to
///         slash stake or update reputation. See `docs/spec.md` §4.1.
contract ProviderRegistry {
    struct Provider {
        address owner;
        bytes32 pssPublicKey;
        bytes32 swarmOverlay;
        string  metadataURI;
        uint128 stake;
        uint64  lastHeartbeat;
        uint32  totalJobs;
        uint32  successfulJobs;
        bool    active;
    }

    struct ModelOffering {
        string  modelId;
        // xBZZ wei per 1,000,000 tokens, split input (prompt) vs output (completion).
        // Per-million is the industry-standard pricing unit (OpenAI, Anthropic, …);
        // separate in/out rates because generation is typically 3-5x more expensive
        // than prefill on identical hardware.
        uint128 inputPricePerMillionTokens;
        uint128 outputPricePerMillionTokens;
        uint128 maxContextTokens;
        uint64  maxLatencySeconds;
    }

    // xBZZ has 16 decimals on Gnosis (not 18). MIN_STAKE = 100 BZZ.
    uint128 public constant MIN_STAKE = 100 * 1e16;
    uint64  public constant HEARTBEAT_TTL = 600;
    uint64  public constant UNBONDING_PERIOD = 2 days;

    IERC20  public immutable xbzz;
    address public immutable treasury;
    address public immutable owner;

    address public escrow;

    mapping(address => Provider) private _providers;
    mapping(address => ModelOffering[]) private _offerings;
    mapping(address => uint64) public unbondingAt;
    mapping(address => uint32) public openJobs;
    address[] private _list;

    event ProviderRegistered(address indexed owner, bytes32 pssPubKey);
    event OfferingsUpdated(address indexed owner, uint256 count);
    event Heartbeat(address indexed owner, uint64 timestamp);
    event StakeSlashed(address indexed owner, uint128 amount, bytes32 indexed jobId);
    event ProviderDeactivated(address indexed owner);
    event StakeWithdrawn(address indexed owner, uint128 amount);
    event StakeAdded(address indexed owner, uint128 amount);
    event EscrowSet(address indexed escrow);

    error EscrowAlreadySet();
    error NotEscrow();
    error NotOwner();
    error NotRegistered();
    error AlreadyRegistered();
    error InsufficientStake();
    error StillBonded();
    error StillActive();
    error OpenJobsRemain();
    error TransferFailed();

    modifier onlyEscrow() {
        if (msg.sender != escrow) revert NotEscrow();
        _;
    }

    constructor(IERC20 _xbzz, address _treasury) {
        xbzz = _xbzz;
        treasury = _treasury;
        owner = msg.sender;
    }

    /// @notice One-shot binding of the JobEscrow that's allowed to slash and
    ///         update reputation. Deployer sets this once after both contracts
    ///         are deployed.
    function setEscrow(address _escrow) external {
        if (msg.sender != owner) revert NotOwner();
        if (escrow != address(0)) revert EscrowAlreadySet();
        escrow = _escrow;
        emit EscrowSet(_escrow);
    }

    // ============================================================
    //                    Provider self-service
    // ============================================================

    function register(
        bytes32 pssPublicKey,
        bytes32 swarmOverlay,
        string calldata metadataURI,
        uint128 initialStake
    ) external {
        if (_providers[msg.sender].owner != address(0)) revert AlreadyRegistered();
        if (initialStake < MIN_STAKE) revert InsufficientStake();
        if (!xbzz.transferFrom(msg.sender, address(this), initialStake)) revert TransferFailed();

        _providers[msg.sender] = Provider({
            owner: msg.sender,
            pssPublicKey: pssPublicKey,
            swarmOverlay: swarmOverlay,
            metadataURI: metadataURI,
            stake: initialStake,
            lastHeartbeat: uint64(block.timestamp),
            totalJobs: 0,
            successfulJobs: 0,
            active: true
        });
        _list.push(msg.sender);
        emit ProviderRegistered(msg.sender, pssPublicKey);
    }

    function addStake(uint128 amount) external {
        if (_providers[msg.sender].owner == address(0)) revert NotRegistered();
        if (!xbzz.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        _providers[msg.sender].stake += amount;
        emit StakeAdded(msg.sender, amount);
    }

    function updateOfferings(ModelOffering[] calldata offerings) external {
        if (_providers[msg.sender].owner == address(0)) revert NotRegistered();
        delete _offerings[msg.sender];
        for (uint256 i = 0; i < offerings.length; i++) {
            _offerings[msg.sender].push(offerings[i]);
        }
        emit OfferingsUpdated(msg.sender, offerings.length);
    }

    function heartbeat() external {
        if (_providers[msg.sender].owner == address(0)) revert NotRegistered();
        _providers[msg.sender].lastHeartbeat = uint64(block.timestamp);
        emit Heartbeat(msg.sender, uint64(block.timestamp));
    }

    function deactivate() external {
        if (!_providers[msg.sender].active) revert NotRegistered();
        _providers[msg.sender].active = false;
        unbondingAt[msg.sender] = uint64(block.timestamp) + UNBONDING_PERIOD;
        emit ProviderDeactivated(msg.sender);
    }

    function withdrawStake() external {
        Provider storage p = _providers[msg.sender];
        if (p.active) revert StillActive();
        if (block.timestamp < unbondingAt[msg.sender]) revert StillBonded();
        if (openJobs[msg.sender] > 0) revert OpenJobsRemain();
        uint128 amount = p.stake;
        p.stake = 0;
        if (!xbzz.transfer(msg.sender, amount)) revert TransferFailed();
        emit StakeWithdrawn(msg.sender, amount);
    }

    // ============================================================
    //                       Escrow hooks
    // ============================================================

    /// @notice Slash `amount` from `providerOwner`'s stake; pay `clientShare`
    ///         to `toClient`, route remainder to the treasury.
    function slash(
        address providerOwner,
        uint128 amount,
        address toClient,
        uint128 clientShare,
        bytes32 jobId
    ) external onlyEscrow {
        Provider storage p = _providers[providerOwner];
        uint128 actual = amount > p.stake ? p.stake : amount;
        p.stake -= actual;

        uint128 _client = clientShare > actual ? actual : clientShare;
        uint128 _treasury = actual - _client;
        if (_client > 0 && !xbzz.transfer(toClient, _client)) revert TransferFailed();
        if (_treasury > 0 && !xbzz.transfer(treasury, _treasury)) revert TransferFailed();

        emit StakeSlashed(providerOwner, actual, jobId);
    }

    function recordJobStart(address providerOwner) external onlyEscrow {
        openJobs[providerOwner] += 1;
        _providers[providerOwner].totalJobs += 1;
    }

    function recordJobSuccess(address providerOwner) external onlyEscrow {
        if (openJobs[providerOwner] > 0) openJobs[providerOwner] -= 1;
        _providers[providerOwner].successfulJobs += 1;
    }

    function recordJobFail(address providerOwner) external onlyEscrow {
        if (openJobs[providerOwner] > 0) openJobs[providerOwner] -= 1;
    }

    // ============================================================
    //                          Views
    // ============================================================

    function getProvider(address ownerAddr) external view returns (Provider memory) {
        return _providers[ownerAddr];
    }

    function getOfferings(address ownerAddr) external view returns (ModelOffering[] memory) {
        return _offerings[ownerAddr];
    }

    function getStake(address ownerAddr) external view returns (uint128) {
        return _providers[ownerAddr].stake;
    }

    function isLive(address ownerAddr) external view returns (bool) {
        Provider storage p = _providers[ownerAddr];
        if (!p.active) return false;
        return uint256(p.lastHeartbeat) + HEARTBEAT_TTL >= block.timestamp;
    }

    function listProviders(uint256 cursor, uint256 limit)
        external
        view
        returns (Provider[] memory page, uint256 nextCursor)
    {
        uint256 total = _list.length;
        if (cursor >= total) return (new Provider[](0), total);
        uint256 end = cursor + limit;
        if (end > total) end = total;
        page = new Provider[](end - cursor);
        for (uint256 i = cursor; i < end; i++) {
            page[i - cursor] = _providers[_list[i]];
        }
        nextCursor = end;
    }

    function providerCount() external view returns (uint256) {
        return _list.length;
    }
}
