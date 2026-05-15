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

    address internal client   = makeAddr("client");
    address internal provider = makeAddr("provider");

    uint128 internal constant STAKE       = 100 ether;
    uint128 internal constant MAX_PAYMENT = 1 ether;

    function _burn() internal view returns (address) {
        return registry.BURN_ADDRESS();
    }

    function setUp() public {
        xbzz     = new MockERC20("xBZZ", "xBZZ");
        registry = new ProviderRegistry(xbzz);
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

        // Client gets only the refund — no share of slash, so no incentive to
        // grief the provider into failing.
        assertEq(xbzz.balanceOf(client) - cliBefore, uint256(MAX_PAYMENT));
        // Full 2x slash is burned.
        assertEq(xbzz.balanceOf(_burn()), uint256(MAX_PAYMENT) * 2);
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

        assertEq(xbzz.balanceOf(client) - cliBefore, uint256(MAX_PAYMENT));
        // Full 3x slash is burned.
        assertEq(xbzz.balanceOf(_burn()), uint256(MAX_PAYMENT) * 3);
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

    // ----------------------------------------------------------------
    //   Revert paths
    // ----------------------------------------------------------------

    function test_postJob_revertsWhenDeadlineTooSoon() public {
        uint64 ack = escrow.ACK_WINDOW();
        vm.prank(client);
        vm.expectRevert(JobEscrow.BadDeadline.selector);
        // deliveryDeadline == now + ACK_WINDOW is rejected (strict <=).
        escrow.postJob(provider, bytes32(0), "m", MAX_PAYMENT, uint64(block.timestamp + ack));
    }

    function test_ackJob_revertsForNonProvider() public {
        vm.prank(client);
        bytes32 jobId = _post();
        vm.prank(client);
        vm.expectRevert(JobEscrow.NotProvider.selector);
        escrow.ackJob(jobId);
    }

    function test_ackJob_revertsWhenAlreadyAcked() public {
        vm.prank(client);
        bytes32 jobId = _post();
        vm.prank(provider);
        escrow.ackJob(jobId);
        vm.prank(provider);
        vm.expectRevert(JobEscrow.BadStatus.selector);
        escrow.ackJob(jobId);
    }

    function test_ackJob_revertsWhenPastAckDeadline() public {
        vm.prank(client);
        bytes32 jobId = _post();
        vm.warp(block.timestamp + escrow.ACK_WINDOW() + 1);
        vm.prank(provider);
        vm.expectRevert(JobEscrow.DeadlinePassed.selector);
        escrow.ackJob(jobId);
    }

    function test_claimJob_revertsForNonProvider() public {
        vm.prank(client);
        bytes32 jobId = _post();
        vm.prank(provider);
        escrow.ackJob(jobId);
        vm.prank(client);
        vm.expectRevert(JobEscrow.NotProvider.selector);
        escrow.claimJob(jobId, bytes32(0), MAX_PAYMENT, "");
    }

    function test_claimJob_revertsWhenPaymentExceedsMax() public {
        vm.prank(client);
        bytes32 jobId = _post();
        vm.prank(provider);
        escrow.ackJob(jobId);
        vm.prank(provider);
        vm.expectRevert(JobEscrow.PaymentTooHigh.selector);
        escrow.claimJob(jobId, bytes32(0), MAX_PAYMENT + 1, "");
    }

    function test_claimJob_revertsAfterDeliveryDeadline() public {
        vm.prank(client);
        bytes32 jobId = _post();
        vm.prank(provider);
        escrow.ackJob(jobId);
        vm.warp(block.timestamp + 1_000);
        vm.prank(provider);
        vm.expectRevert(JobEscrow.DeadlinePassed.selector);
        escrow.claimJob(jobId, bytes32(0), MAX_PAYMENT, "");
    }

    function test_claimJob_revertsAfterAlreadyClaimed() public {
        vm.prank(client);
        bytes32 jobId = _post();
        vm.prank(provider);
        escrow.ackJob(jobId);
        vm.prank(provider);
        escrow.claimJob(jobId, bytes32(0), MAX_PAYMENT, "");
        vm.prank(provider);
        vm.expectRevert(JobEscrow.BadStatus.selector);
        escrow.claimJob(jobId, bytes32(0), MAX_PAYMENT, "");
    }

    function test_claimJob_canSkipAckPath() public {
        // Provider may claim directly without ackJob if they deliver in time.
        vm.prank(client);
        bytes32 jobId = _post();
        vm.prank(provider);
        escrow.claimJob(jobId, bytes32(uint256(0xCD)), MAX_PAYMENT, "");
        (, , , , , , , , , , JobEscrow.JobStatus status) = escrow.jobs(jobId);
        assertEq(uint8(status), uint8(JobEscrow.JobStatus.Claimed));
    }

    function test_claimJob_zeroActualPaymentRefundsFull() public {
        vm.prank(client);
        bytes32 jobId = _post();
        vm.prank(provider);
        escrow.ackJob(jobId);

        uint256 cliBefore = xbzz.balanceOf(client);
        uint256 provBefore = xbzz.balanceOf(provider);

        vm.prank(provider);
        escrow.claimJob(jobId, bytes32(0), 0, "");

        // Provider got nothing, client got their full payment back.
        assertEq(xbzz.balanceOf(provider) - provBefore, 0);
        assertEq(xbzz.balanceOf(client)   - cliBefore,  MAX_PAYMENT);
    }

    function test_cancelJob_revertsForNonClient() public {
        vm.prank(client);
        bytes32 jobId = _post();
        vm.warp(block.timestamp + escrow.ACK_WINDOW() + 1);
        vm.prank(provider);
        vm.expectRevert(JobEscrow.NotClient.selector);
        escrow.cancelJob(jobId);
    }

    function test_cancelJob_revertsBeforeAckDeadline() public {
        vm.prank(client);
        bytes32 jobId = _post();
        // Within the ack window still — cancel must wait.
        vm.prank(client);
        vm.expectRevert(JobEscrow.DeadlineNotPassed.selector);
        escrow.cancelJob(jobId);
    }

    function test_cancelJob_revertsAfterAck() public {
        vm.prank(client);
        bytes32 jobId = _post();
        vm.prank(provider);
        escrow.ackJob(jobId);
        vm.warp(block.timestamp + escrow.ACK_WINDOW() + 1);
        vm.prank(client);
        vm.expectRevert(JobEscrow.BadStatus.selector);
        escrow.cancelJob(jobId);
    }

    function test_timeoutJob_revertsForNonClient() public {
        vm.prank(client);
        bytes32 jobId = _post();
        vm.prank(provider);
        escrow.ackJob(jobId);
        vm.warp(block.timestamp + 1_000);
        vm.prank(provider);
        vm.expectRevert(JobEscrow.NotClient.selector);
        escrow.timeoutJob(jobId);
    }

    function test_timeoutJob_revertsBeforeDeadline() public {
        vm.prank(client);
        bytes32 jobId = _post();
        vm.prank(provider);
        escrow.ackJob(jobId);
        vm.prank(client);
        vm.expectRevert(JobEscrow.DeadlineNotPassed.selector);
        escrow.timeoutJob(jobId);
    }

    function test_timeoutJob_revertsWithoutPriorAck() public {
        vm.prank(client);
        bytes32 jobId = _post();
        vm.warp(block.timestamp + 1_000);
        vm.prank(client);
        vm.expectRevert(JobEscrow.BadStatus.selector);
        escrow.timeoutJob(jobId);
    }

    function test_slash_isCappedByAvailableStake() public {
        // The concurrency cap normally prevents over-slashing, but the
        // registry-side check is defense-in-depth. Call it directly via the
        // escrow to confirm slash > stake never drains beyond `stake`.
        uint128 stakeBefore = registry.getStake(provider);
        vm.prank(address(escrow));
        registry.slash(provider, stakeBefore + 10 ether, bytes32(0));
        assertEq(registry.getStake(provider), 0);
    }

    // ----------------------------------------------------------------
    //   Fuzz
    // ----------------------------------------------------------------

    function testFuzz_claimJob_refundsExactRemainder(uint128 actual) public {
        actual = uint128(bound(uint256(actual), 0, uint256(MAX_PAYMENT)));
        vm.prank(client);
        bytes32 jobId = _post();
        vm.prank(provider);
        escrow.ackJob(jobId);

        uint256 cliBefore  = xbzz.balanceOf(client);
        uint256 provBefore = xbzz.balanceOf(provider);

        vm.prank(provider);
        escrow.claimJob(jobId, bytes32(0), actual, "");

        assertEq(xbzz.balanceOf(provider) - provBefore, actual);
        assertEq(xbzz.balanceOf(client)   - cliBefore,  uint256(MAX_PAYMENT) - uint256(actual));
        // Escrow returned to zero balance (no held funds for this job).
        assertEq(xbzz.balanceOf(address(escrow)), 0);
    }

    function testFuzz_postJob_acceptsAnyDeadlinePastAckWindow(uint64 delta) public {
        delta = uint64(bound(uint256(delta), uint256(escrow.ACK_WINDOW()) + 1, 30 days));
        vm.prank(client);
        escrow.postJob(provider, bytes32(0), "m", MAX_PAYMENT, uint64(block.timestamp + delta));
        assertEq(uint256(registry.openJobs(provider)), 1);
    }

    function testFuzz_postJob_rejectsDeadlineAtOrBeforeAckWindow(uint64 delta) public {
        delta = uint64(bound(uint256(delta), 0, uint256(escrow.ACK_WINDOW())));
        vm.prank(client);
        vm.expectRevert(JobEscrow.BadDeadline.selector);
        escrow.postJob(provider, bytes32(0), "m", MAX_PAYMENT, uint64(block.timestamp + delta));
    }

    function testFuzz_cancelJob_payoutMath(uint128 payment) public {
        payment = uint128(bound(uint256(payment), 1 wei, 10 ether));
        // Ensure stake covers the worst-case slash for this payment.
        vm.prank(client);
        bytes32 jobId = escrow.postJob(provider, bytes32(0), "m", payment, uint64(block.timestamp + 300));
        vm.warp(block.timestamp + escrow.ACK_WINDOW() + 1);

        uint256 cliBefore  = xbzz.balanceOf(client);
        uint256 burnBefore = xbzz.balanceOf(_burn());

        vm.prank(client);
        escrow.cancelJob(jobId);

        // Client receives the refund only. Slash floors at MIN_SLASH and is
        // fully burned — never paid out to client or treasury.
        uint256 rawSlash = uint256(payment) * 2;
        uint256 actualSlash = rawSlash < escrow.MIN_SLASH() ? escrow.MIN_SLASH() : rawSlash;

        assertEq(xbzz.balanceOf(client) - cliBefore, uint256(payment));
        assertEq(xbzz.balanceOf(_burn()) - burnBefore, actualSlash);
    }
}
