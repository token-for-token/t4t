// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";
import {ProviderRegistry} from "../src/ProviderRegistry.sol";
import {MockERC20} from "./MockERC20.sol";

contract ProviderRegistryTest is Test {
    MockERC20 internal xbzz;
    ProviderRegistry internal registry;
    address internal treasury = address(0xT);
    address internal provider = address(0xP);

    function setUp() public {
        xbzz = new MockERC20("xBZZ", "xBZZ");
        registry = new ProviderRegistry(xbzz, treasury);

        xbzz.mint(provider, 1_000 ether);
        vm.prank(provider);
        xbzz.approve(address(registry), type(uint256).max);
    }

    function _register() internal {
        vm.prank(provider);
        registry.register(
            bytes32(uint256(0xAA)),
            bytes32(uint256(0xBB)),
            "bzz://meta",
            registry.MIN_STAKE()
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
        vm.prank(provider);
        vm.expectRevert(ProviderRegistry.InsufficientStake.selector);
        registry.register(bytes32(0), bytes32(uint256(1)), "", uint128(registry.MIN_STAKE()) - 1);
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
        registry.setEscrow(address(0xE1));
        vm.expectRevert(ProviderRegistry.EscrowAlreadySet.selector);
        registry.setEscrow(address(0xE2));
    }

    function test_updateOfferings_replacesArray() public {
        _register();
        ProviderRegistry.ModelOffering[] memory offers = new ProviderRegistry.ModelOffering[](2);
        offers[0] = ProviderRegistry.ModelOffering("llama3:8b", 1 ether, 8192, 120);
        offers[1] = ProviderRegistry.ModelOffering("mistral:7b", 0.5 ether, 32768, 60);
        vm.prank(provider);
        registry.updateOfferings(offers);
        assertEq(registry.getOfferings(provider).length, 2);
    }
}
