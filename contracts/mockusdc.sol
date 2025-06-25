// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {
        _mint(msg.sender, 0); // Initial supply can be 0; mint later as needed
    }

    // Function to mint tokens for testing
    function mint(address to, uint256 amount) public {
        _mint(to, amount);
    }

    // Override decimals to match USDC (6 decimals)
    function decimals() public pure override returns (uint8) {
        return 6;
    }
}