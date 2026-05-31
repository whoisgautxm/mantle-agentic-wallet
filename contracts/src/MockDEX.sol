// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MockDEX
/// @notice Self-contained swap venue with an internal token ledger and owner-set price.
///         Buying sends MNT and credits tokens; selling debits tokens and returns MNT.
contract MockDEX {
    address public owner;
    uint256 public price; // MNT wei per 1 whole token (1e18 token units)
    mapping(address => uint256) public tokenBalance;

    event PriceSet(uint256 price);
    event Bought(address indexed who, uint256 mntIn, uint256 tokensOut, uint256 price);
    event Sold(address indexed who, uint256 tokensIn, uint256 mntOut, uint256 price);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(uint256 _price) {
        require(_price > 0, "price=0");
        owner = msg.sender;
        price = _price;
        emit PriceSet(_price);
    }

    receive() external payable {}

    function setPrice(uint256 _price) external onlyOwner {
        require(_price > 0, "price=0");
        price = _price;
        emit PriceSet(_price);
    }

    function buy() external payable {
        require(msg.value > 0, "no value");
        uint256 tokensOut = (msg.value * 1e18) / price;
        require(tokensOut > 0, "amount too small");
        tokenBalance[msg.sender] += tokensOut;
        emit Bought(msg.sender, msg.value, tokensOut, price);
    }

    function sell(uint256 tokenAmount) external {
        require(tokenAmount > 0, "amount=0");
        require(tokenBalance[msg.sender] >= tokenAmount, "insufficient tokens");
        uint256 mntOut = (tokenAmount * price) / 1e18;
        require(address(this).balance >= mntOut, "insufficient liquidity");

        tokenBalance[msg.sender] -= tokenAmount;
        emit Sold(msg.sender, tokenAmount, mntOut, price);

        (bool ok,) = msg.sender.call{value: mntOut}("");
        require(ok, "mnt transfer failed");
    }
}
