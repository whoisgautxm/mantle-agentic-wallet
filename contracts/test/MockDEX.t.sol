// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockDEX} from "../src/MockDEX.sol";

contract MockDEXTest is Test {
    MockDEX dex;
    address user = address(0xA11CE);

    uint256 constant PRICE = 2 ether; // 2 MNT per token

    function setUp() public {
        dex = new MockDEX(PRICE);
        (bool ok,) = address(dex).call{value: 100 ether}("");
        require(ok, "seed failed");
        vm.deal(user, 10 ether);
    }

    function test_buyCreditsTokensAtPrice() public {
        vm.prank(user);
        dex.buy{value: 1 ether}();
        assertEq(dex.tokenBalance(user), 0.5 ether);
    }

    function test_sellReturnsMntAtPrice() public {
        vm.prank(user);
        dex.buy{value: 2 ether}();

        uint256 beforeBalance = user.balance;
        vm.prank(user);
        dex.sell(1 ether);

        assertEq(dex.tokenBalance(user), 0);
        assertEq(user.balance, beforeBalance + 2 ether);
    }

    function test_buyRejectsZeroValue() public {
        vm.prank(user);
        vm.expectRevert(bytes("no value"));
        dex.buy{value: 0}();
    }

    function test_buyRejectsAmountTooSmallForTokenPrecision() public {
        dex.setPrice(2 ether);
        vm.prank(user);
        vm.expectRevert(bytes("amount too small"));
        dex.buy{value: 1 wei}();
    }

    function test_sellRejectsZeroAmount() public {
        vm.prank(user);
        vm.expectRevert(bytes("amount=0"));
        dex.sell(0);
    }

    function test_sellRevertsOnInsufficientTokens() public {
        vm.prank(user);
        vm.expectRevert(bytes("insufficient tokens"));
        dex.sell(1 ether);
    }

    function test_sellRevertsOnInsufficientLiquidity() public {
        MockDEX shallowDex = new MockDEX(PRICE);
        vm.deal(user, 10 ether);
        vm.prank(user);
        shallowDex.buy{value: 2 ether}();
        shallowDex.setPrice(4 ether);

        vm.prank(user);
        vm.expectRevert(bytes("insufficient liquidity"));
        shallowDex.sell(1 ether);
    }

    function test_setPriceOnlyOwner() public {
        vm.prank(user);
        vm.expectRevert(bytes("not owner"));
        dex.setPrice(3 ether);
    }

    function test_setPriceRejectsZero() public {
        vm.expectRevert(bytes("price=0"));
        dex.setPrice(0);
    }

    function test_priceChangeAffectsBuyAmount() public {
        dex.setPrice(4 ether);
        vm.prank(user);
        dex.buy{value: 4 ether}();
        assertEq(dex.tokenBalance(user), 1 ether);
    }

    function test_constructorRejectsZeroPrice() public {
        vm.expectRevert(bytes("price=0"));
        new MockDEX(0);
    }
}
