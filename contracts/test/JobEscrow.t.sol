// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";
import {ProviderRegistry} from "../src/ProviderRegistry.sol";
import {JobEscrow} from "../src/JobEscrow.sol";
import {MockERC20} from "./MockERC20.sol";

contract JobEscrowTest is Test {
    MockERC20 internal xbzz;
    ProviderRegistry internal registry;
    JobEscrow internal escrow;

    address internal treasury = address(0xT);
    address internal client   = address(0xC);
    address internal provider = address(0xP);

    uint128 internal constant STAKE       = 100 ether;
    uint128 internal constant MAX_PAYMENT = 1 ether;

    function setUp() public {
        xbzz     = new MockERC20("xBZZ", "xBZZ");
        registry = new ProviderRegistry(xbzz, treasury);
        escrow   = new JobEscrow(xbzz, registry);
        registry.setEscrow(address(escrow));

        xbzz.mint(provider, 1_000 ether);
        xbzz.mint(client,   1_000 ether);
        vm.prank(provider);
        xbzz.approve(address(registry), type(uint256).max);
        vm.prank(client);
        xbzz.approve(address(escrow), type(uint256).max);

        vm.prank(provider);
        registry.register(bytes32(uint256(1)), bytes32(uint256(2)), "bzz://meta", STAKE);
    }

    function _post() internal returns (bytes32) {
        return escrow.postJob(
            provider,
            bytes32(uint256(0xAB)),
            "llama3:8b",
            MAX_PAYMENT,
            uint64(block.timestamp + 300)
        );
    }

    function test_postAckClaim_paysProviderAndRefundsRemainder() public {
        vm.prank(client);
        bytes32 jobId = _post();

        vm.prank(provider);
        escrow.ackJob(jobId);

        uint256 provBefore = xbzz.balanceOf(provider);
        uint256 cliBefore  = xbzz.balanceOf(client);

        vm.prank(provider);
        escrow.claimJob(jobId, bytes32(uint256(0xCD)), MAX_PAYMENT / 2, "");

        assertEq(xbzz.balanceOf(provider) - provBefore, MAX_PAYMENT / 2);
        assertEq(xbzz.balanceOf(client)   - cliBefore,  MAX_PAYMENT / 2);

        ProviderRegistry.Provider memory p = registry.getProvider(provider);
        assertEq(p.totalJobs, 1);
        assertEq(p.successfulJobs, 1);
        assertEq(uint256(registry.openJobs(provider)), 0);
    }

    function test_cancelJob_slashesAndRefunds() public {
        vm.prank(client);
        bytes32 jobId = _post();

        vm.warp(block.timestamp + escrow.ACK_WINDOW() + 1);
        uint256 cliBefore = xbzz.balanceOf(client);

        vm.prank(client);
        escrow.cancelJob(jobId);

        // Client gets refund (1x) + clientShare slash (1.5x) = 2.5x maxPayment.
        assertEq(
            xbzz.balanceOf(client) - cliBefore,
            uint256(MAX_PAYMENT) + (uint256(MAX_PAYMENT) * 3) / 2
        );
        // Treasury receives the remainder of the 2x slash (0.5x).
        assertEq(xbzz.balanceOf(treasury), uint256(MAX_PAYMENT) / 2);
        assertEq(uint256(registry.openJobs(provider)), 0);
    }

    function test_timeoutJob_slashesAfterAckAndDeadline() public {
        vm.prank(client);
        bytes32 jobId = _post();
        vm.prank(provider);
        escrow.ackJob(jobId);

        vm.warp(block.timestamp + 1_000); // past deliveryDeadline
        uint256 cliBefore = xbzz.balanceOf(client);
        vm.prank(client);
        escrow.timeoutJob(jobId);

        // 1x refund + 1.5x clientShare = 2.5x.
        assertEq(
            xbzz.balanceOf(client) - cliBefore,
            uint256(MAX_PAYMENT) + (uint256(MAX_PAYMENT) * 3) / 2
        );
        // 3x slash - 1.5x client = 1.5x to treasury.
        assertEq(xbzz.balanceOf(treasury), (uint256(MAX_PAYMENT) * 3) / 2);
    }

    function test_postJob_revertsWhenProviderOffline() public {
        vm.warp(block.timestamp + registry.HEARTBEAT_TTL() + 1);
        vm.prank(client);
        vm.expectRevert(JobEscrow.ProviderNotLive.selector);
        _post();
    }

    function test_postJob_concurrencyCap() public {
        // STAKE = 100; required = (open+1) * 3 * maxPayment. With maxPayment
        // = 30 ether, only one job fits (1*3*30 = 90), the second would push
        // to 2*3*30 = 180 > 100.
        uint128 big = 30 ether;
        vm.prank(client);
        escrow.postJob(provider, bytes32(0), "m", big, uint64(block.timestamp + 300));

        vm.prank(client);
        vm.expectRevert(JobEscrow.InsufficientStakeForJob.selector);
        escrow.postJob(provider, bytes32(0), "m", big, uint64(block.timestamp + 300));
    }
}
