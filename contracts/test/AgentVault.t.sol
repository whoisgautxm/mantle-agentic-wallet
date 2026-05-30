// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentVault} from "../src/AgentVault.sol";
import {MockTarget} from "./mocks/MockTarget.sol";
import {MockReentrant} from "./mocks/MockReentrant.sol";

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

    function test_constructorRejectsZeroAgent() public {
        vm.expectRevert(AgentVault.ZeroAddress.selector);
        new AgentVault(address(0), PER_TX, DAILY);
    }

    function test_withdraw() public {
        uint256 vaultBefore = address(vault).balance;
        uint256 ownerBefore = address(this).balance;
        vault.withdraw(1 ether);
        assertEq(address(vault).balance, vaultBefore - 1 ether);
        assertEq(address(this).balance, ownerBefore + 1 ether);
    }

    function test_revertsWhenCallFails() public {
        target.setShouldRevert(true);
        vm.prank(agent);
        vm.expectRevert(bytes("call failed"));
        vault.execute(address(target), 0, _ping(1), "will fail");
    }

    function test_setAgentRotatesAgent() public {
        address newAgent = address(0xBEEF);
        vault.setAgent(newAgent);
        assertEq(vault.agent(), newAgent);
        // the old agent can no longer execute
        vm.prank(agent);
        vm.expectRevert(AgentVault.NotAgent.selector);
        vault.execute(address(target), 0, _ping(1), "old agent");
    }

    function test_setAgentRejectsZero() public {
        vm.expectRevert(AgentVault.ZeroAddress.selector);
        vault.setAgent(address(0));
    }

    function test_setLimits() public {
        vault.setLimits(2 ether, 5 ether);
        assertEq(vault.spendLimitPerTx(), 2 ether);
        assertEq(vault.dailyLimit(), 5 ether);
    }

    function test_reentrancyBlocked() public {
        MockReentrant evil = new MockReentrant(vault);
        vault.setAllowedTarget(address(evil), true);
        vm.prank(agent);
        // evil.attack re-enters execute as msg.sender=vault (not agent) -> NotAgent;
        // that inner revert makes the outer low-level call fail -> "call failed".
        vm.expectRevert(bytes("call failed"));
        vault.execute(address(evil), 0, abi.encodeWithSignature("attack(uint256)", 1), "trigger");
    }

    receive() external payable {}
}
