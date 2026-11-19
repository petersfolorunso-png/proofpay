// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ProofPayEscrow} from "../src/ProofPayEscrow.sol";

/// Usage (key comes from env, never from the command line):
///   TOKEN=0x4565...3483 AGENT=0x... OWNER=0x... forge script script/Deploy.s.sol \
///     --rpc-url https://rpc-test.qday.info --private-key $AEVUM_PRIVATE_KEY --broadcast --legacy
contract Deploy is Script {
    function run() external returns (ProofPayEscrow esc) {
        address token = vm.envAddress("TOKEN");
        address owner = vm.envOr("OWNER", msg.sender);
        address agent = vm.envAddress("AGENT");
        uint96 cap = uint96(vm.envOr("AGENT_RELEASE_CAP", uint256(100e6))); // 100 tUSD8
        uint96 maxJob = uint96(vm.envOr("MAX_JOB_AMOUNT", uint256(1_000e6))); // 1,000 tUSD8
        vm.startBroadcast();
        esc = new ProofPayEscrow(IERC20(token), owner, agent, cap, maxJob);
        vm.stopBroadcast();
        console2.log("ProofPayEscrow", address(esc));
    }
}

/// Local-only helper: deploys a 6-decimal mock tUSD8 for anvil end-to-end tests.
contract DeployMockToken is Script {
    function run() external returns (address token) {
        vm.startBroadcast();
        token = address(new MockUSDLocal());
        vm.stopBroadcast();
        console2.log("MockUSD", token);
    }
}

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockUSDLocal is ERC20 {
    constructor() ERC20("Local tUSD8", "tUSD8") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
