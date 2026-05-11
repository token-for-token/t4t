// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";
import {IERC20} from "../src/IERC20.sol";
import {ProviderRegistry} from "../src/ProviderRegistry.sol";
import {JobEscrow} from "../src/JobEscrow.sol";
import {Treasury} from "../src/Treasury.sol";

/// @notice End-to-end tests driven against a Gnosis Chain fork and the real
///         xBZZ ERC-20. Mirrors SwarmChat's fork-test pattern: spin up a fork,
///         seed wallets via `deal`, deploy the full stack, drive lifecycles.
///
/// Skipped when `FORK_GNOSIS_RPC_URL` is unset, so the regular `forge test`
/// run stays hermetic. Invoke explicitly with:
///
///   FORK_GNOSIS_RPC_URL=https://rpc.gnosischain.com \
///     forge test --match-contract ForkTest -vvv
contract ForkTest is Test {
    /// xBZZ on Gnosis Chain (chain id 100). Bridged BZZ via OmniBridge.
    address internal constant XBZZ = 0xdBF3Ea6F5beE45c02255B2c26a16F300502F68da;

    IERC20           internal xbzz;
    Treasury         internal treasury;
    ProviderRegistry internal registry;
    JobEscrow        internal escrow;

    address internal treasuryOwner = makeAddr("treasury-owner");
    address internal provider      = makeAddr("provider");
    address internal client        = makeAddr("client");

    bool internal forked;

    function setUp() public {
        string memory rpc = vm.envOr("FORK_GNOSIS_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;

        xbzz     = IERC20(XBZZ);
        treasury = new Treasury(xbzz, treasuryOwner);
        registry = new ProviderRegistry(xbzz, address(treasury));
        escrow   = new JobEscrow(xbzz, registry);
        registry.setEscrow(address(escrow));

        deal(XBZZ, provider, 1_000 ether);
        deal(XBZZ, client,   1_000 ether);

        vm.prank(provider);
        xbzz.approve(address(registry), type(uint256).max);
        vm.prank(client);
        xbzz.approve(address(escrow), type(uint256).max);
    }

    modifier onlyOnFork() {
        if (!forked) {
            vm.skip(true);
            return;
        }
        _;
    }

    // ----------------------------------------------------------------
    //                       Sanity: real xBZZ
    // ----------------------------------------------------------------

    function test_realXBZZ_isReachable() public onlyOnFork {
        // totalSupply > 0 confirms we're talking to a deployed token, not 0xdead.
        assertGt(xbzz.totalSupply(), 0);
        assertEq(xbzz.balanceOf(provider), 1_000 ether);
        assertEq(xbzz.balanceOf(client), 1_000 ether);
    }

    // ----------------------------------------------------------------
    //                  Happy path: register → claim
    // ----------------------------------------------------------------

    function test_lifecycle_register_post_ack_claim() public onlyOnFork {
        _registerProvider();

        uint64  deadline = uint64(block.timestamp + 120);
        uint128 maxPay   = 1 ether;

        vm.prank(client);
        bytes32 jobId = escrow.postJob(provider, bytes32("req"), "llama3", maxPay, deadline);

        vm.prank(provider);
        escrow.ackJob(jobId);

        uint256 providerBefore = xbzz.balanceOf(provider);
        uint256 clientBefore   = xbzz.balanceOf(client);

        uint128 actualPay = 0.5 ether;
        vm.prank(provider);
        escrow.claimJob(jobId, bytes32("resp"), actualPay, "");

        assertEq(xbzz.balanceOf(provider), providerBefore + actualPay);
        assertEq(xbzz.balanceOf(client),   clientBefore   + (maxPay - actualPay));

        ProviderRegistry.Provider memory p = registry.getProvider(provider);
        assertEq(p.totalJobs, 1);
        assertEq(p.successfulJobs, 1);
        assertEq(registry.openJobs(provider), 0);
    }

    // ----------------------------------------------------------------
    //                  Slash path: no-ACK → cancel
    // ----------------------------------------------------------------

    function test_cancel_slashesProvider() public onlyOnFork {
        _registerProvider();

        uint128 maxPay   = 1 ether;
        uint64  deadline = uint64(block.timestamp + 120);

        vm.prank(client);
        bytes32 jobId = escrow.postJob(provider, bytes32("req"), "llama3", maxPay, deadline);

        // Provider never ACKs; warp past ackDeadline (= postedAt + ACK_WINDOW).
        vm.warp(block.timestamp + escrow.ACK_WINDOW() + 1);

        uint128 stakeBefore     = registry.getStake(provider);
        uint256 treasuryBefore  = xbzz.balanceOf(address(treasury));
        uint256 clientBefore    = xbzz.balanceOf(client);

        vm.prank(client);
        escrow.cancelJob(jobId);

        // Slash math: 2 × maxPay = 2e18, client share = 1.5 × maxPay = 1.5e18,
        // treasury gets the remainder = 0.5e18. Client also receives the refund.
        assertEq(xbzz.balanceOf(client) - clientBefore,            maxPay + 1.5 ether);
        assertEq(xbzz.balanceOf(address(treasury)) - treasuryBefore, 0.5 ether);
        assertEq(stakeBefore - registry.getStake(provider),        2 ether);
    }

    // ----------------------------------------------------------------
    //                Slash path: ACK but no delivery → timeout
    // ----------------------------------------------------------------

    function test_timeout_slashesProvider() public onlyOnFork {
        _registerProvider();

        uint128 maxPay   = 1 ether;
        uint64  deadline = uint64(block.timestamp + 120);

        vm.prank(client);
        bytes32 jobId = escrow.postJob(provider, bytes32("req"), "llama3", maxPay, deadline);

        vm.prank(provider);
        escrow.ackJob(jobId);

        vm.warp(uint256(deadline) + 1);

        uint128 stakeBefore    = registry.getStake(provider);
        uint256 treasuryBefore = xbzz.balanceOf(address(treasury));
        uint256 clientBefore   = xbzz.balanceOf(client);

        vm.prank(client);
        escrow.timeoutJob(jobId);

        // Slash = 3 × maxPay = 3e18, client share = 1.5e18, treasury = 1.5e18.
        assertEq(xbzz.balanceOf(client) - clientBefore,              maxPay + 1.5 ether);
        assertEq(xbzz.balanceOf(address(treasury)) - treasuryBefore, 1.5 ether);
        assertEq(stakeBefore - registry.getStake(provider),          3 ether);
    }

    // ----------------------------------------------------------------
    //               Stake lifecycle: deactivate → withdraw
    // ----------------------------------------------------------------

    function test_stakeWithdraw_afterUnbonding() public onlyOnFork {
        _registerProvider();

        vm.prank(provider);
        registry.deactivate();
        vm.warp(block.timestamp + registry.UNBONDING_PERIOD() + 1);

        uint128 stake   = registry.getStake(provider);
        uint256 before  = xbzz.balanceOf(provider);

        vm.prank(provider);
        registry.withdrawStake();

        assertEq(xbzz.balanceOf(provider) - before, stake);
        assertEq(registry.getStake(provider), 0);
    }

    // ----------------------------------------------------------------
    //                            helpers
    // ----------------------------------------------------------------

    function _registerProvider() internal {
        vm.prank(provider);
        registry.register(
            bytes32(uint256(0xAA)),
            bytes32(uint256(0xBB)),
            "bzz://meta",
            registry.MIN_STAKE()
        );
    }
}
