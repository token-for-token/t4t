// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Script.sol";
import {IERC20} from "../src/IERC20.sol";
import {ProviderRegistry} from "../src/ProviderRegistry.sol";
import {JobEscrow} from "../src/JobEscrow.sol";

/// @notice Deploys ProviderRegistry → JobEscrow, then binds the escrow into
///         the registry. Slashed stake is burned (sent to
///         `ProviderRegistry.BURN_ADDRESS`); no protocol treasury exists.
///
/// Env:
///   XBZZ_ADDRESS — ERC-20 address of xBZZ on the target chain.
contract DeployScript is Script {
    function run() external {
        address xbzz = vm.envAddress("XBZZ_ADDRESS");

        vm.startBroadcast();
        ProviderRegistry registry = new ProviderRegistry(IERC20(xbzz));
        JobEscrow escrow = new JobEscrow(IERC20(xbzz), registry);
        registry.setEscrow(address(escrow));
        vm.stopBroadcast();

        console2.log("Deployer        :", tx.origin);
        console2.log("XBZZ_ADDRESS    :", xbzz);
        console2.log("ProviderRegistry:", address(registry));
        console2.log("JobEscrow       :", address(escrow));
        console2.log("BURN_ADDRESS    :", registry.BURN_ADDRESS());
    }
}
