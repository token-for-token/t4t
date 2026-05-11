// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Script.sol";
import {IERC20} from "../src/IERC20.sol";
import {ProviderRegistry} from "../src/ProviderRegistry.sol";
import {JobEscrow} from "../src/JobEscrow.sol";
import {Treasury} from "../src/Treasury.sol";

/// @notice Deploys Treasury → ProviderRegistry → JobEscrow, then binds the
///         escrow into the registry. xBZZ + treasury owner are read from env.
///
/// Env:
///   XBZZ_ADDRESS    — ERC-20 address of xBZZ on the target chain.
///   TREASURY_OWNER  — multi-sig (or EOA on testnet) controlling the treasury.
contract DeployScript is Script {
    function run() external {
        address xbzz = vm.envAddress("XBZZ_ADDRESS");
        address treasuryOwner = vm.envAddress("TREASURY_OWNER");

        vm.startBroadcast();
        Treasury treasury = new Treasury(IERC20(xbzz), treasuryOwner);
        ProviderRegistry registry = new ProviderRegistry(IERC20(xbzz), address(treasury));
        JobEscrow escrow = new JobEscrow(IERC20(xbzz), registry);
        registry.setEscrow(address(escrow));
        vm.stopBroadcast();

        console2.log("Treasury        :", address(treasury));
        console2.log("ProviderRegistry:", address(registry));
        console2.log("JobEscrow       :", address(escrow));
    }
}
