// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AgentVault} from "../../src/AgentVault.sol";

contract MockReentrant {
    AgentVault public vault;

    constructor(AgentVault _vault) {
        vault = _vault;
    }

    // Tries to re-enter the vault. Because msg.sender here is the vault (not the agent),
    // the nested execute reverts with NotAgent.
    function attack(uint256) external payable {
        vault.execute(address(this), 0, "", "reentry");
    }

    receive() external payable {}
}
