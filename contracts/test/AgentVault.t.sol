// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentVault} from "../src/AgentVault.sol";
import {MockTarget} from "./mocks/MockTarget.sol";
import {MockReentrant} from "./mocks/MockReentrant.sol";
import {MockGuardedTarget} from "./mocks/MockGuardedTarget.sol";
import {MockReentrantAgent} from "./mocks/MockReentrantAgent.sol";
import {MockDEX} from "../src/MockDEX.sol";
import {MockOracle} from "../src/MockOracle.sol";

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

    function test_executeGuarded_succeedsWhenErc20OutputMeetsMin() public {
        MockGuardedTarget guarded = new MockGuardedTarget();
        vault.setAllowedTarget(address(guarded), true);
        vault.setGuardedTarget(address(guarded), true);
        guarded.setTokenOutput(0.5 ether);
        address outputToken = address(guarded.token());
        bytes memory callData = abi.encodeCall(MockGuardedTarget.deliverToken, ());

        vm.expectEmit(true, true, false, true);
        emit AgentVault.AgentDecision(0, address(guarded), 0.1 ether, callData, "guarded buy");
        vm.expectEmit(true, true, true, true);
        emit AgentVault.AgentGuardedDecision(0, address(guarded), outputToken, 0.49 ether, 0.5 ether);
        vm.prank(agent);
        vault.executeGuarded(
            address(guarded),
            0.1 ether,
            callData,
            outputToken,
            0.49 ether,
            "guarded buy"
        );

        assertEq(guarded.token().balanceOf(address(vault)), 0.5 ether);
        assertEq(vault.spentToday(), 0.1 ether);
        assertEq(vault.nonce(), 1);
    }

    function test_executeGuarded_revertsWhenOutputBelowMin() public {
        MockGuardedTarget guarded = new MockGuardedTarget();
        vault.setAllowedTarget(address(guarded), true);
        guarded.setTokenOutput(0.4 ether);
        address outputToken = address(guarded.token());

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.InsufficientOutput.selector, 0.4 ether, 0.5 ether));
        vault.executeGuarded(
            address(guarded),
            0.1 ether,
            abi.encodeCall(MockGuardedTarget.deliverToken, ()),
            outputToken,
            0.5 ether,
            "bad output"
        );

        assertEq(guarded.token().balanceOf(address(vault)), 0);
        assertEq(vault.spentToday(), 0);
        assertEq(vault.nonce(), 0);
    }

    function test_redTeam_guardedTargetCannotBypassMinOutThroughLegacyExecute() public {
        MockGuardedTarget guarded = new MockGuardedTarget();
        vault.setAllowedTarget(address(guarded), true);
        vault.setGuardedTarget(address(guarded), true);
        guarded.setTokenOutput(1);

        uint256 vaultBalanceBefore = address(vault).balance;
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.GuardedExecutionRequired.selector, address(guarded)));
        vault.execute(
            address(guarded),
            0.1 ether,
            abi.encodeCall(MockGuardedTarget.deliverToken, ()),
            "compromised agent tries legacy bypass"
        );

        assertEq(address(vault).balance, vaultBalanceBefore);
        assertEq(guarded.token().balanceOf(address(vault)), 0);
        assertEq(vault.spentToday(), 0);
        assertEq(vault.nonce(), 0);
    }

    function test_executeGuarded_supportsNativeOutputForZeroValueCalls() public {
        MockGuardedTarget guarded = new MockGuardedTarget();
        vault.setAllowedTarget(address(guarded), true);
        (bool funded,) = address(guarded).call{value: 1 ether}("");
        require(funded, "target fund failed");
        guarded.setNativeOutput(0.75 ether);
        uint256 beforeBalance = address(vault).balance;

        vm.prank(agent);
        vault.executeGuarded(
            address(guarded),
            0,
            abi.encodeCall(MockGuardedTarget.deliverNative, ()),
            address(0),
            0.7 ether,
            "guarded sell"
        );

        assertEq(address(vault).balance, beforeBalance + 0.75 ether);
    }

    function test_executeGuarded_rejectsNativeOutputWhenSendingValue() public {
        MockGuardedTarget guarded = new MockGuardedTarget();
        vault.setAllowedTarget(address(guarded), true);

        vm.prank(agent);
        vm.expectRevert(AgentVault.NativeOutputWithValueUnsupported.selector);
        vault.executeGuarded(
            address(guarded),
            0.1 ether,
            abi.encodeCall(MockGuardedTarget.deliverNative, ()),
            address(0),
            1,
            "ambiguous native delta"
        );
    }

    function test_executeGuarded_rejectsZeroMinOutput() public {
        MockGuardedTarget guarded = new MockGuardedTarget();
        vault.setAllowedTarget(address(guarded), true);
        address outputToken = address(guarded.token());

        vm.prank(agent);
        vm.expectRevert(AgentVault.ZeroMinOutput.selector);
        vault.executeGuarded(
            address(guarded),
            0,
            abi.encodeCall(MockGuardedTarget.deliverToken, ()),
            outputToken,
            0,
            "unguarded output"
        );
    }

    function test_executeGuarded_stillEnforcesVaultLimits() public {
        MockGuardedTarget guarded = new MockGuardedTarget();
        bytes memory callData = abi.encodeCall(MockGuardedTarget.deliverToken, ());
        address outputToken = address(guarded.token());

        vm.prank(agent);
        vm.expectRevert(bytes("target not allowed"));
        vault.executeGuarded(address(guarded), 0, callData, outputToken, 1, "blocked");

        vault.setAllowedTarget(address(guarded), true);
        vault.setPaused(true);
        vm.prank(agent);
        vm.expectRevert(bytes("paused"));
        vault.executeGuarded(address(guarded), 0, callData, outputToken, 1, "blocked");

        vault.setPaused(false);
        vm.prank(agent);
        vm.expectRevert(bytes("over per-tx limit"));
        vault.executeGuarded(address(guarded), PER_TX + 1, callData, outputToken, 1, "blocked");

        vault.setLimits(PER_TX, 0);
        vm.prank(agent);
        vm.expectRevert(bytes("over daily limit"));
        vault.executeGuarded(address(guarded), 1, callData, outputToken, 1, "blocked");
    }

    function test_executeGuarded_reentrancyBlocked() public {
        MockReentrantAgent evil = new MockReentrantAgent();
        AgentVault guardedVault = new AgentVault(address(evil), PER_TX, DAILY);
        evil.setVault(guardedVault);
        guardedVault.setAllowedTarget(address(evil), true);
        (bool funded,) = address(evil).call{value: 1 ether}("");
        require(funded, "evil fund failed");

        vm.expectRevert(bytes("call failed"));
        evil.start();
        assertEq(guardedVault.nonce(), 0);
    }

    // --- Oracle-bound minOut (closes the "agent declares a low positive floor" gap) ---

    // NOTE: token address is hoisted into a local before vm.prank — evaluating address(dex.token())
    // inside the executeGuarded argument list would otherwise consume the prank (a Foundry gotcha).
    function _setupOracleDex(uint256 dexPrice, uint256 oraclePrice, uint256 maxDevBps)
        internal
        returns (MockDEX dex, address token)
    {
        dex = new MockDEX(dexPrice);
        (bool ok,) = address(dex).call{value: 5 ether}("");
        require(ok, "dex fund failed");
        token = address(dex.token());
        MockOracle oracle = new MockOracle(oraclePrice);
        vault.setAllowedTarget(address(dex), true);
        vault.setGuardedTarget(address(dex), true);
        vault.setOracle(address(oracle), token, maxDevBps);
    }

    function test_setOracle_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(AgentVault.NotOwner.selector);
        vault.setOracle(address(0x1234), address(0x5678), 500);
    }

    function test_oracleFloor_buy_rejectsFloorBelowOracle() public {
        (MockDEX dex, address token) = _setupOracleDex(0.2 ether, 0.2 ether, 500); // 5% tolerance
        bytes memory buyData = abi.encodeCall(MockDEX.buy, ());
        // value 0.1 -> oracle expects 0.5 token; floor = 0.475. minOut 0.4 < floor -> revert.
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.OracleFloorTooLow.selector, 0.4 ether, 0.475 ether));
        vault.executeGuarded(address(dex), 0.1 ether, buyData, token, 0.4 ether, "lowball buy");
    }

    function test_oracleFloor_buy_acceptsFairFloor() public {
        (MockDEX dex, address token) = _setupOracleDex(0.2 ether, 0.2 ether, 500);
        bytes memory buyData = abi.encodeCall(MockDEX.buy, ());
        vm.prank(agent);
        vault.executeGuarded(address(dex), 0.1 ether, buyData, token, 0.475 ether, "fair buy");
        assertEq(dex.token().balanceOf(address(vault)), 0.5 ether);
    }

    function test_oracleFloor_sell_rejectsFloorBelowOracle() public {
        (MockDEX dex, address token) = _setupOracleDex(0.2 ether, 0.2 ether, 500);
        bytes memory buyData = abi.encodeCall(MockDEX.buy, ());
        vm.prank(agent);
        vault.executeGuarded(address(dex), 0.1 ether, buyData, token, 0.475 ether, "buy");
        // sell 0.5 token -> oracle expects 0.1 MNT; floor 0.095. minOut 0.05 < floor -> revert.
        bytes memory sellData = abi.encodeCall(MockDEX.sell, (0.5 ether));
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentVault.OracleFloorTooLow.selector, 0.05 ether, 0.095 ether));
        vault.executeGuarded(address(dex), 0, sellData, address(0), 0.05 ether, "lowball sell");
    }

    function test_oracleFloor_sell_acceptsFairFloor() public {
        (MockDEX dex, address token) = _setupOracleDex(0.2 ether, 0.2 ether, 500);
        bytes memory buyData = abi.encodeCall(MockDEX.buy, ());
        vm.prank(agent);
        vault.executeGuarded(address(dex), 0.1 ether, buyData, token, 0.475 ether, "buy");
        uint256 beforeBal = address(vault).balance;
        bytes memory sellData = abi.encodeCall(MockDEX.sell, (0.5 ether));
        vm.prank(agent);
        vault.executeGuarded(address(dex), 0, sellData, address(0), 0.095 ether, "fair sell");
        assertEq(address(vault).balance, beforeBal + 0.1 ether);
    }

    function test_oracleFloor_disabledWhenUnset() public {
        // No setOracle -> caller floor only (backward compatible). A tiny minOut is accepted.
        MockDEX dex = new MockDEX(0.2 ether);
        (bool ok,) = address(dex).call{value: 5 ether}("");
        require(ok, "fund failed");
        address token = address(dex.token());
        vault.setAllowedTarget(address(dex), true);
        vault.setGuardedTarget(address(dex), true);
        bytes memory buyData = abi.encodeCall(MockDEX.buy, ());
        vm.prank(agent);
        vault.executeGuarded(address(dex), 0.1 ether, buyData, token, 1, "no oracle");
        assertEq(dex.token().balanceOf(address(vault)), 0.5 ether);
    }

    receive() external payable {}
}
