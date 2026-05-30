// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {AgentVault} from "../src/AgentVault.sol";
import {PaymentSink} from "../src/PaymentSink.sol";

contract Deploy is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address agent = vm.addr(vm.envUint("AGENT_PRIVATE_KEY"));

        // Conservative testnet limits: 0.05 MNT per tx, 0.2 MNT per day.
        uint256 perTx = 0.05 ether;
        uint256 daily = 0.2 ether;

        vm.startBroadcast(deployerKey);
        AgentVault vault = new AgentVault(agent, perTx, daily);
        // seed the vault so the agent has something to act with
        (bool ok,) = address(vault).call{value: 0.2 ether}("");
        require(ok, "seed failed");

        PaymentSink sink = new PaymentSink();
        vault.setAllowedTarget(address(sink), true);
        vm.stopBroadcast();

        console.log("AgentVault deployed at:", address(vault));
        console.log("PaymentSink deployed at:", address(sink));
        console.log("Agent address:", agent);
        console.log("Deploy block:", block.number); // record this in shared/addresses.json
    }
}
