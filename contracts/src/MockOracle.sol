// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal owner-set price oracle used to bound guarded trade floors on-chain.
///         priceWei is MNT wei per 1 whole token (1e18 token units) — same convention as MockDEX.
contract MockOracle {
    address public owner;
    uint256 public priceWei;

    event PriceSet(uint256 priceWei);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(uint256 _priceWei) {
        require(_priceWei > 0, "price=0");
        owner = msg.sender;
        priceWei = _priceWei;
        emit PriceSet(_priceWei);
    }

    function setPrice(uint256 _priceWei) external onlyOwner {
        require(_priceWei > 0, "price=0");
        priceWei = _priceWei;
        emit PriceSet(_priceWei);
    }
}
