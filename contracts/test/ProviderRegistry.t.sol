// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";
import {ProviderRegistry} from "../src/ProviderRegistry.sol";
import {MockERC20} from "./MockERC20.sol";

contract ProviderRegistryTest is Test {
    MockERC20 internal xbzz;
    ProviderRegistry internal registry;
    address internal provider = makeAddr("provider");

    function setUp() public {
        xbzz = new MockERC20("xBZZ", "xBZZ");
        registry = new ProviderRegistry(xbzz);

        xbzz.mint(provider, 1_000 ether);
        vm.prank(provider);
        xbzz.approve(address(registry), type(uint256).max);
    }

    function _register() internal {
        uint128 minStake = registry.MIN_STAKE();
        vm.prank(provider);
        registry.register(
            bytes32(uint256(0xAA)),
            bytes32(uint256(0xBB)),
            "bzz://meta",
            minStake
        );
    }

    function test_register_setsStateAndTransfersStake() public {
        _register();

        ProviderRegistry.Provider memory p = registry.getProvider(provider);
        assertEq(p.owner, provider);
        assertEq(p.stake, registry.MIN_STAKE());
        assertEq(uint256(p.lastHeartbeat), block.timestamp);
        assertTrue(p.active);
        assertEq(xbzz.balanceOf(address(registry)), registry.MIN_STAKE());
    }

    function test_register_revertsBelowMinStake() public {
        uint128 belowMin = registry.MIN_STAKE() - 1;
        vm.prank(provider);
        vm.expectRevert(ProviderRegistry.InsufficientStake.selector);
        registry.register(bytes32(0), bytes32(uint256(1)), "", belowMin);
    }

    function test_heartbeat_updatesTimestampAndLiveness() public {
        _register();
        vm.warp(block.timestamp + 100);
        vm.prank(provider);
        registry.heartbeat();
        assertEq(uint256(registry.getProvider(provider).lastHeartbeat), block.timestamp);
        assertTrue(registry.isLive(provider));

        vm.warp(block.timestamp + registry.HEARTBEAT_TTL() + 1);
        assertFalse(registry.isLive(provider));
    }

    function test_deactivate_thenWithdrawAfterUnbond() public {
        _register();
        vm.prank(provider);
        registry.deactivate();

        vm.prank(provider);
        vm.expectRevert(ProviderRegistry.StillBonded.selector);
        registry.withdrawStake();

        vm.warp(block.timestamp + registry.UNBONDING_PERIOD() + 1);
        uint256 before = xbzz.balanceOf(provider);
        vm.prank(provider);
        registry.withdrawStake();
        assertEq(xbzz.balanceOf(provider) - before, registry.MIN_STAKE());
    }

    function test_setEscrow_isOneShot() public {
        registry.setEscrow(makeAddr("escrow1"));
        vm.expectRevert(ProviderRegistry.EscrowAlreadySet.selector);
        registry.setEscrow(makeAddr("escrow2"));
    }

    function test_updateOfferings_replacesArray() public {
        _register();
        ProviderRegistry.ModelOffering[] memory offers = new ProviderRegistry.ModelOffering[](2);
        offers[0] = ProviderRegistry.ModelOffering("llama3:8b", 0.2 ether, 1 ether, 8192, 120);
        offers[1] = ProviderRegistry.ModelOffering("mistral:7b", 0.1 ether, 0.5 ether, 32768, 60);
        vm.prank(provider);
        registry.updateOfferings(offers);
        assertEq(registry.getOfferings(provider).length, 2);
    }

    // ----------------------------------------------------------------
    //   Revert paths
    // ----------------------------------------------------------------

    function test_register_revertsWhenAlreadyRegistered() public {
        _register();
        uint128 minStake = registry.MIN_STAKE();
        vm.prank(provider);
        vm.expectRevert(ProviderRegistry.AlreadyRegistered.selector);
        registry.register(bytes32(0), bytes32(0), "", minStake);
    }

    function test_register_revertsWhenAllowanceMissing() public {
        address other = makeAddr("noAllowance");
        xbzz.mint(other, 1_000 ether);
        uint128 minStake = registry.MIN_STAKE();
        vm.prank(other);
        vm.expectRevert(bytes("ERC20: allowance"));
        registry.register(bytes32(0), bytes32(0), "", minStake);
    }

    function test_heartbeat_revertsForUnregistered() public {
        address other = makeAddr("ghost");
        vm.prank(other);
        vm.expectRevert(ProviderRegistry.NotRegistered.selector);
        registry.heartbeat();
    }

    function test_deactivate_revertsForUnregistered() public {
        address other = makeAddr("ghost");
        vm.prank(other);
        vm.expectRevert(ProviderRegistry.NotRegistered.selector);
        registry.deactivate();
    }

    function test_deactivate_revertsWhenAlreadyInactive() public {
        _register();
        vm.prank(provider);
        registry.deactivate();
        vm.prank(provider);
        vm.expectRevert(ProviderRegistry.NotRegistered.selector);
        registry.deactivate();
    }

    function test_withdrawStake_revertsWhileActive() public {
        _register();
        vm.prank(provider);
        vm.expectRevert(ProviderRegistry.StillActive.selector);
        registry.withdrawStake();
    }

    function test_withdrawStake_revertsWhenOpenJobsRemain() public {
        _register();
        // Pretend the escrow is the test contract so we can poke openJobs.
        registry.setEscrow(address(this));
        registry.recordJobStart(provider);

        vm.prank(provider);
        registry.deactivate();
        vm.warp(block.timestamp + registry.UNBONDING_PERIOD() + 1);

        vm.prank(provider);
        vm.expectRevert(ProviderRegistry.OpenJobsRemain.selector);
        registry.withdrawStake();
    }

    function test_setEscrow_onlyOwner() public {
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert(ProviderRegistry.NotOwner.selector);
        registry.setEscrow(makeAddr("escrow"));
    }

    function test_slash_onlyEscrow() public {
        _register();
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert(ProviderRegistry.NotEscrow.selector);
        registry.slash(provider, 1 ether, bytes32(0));
    }

    function test_addStake_incrementsAndEmitsEvent() public {
        _register();
        uint128 add = 50 ether;
        uint128 before = registry.getProvider(provider).stake;
        vm.expectEmit(true, false, false, true);
        emit StakeAdded(provider, add);
        vm.prank(provider);
        registry.addStake(add);
        assertEq(registry.getProvider(provider).stake, before + add);
    }

    function test_addStake_revertsForUnregistered() public {
        address other = makeAddr("ghost");
        vm.prank(other);
        vm.expectRevert(ProviderRegistry.NotRegistered.selector);
        registry.addStake(1 ether);
    }

    function test_updateOfferings_revertsForUnregistered() public {
        address other = makeAddr("ghost");
        ProviderRegistry.ModelOffering[] memory offers = new ProviderRegistry.ModelOffering[](0);
        vm.prank(other);
        vm.expectRevert(ProviderRegistry.NotRegistered.selector);
        registry.updateOfferings(offers);
    }

    function test_isLive_falseForUnregistered() public {
        assertFalse(registry.isLive(makeAddr("ghost")));
    }

    function test_isLive_falseAfterDeactivate() public {
        _register();
        vm.prank(provider);
        registry.deactivate();
        assertFalse(registry.isLive(provider));
    }

    function test_listProviders_paginatesCorrectly() public {
        _register();
        // Register two more
        address p2 = makeAddr("p2");
        address p3 = makeAddr("p3");
        xbzz.mint(p2, 1_000 ether);
        xbzz.mint(p3, 1_000 ether);
        vm.prank(p2);
        xbzz.approve(address(registry), type(uint256).max);
        vm.prank(p3);
        xbzz.approve(address(registry), type(uint256).max);
        uint128 stake = registry.MIN_STAKE();
        vm.prank(p2);
        registry.register(bytes32(0), bytes32(0), "", stake);
        vm.prank(p3);
        registry.register(bytes32(0), bytes32(0), "", stake);

        (ProviderRegistry.Provider[] memory page1, uint256 cursor1) = registry.listProviders(0, 2);
        assertEq(page1.length, 2);
        assertEq(cursor1, 2);
        (ProviderRegistry.Provider[] memory page2, uint256 cursor2) = registry.listProviders(cursor1, 2);
        assertEq(page2.length, 1);
        assertEq(cursor2, 3);
        (ProviderRegistry.Provider[] memory page3, uint256 cursor3) = registry.listProviders(cursor2, 2);
        assertEq(page3.length, 0);
        assertEq(cursor3, 3);
    }

    function test_emitsProviderRegisteredEvent() public {
        uint128 minStake = registry.MIN_STAKE();
        vm.expectEmit(true, false, false, true);
        emit ProviderRegistered(provider, bytes32(uint256(0xAA)));
        vm.prank(provider);
        registry.register(bytes32(uint256(0xAA)), bytes32(0), "", minStake);
    }

    // ----------------------------------------------------------------
    //   Fuzz
    // ----------------------------------------------------------------

    function testFuzz_register_acceptsAnyStakeAboveMin(uint128 stake) public {
        uint128 minStake = registry.MIN_STAKE();
        stake = uint128(bound(uint256(stake), uint256(minStake), 1_000 ether));
        vm.prank(provider);
        registry.register(bytes32(0), bytes32(0), "", stake);
        assertEq(registry.getProvider(provider).stake, stake);
        assertEq(xbzz.balanceOf(address(registry)), stake);
    }

    function testFuzz_register_rejectsAnyStakeBelowMin(uint128 stake) public {
        uint128 minStake = registry.MIN_STAKE();
        stake = uint128(bound(uint256(stake), 0, uint256(minStake) - 1));
        vm.prank(provider);
        vm.expectRevert(ProviderRegistry.InsufficientStake.selector);
        registry.register(bytes32(0), bytes32(0), "", stake);
    }

    function testFuzz_addStake_strictlyIncrementsStake(uint128 add) public {
        _register();
        add = uint128(bound(uint256(add), 1, 500 ether));
        uint128 before = registry.getProvider(provider).stake;
        vm.prank(provider);
        registry.addStake(add);
        assertEq(registry.getProvider(provider).stake, before + add);
    }

    function testFuzz_heartbeat_updatesToCurrentTimestamp(uint64 delta) public {
        _register();
        delta = uint64(bound(uint256(delta), 1, 365 days));
        vm.warp(block.timestamp + delta);
        vm.prank(provider);
        registry.heartbeat();
        assertEq(uint256(registry.getProvider(provider).lastHeartbeat), block.timestamp);
    }

    function testFuzz_isLive_boundaryBehavesAroundTTL(uint64 elapsed) public {
        _register();
        elapsed = uint64(bound(uint256(elapsed), 0, 3 days));
        uint64 startedAt = uint64(block.timestamp);
        vm.warp(startedAt + elapsed);
        bool expected = elapsed <= registry.HEARTBEAT_TTL();
        assertEq(registry.isLive(provider), expected);
    }

    // ----------------------------------------------------------------
    //   maxConcurrentJobs
    // ----------------------------------------------------------------

    function test_register_initializesMaxConcurrentJobsToZero() public {
        _register();
        assertEq(uint256(registry.getProvider(provider).maxConcurrentJobs), 0);
    }

    function test_setMaxConcurrentJobs_updatesAndEmits() public {
        _register();
        vm.expectEmit(true, false, false, true);
        emit MaxConcurrentJobsUpdated(provider, 4);
        vm.prank(provider);
        registry.setMaxConcurrentJobs(4);
        assertEq(uint256(registry.getProvider(provider).maxConcurrentJobs), 4);
    }

    function test_setMaxConcurrentJobs_acceptsZeroAsUnlimited() public {
        _register();
        vm.prank(provider);
        registry.setMaxConcurrentJobs(2);
        vm.prank(provider);
        registry.setMaxConcurrentJobs(0);
        assertEq(uint256(registry.getProvider(provider).maxConcurrentJobs), 0);
    }

    function test_setMaxConcurrentJobs_revertsForUnregistered() public {
        address other = makeAddr("ghost");
        vm.prank(other);
        vm.expectRevert(ProviderRegistry.NotRegistered.selector);
        registry.setMaxConcurrentJobs(2);
    }

    // Mirror the contract events so vm.expectEmit can match them by signature.
    event ProviderRegistered(address indexed owner, bytes32 pssPubKey);
    event StakeAdded(address indexed owner, uint128 amount);
    event MaxConcurrentJobsUpdated(address indexed owner, uint32 cap);
}
