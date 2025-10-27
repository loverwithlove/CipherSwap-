// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// Minimal mock of UniswapV2Router required for tests.
contract MockUniswapV2Router {
    uint256 public rateNumerator = 1;
    uint256 public rateDenominator = 1;

    function setRate(uint256 numerator, uint256 denominator) external {
        require(denominator != 0, "denom");
        rateNumerator = numerator;
        rateDenominator = denominator;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 /* amountOutMin */,
        address[] calldata path,
        address to,
        uint256 /*deadline*/
    ) external returns (uint256[] memory amounts) {
        require(path.length >= 2, "bad path");
        address tokenIn = path[0];
        address tokenOut = path[path.length - 1];

        require(IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn), "transferFrom in");
        uint256 amountOut = (amountIn * rateNumerator) / rateDenominator;
        require(IERC20(tokenOut).transfer(to, amountOut), "transfer out");

        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = amountOut;
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts) {
        require(path.length >= 2, "bad path");
        uint256 amountOut = (amountIn * rateNumerator) / rateDenominator;
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = amountOut;
    }
}
