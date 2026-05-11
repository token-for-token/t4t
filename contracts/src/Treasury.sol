// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "./IERC20.sol";

/// @title  Treasury
/// @notice Holding contract for slashed remainders. Multi-sig owned in
///         production. v1 is intentionally minimal — see `docs/spec.md` §4.3.
contract Treasury {
    IERC20 public immutable xbzz;
    address public owner;

    event Withdrawn(address indexed to, uint128 amount);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error TransferFailed();
    error ZeroAddress();

    constructor(IERC20 _xbzz, address _owner) {
        if (_owner == address(0)) revert ZeroAddress();
        xbzz = _xbzz;
        owner = _owner;
        emit OwnershipTransferred(address(0), _owner);
    }

    function withdraw(address to, uint128 amount) external {
        if (msg.sender != owner) revert NotOwner();
        if (!xbzz.transfer(to, amount)) revert TransferFailed();
        emit Withdrawn(to, amount);
    }

    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert NotOwner();
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
