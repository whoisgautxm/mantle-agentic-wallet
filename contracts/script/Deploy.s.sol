// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {AgentVault} from "../src/AgentVault.sol";
import {MockDEX} from "../src/MockDEX.sol";
import {MockOracle} from "../src/MockOracle.sol";

contract Deploy is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address aiAgent = vm.addr(vm.envUint("AGENT_PRIVATE_KEY"));
        address baselineAgent = vm.addr(vm.envUint("BASELINE_PRIVATE_KEY"));

        // Demo limits: roomy enough for a long live run (many trades) while still bounded.
        uint256 perTx = 0.1 ether;
        uint256 daily = 5 ether;
        uint256 startPrice = 2 ether; // 2 MNT per token

        vm.startBroadcast(deployerKey);
        MockDEX dex = new MockDEX(startPrice);
        (bool okDex,) = address(dex).call{value: 3 ether}(""); // liquidity to pay out sells
        require(okDex, "dex seed failed");

        // Independent on-chain price reference for guarded-trade floors (kept in sync by the keeper).
        MockOracle oracle = new MockOracle(startPrice);
        address tradedToken = address(dex.token());
        uint256 maxOracleDeviationBps = 500; // declared minOut may sit up to 5% below oracle-fair

        AgentVault aiVault = new AgentVault(aiAgent, perTx, daily);
        (bool okAi,) = address(aiVault).call{value: 1 ether}(""); // equal starting capital
        require(okAi, "ai seed failed");
        aiVault.setAllowedTarget(address(dex), true);
        aiVault.setGuardedTarget(address(dex), true);
        aiVault.setOracle(address(oracle), tradedToken, maxOracleDeviationBps);

        AgentVault baselineVault = new AgentVault(baselineAgent, perTx, daily);
        (bool okBaseline,) = address(baselineVault).call{value: 1 ether}(""); // equal starting capital
        require(okBaseline, "baseline seed failed");
        baselineVault.setAllowedTarget(address(dex), true);
        baselineVault.setGuardedTarget(address(dex), true);
        baselineVault.setOracle(address(oracle), tradedToken, maxOracleDeviationBps);
        vm.stopBroadcast();

        console.log("MockDEX deployed at:", address(dex));
        console.log("MockOracle deployed at:", address(oracle));
        console.log("MockToken deployed at:", address(dex.token()));
        console.log("AI AgentVault deployed at:", address(aiVault));
        console.log("Baseline AgentVault deployed at:", address(baselineVault));
        console.log("AI agent address:", aiAgent);
        console.log("Baseline agent address:", baselineAgent);
        console.log("Deploy block:", block.number); // record this in shared/addresses.json
    }
}
