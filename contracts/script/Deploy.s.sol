// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {AgentVault} from "../src/AgentVault.sol";
import {MockDEX} from "../src/MockDEX.sol";

contract Deploy is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address aiAgent = vm.addr(vm.envUint("AGENT_PRIVATE_KEY"));
        address baselineAgent = vm.addr(vm.envUint("BASELINE_PRIVATE_KEY"));

        // Conservative testnet limits: 0.05 MNT per tx, 0.2 MNT per day.
        uint256 perTx = 0.05 ether;
        uint256 daily = 0.2 ether;
        uint256 startPrice = 2 ether; // 2 MNT per token

        vm.startBroadcast(deployerKey);
        MockDEX dex = new MockDEX(startPrice);
        (bool okDex,) = address(dex).call{value: 0.5 ether}("");
        require(okDex, "dex seed failed");

        AgentVault aiVault = new AgentVault(aiAgent, perTx, daily);
        (bool okAi,) = address(aiVault).call{value: 0.2 ether}("");
        require(okAi, "ai seed failed");
        aiVault.setAllowedTarget(address(dex), true);

        AgentVault baselineVault = new AgentVault(baselineAgent, perTx, daily);
        (bool okBaseline,) = address(baselineVault).call{value: 0.2 ether}("");
        require(okBaseline, "baseline seed failed");
        baselineVault.setAllowedTarget(address(dex), true);
        vm.stopBroadcast();

        console.log("MockDEX deployed at:", address(dex));
        console.log("AI AgentVault deployed at:", address(aiVault));
        console.log("Baseline AgentVault deployed at:", address(baselineVault));
        console.log("AI agent address:", aiAgent);
        console.log("Baseline agent address:", baselineAgent);
        console.log("Deploy block:", block.number); // record this in shared/addresses.json
    }
}
