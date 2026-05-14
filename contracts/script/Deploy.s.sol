// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Script.sol";
import {IERC20} from "../src/IERC20.sol";
import {ProviderRegistry} from "../src/ProviderRegistry.sol";
import {JobEscrow} from "../src/JobEscrow.sol";
import {Treasury} from "../src/Treasury.sol";

/// @notice Deploys Treasury → ProviderRegistry → JobEscrow, then binds the
///         escrow into the registry.
///
/// Env:
///   XBZZ_ADDRESS    — ERC-20 address of xBZZ on the target chain.
///   TREASURY_OWNER  — optional. Multisig controlling the treasury. Defaults
///                     to the deployer address (tx.origin) for solo/testnet
///                     setups so you don't need to know it ahead of time.
contract DeployScript is Script {
    function run() external {
        address xbzz = vm.envAddress("XBZZ_ADDRESS");
        address treasuryOwner = vm.envOr("TREASURY_OWNER", tx.origin);

        vm.startBroadcast();
        Treasury treasury = new Treasury(IERC20(xbzz), treasuryOwner);
        ProviderRegistry registry = new ProviderRegistry(IERC20(xbzz), address(treasury));
        JobEscrow escrow = new JobEscrow(IERC20(xbzz), registry);
        registry.setEscrow(address(escrow));
        vm.stopBroadcast();

        console2.log("Deployer        :", tx.origin);
        console2.log("Treasury owner  :", treasuryOwner);
        console2.log("XBZZ_ADDRESS    :", xbzz);
        console2.log("Treasury        :", address(treasury));
        console2.log("ProviderRegistry:", address(registry));
        console2.log("JobEscrow       :", address(escrow));
    }
}
