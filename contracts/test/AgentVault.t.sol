// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentVault} from "../src/AgentVault.sol";
import {MockTarget} from "./mocks/MockTarget.sol";

contract AgentVaultTest is Test {
    AgentVault vault;
    MockTarget target;

    address owner = address(this);
    address agent = address(0xA6E27);
    address stranger = address(0xBAD);

    uint256 constant PER_TX = 1 ether;
    uint256 constant DAILY = 3 ether;

    function setUp() public {
        vault = new AgentVault(agent, PER_TX, DAILY);
        target = new MockTarget();
        vault.setAllowedTarget(address(target), true);
        (bool ok,) = address(vault).call{value: 10 ether}("");
        require(ok, "fund failed");
    }

    function _ping(uint256 x) internal pure returns (bytes memory) {
        return abi.encodeWithSignature("ping(uint256)", x);
    }

    function test_onlyAgentCanExecute() public {
        vm.prank(stranger);
        vm.expectRevert(AgentVault.NotAgent.selector);
        vault.execute(address(target), 0, _ping(1), "should fail");
    }

    function test_agentCanExecuteAllowedTarget() public {
        vm.prank(agent);
        vault.execute(address(target), 0.5 ether, _ping(21), "buy");
        assertEq(target.lastValue(), 0.5 ether);
    }

    function test_revertsOverPerTxLimit() public {
        vm.prank(agent);
        vm.expectRevert(bytes("over per-tx limit"));
        vault.execute(address(target), PER_TX + 1, _ping(1), "too big");
    }

    function test_revertsOverDailyLimit() public {
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(agent);
            vault.execute(address(target), 1 ether, _ping(1), "ok");
        }
        vm.prank(agent);
        vm.expectRevert(bytes("over daily limit"));
        vault.execute(address(target), 1, _ping(1), "over");
    }

    function test_dailyLimitResetsAfter24h() public {
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(agent);
            vault.execute(address(target), 1 ether, _ping(1), "max");
        }
        assertEq(vault.spentToday(), 3 ether);
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(agent);
        vault.execute(address(target), 1 ether, _ping(1), "next window");
        assertEq(vault.spentToday(), 1 ether);
    }

    function test_revertsWhenPaused() public {
        vault.setPaused(true);
        vm.prank(agent);
        vm.expectRevert(bytes("paused"));
        vault.execute(address(target), 0, _ping(1), "blocked");
    }

    function test_revertsDisallowedTarget() public {
        MockTarget other = new MockTarget();
        vm.prank(agent);
        vm.expectRevert(bytes("target not allowed"));
        vault.execute(address(other), 0, _ping(1), "not allowed");
    }

    function test_emitsAgentDecisionWithRationale() public {
        vm.expectEmit(true, true, false, true);
        emit AgentVault.AgentDecision(0, address(target), 0.1 ether, _ping(7), "rebalance");
        vm.prank(agent);
        vault.execute(address(target), 0.1 ether, _ping(7), "rebalance");
    }
}
