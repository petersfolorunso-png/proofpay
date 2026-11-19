// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockUSD is ERC20 {
    constructor() ERC20("Test USD", "tUSD8") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Token that tries to re-enter the escrow on every transfer out of the escrow.
contract ReentrantToken is MockUSD {
    address public escrow;
    bytes public payload;
    bool public attempted;
    bool public reentered;

    function arm(address escrow_, bytes calldata payload_) external {
        escrow = escrow_;
        payload = payload_;
    }

    /// @dev Lets the token contract itself act as an escrow client in tests.
    function act(address target, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        require(ok, "act failed");
        return ret;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (from == escrow && escrow != address(0) && !attempted) {
            attempted = true;
            (bool ok,) = escrow.call(payload);
            reentered = ok;
        }
    }
}

/// @dev Burns 1% on transfer.
contract FeeToken is MockUSD {
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0xdead), fee);
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}
