// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Minimal recipient the agent can pay, to demonstrate a real on-chain action.
contract PaymentSink {
    event Received(address indexed from, uint256 amount, string memo);

    function pay(string calldata memo) external payable {
        emit Received(msg.sender, msg.value, memo);
    }
}
