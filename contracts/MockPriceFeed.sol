// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockPriceFeed {
    mapping(address => uint256) public prices;

    function setPrice(address asset, uint256 price) external {
        prices[asset] = price;
    }

    function latestAnswer(address asset) external view returns (uint256) {
        return prices[asset];
    }
}