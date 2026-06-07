// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockOutputToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }
}

contract MockGuardedTarget {
    MockOutputToken public immutable token;
    uint256 public tokenOutput;
    uint256 public nativeOutput;

    constructor() {
        token = new MockOutputToken();
    }

    receive() external payable {}

    function setTokenOutput(uint256 amount) external {
        tokenOutput = amount;
    }

    function setNativeOutput(uint256 amount) external {
        nativeOutput = amount;
    }

    function deliverToken() external payable {
        token.mint(msg.sender, tokenOutput);
    }

    function deliverNative() external {
        (bool ok,) = msg.sender.call{value: nativeOutput}("");
        require(ok, "native output failed");
    }
}
