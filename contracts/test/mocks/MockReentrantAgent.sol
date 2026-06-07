// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AgentVault} from "../../src/AgentVault.sol";

contract MockReentrantAgent {
    AgentVault public vault;

    function setVault(AgentVault _vault) external {
        vault = _vault;
    }

    function start() external {
        vault.executeGuarded(
            address(this),
            0,
            abi.encodeWithSignature("callback()"),
            address(0),
            1,
            "outer guarded call"
        );
    }

    function callback() external {
        vault.executeGuarded(address(this), 0, "", address(0), 0, "reentrant guarded call");
        (bool ok,) = msg.sender.call{value: 1}("");
        require(ok, "return failed");
    }

    receive() external payable {}
}
