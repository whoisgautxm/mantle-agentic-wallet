// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockTarget {
    uint256 public lastValue;
    bytes public lastData;
    bool public shouldRevert;

    function setShouldRevert(bool v) external { shouldRevert = v; }

    function ping(uint256 x) external payable returns (uint256) {
        require(!shouldRevert, "MockTarget: forced revert");
        lastValue = msg.value;
        lastData = msg.data;
        return x * 2;
    }

    receive() external payable {}
}
