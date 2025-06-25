// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./MockPriceFeed.sol";

contract Lend {
    address public immutable usdc;
    address public immutable dai;
    address public immutable weth;

    MockPriceFeed public priceFeed;

    struct ReserveData {
        uint256 availableLiquidity;
        uint256 totalBorrows;
        uint256 liquidityRate;
        uint256 borrowRate;
        bool isActive;
        uint256 ltv;
        uint256 liquidationThreshold;
        uint256 decimals;
    }

    mapping(address => ReserveData) public reserves;
    address[] public reserveList;

    struct UserData {
        uint256 totalCollateralUSD;
        uint256 totalDebtUSD;
        uint256 availableBorrowsUSD;
        uint256 currentLiquidationThreshold;
        uint256 ltv;
        uint256 healthFactor;
    }

    mapping(address => mapping(address => uint256)) public userSupplyBalances;
    mapping(address => mapping(address => uint256)) public userBorrowBalances;

    uint256 public constant LIQUIDATION_BONUS = 10500;
    uint256 public constant HEALTH_FACTOR_PRECISION = 1e18;
    uint256 public constant USD_PRECISION = 8;

    event Supply(address indexed user, address indexed asset, uint256 amount);
    event Borrow(address indexed user, address indexed asset, uint256 amount);
    event Repay(address indexed user, address indexed asset, uint256 amount);
    event Withdraw(address indexed user, address indexed asset, uint256 amount);
    event Liquidation(address indexed user, address indexed collateralAsset, address indexed debtAsset, uint256 debtToCover, uint256 liquidatedCollateralAmount);

    constructor(address _usdc, address _dai, address _weth, address _priceFeed) {
        usdc = _usdc;
        dai = _dai;
        weth = _weth;
        priceFeed = MockPriceFeed(_priceFeed);

        _initializeReserve(_usdc, 6, 7500, 8000);
        _initializeReserve(_dai, 18, 7500, 8000);
        _initializeReserve(_weth, 18, 8000, 8500);
    }

    function _initializeReserve(address asset, uint256 decimals, uint256 ltv, uint256 liquidationThreshold) internal {
        reserves[asset] = ReserveData({
            availableLiquidity: 0,
            totalBorrows: 0,
            liquidityRate: 0,
            borrowRate: 0,
            isActive: true,
            ltv: ltv,
            liquidationThreshold: liquidationThreshold,
            decimals: decimals
        });
        reserveList.push(asset);
    }

    function supply(address asset, uint256 amount, address onBehalfOf) external {
        require(reserves[asset].isActive, "Reserve not active");
        require(amount > 0, "Amount must be greater than 0");

        IERC20(asset).transferFrom(msg.sender, address(this), amount);

        userSupplyBalances[onBehalfOf][asset] = userSupplyBalances[onBehalfOf][asset] + amount;
        reserves[asset].availableLiquidity = reserves[asset].availableLiquidity + amount;

        emit Supply(onBehalfOf, asset, amount);
    }

    function borrow(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) external {
        require(reserves[asset].isActive, "Reserve not active");
        require(amount > 0, "Amount must be greater than 0");
        require(interestRateMode == 0, "Only variable rate supported");

        UserData memory userData = getUserAccountData(onBehalfOf);
        uint256 amountInUSD = getAssetValueUSD(asset, amount);
        require(userData.availableBorrowsUSD >= amountInUSD, "Insufficient borrowing power");

        userBorrowBalances[onBehalfOf][asset] = userBorrowBalances[onBehalfOf][asset] + amount;
        reserves[asset].availableLiquidity = reserves[asset].availableLiquidity - amount;
        reserves[asset].totalBorrows = reserves[asset].totalBorrows + amount;

        IERC20(asset).transfer(onBehalfOf, amount);

        UserData memory updatedUserData = getUserAccountData(onBehalfOf);
        require(updatedUserData.healthFactor > HEALTH_FACTOR_PRECISION, "Health factor too low");

        emit Borrow(onBehalfOf, asset, amount);
    }

    function repay(address asset, uint256 amount, address onBehalfOf) external {
        require(reserves[asset].isActive, "Reserve not active");
        require(amount > 0, "Amount must be greater than 0");
        require(userBorrowBalances[onBehalfOf][asset] >= amount, "Insufficient debt");

        IERC20(asset).transferFrom(msg.sender, address(this), amount);

        userBorrowBalances[onBehalfOf][asset] = userBorrowBalances[onBehalfOf][asset] - amount;
        reserves[asset].availableLiquidity = reserves[asset].availableLiquidity + amount;
        reserves[asset].totalBorrows = reserves[asset].totalBorrows - amount;

        emit Repay(onBehalfOf, asset, amount);
    }

    function withdraw(address asset, uint256 amount, address to) external {
        require(reserves[asset].isActive, "Reserve not active");
        require(amount > 0, "Amount must be greater than 0");
        require(userSupplyBalances[msg.sender][asset] >= amount, "Insufficient balance");

        userSupplyBalances[msg.sender][asset] = userSupplyBalances[msg.sender][asset] - amount;
        reserves[asset].availableLiquidity = reserves[asset].availableLiquidity - amount;

        IERC20(asset).transfer(to, amount);

        UserData memory userData = getUserAccountData(msg.sender);
        require(userData.healthFactor > HEALTH_FACTOR_PRECISION, "Health factor too low");

        emit Withdraw(msg.sender, asset, amount);
    }

    function liquidate(address user, address collateralAsset, address debtAsset, uint256 debtToCover) external {
        UserData memory userData = getUserAccountData(user);
        require(userData.healthFactor < HEALTH_FACTOR_PRECISION, "User not liquidatable");

        uint256 collateralAmount = calculateCollateralToLiquidate(collateralAsset, debtAsset, debtToCover);
        require(userSupplyBalances[user][collateralAsset] >= collateralAmount, "Insufficient collateral");

        IERC20(debtAsset).transferFrom(msg.sender, address(this), debtToCover);
        userBorrowBalances[user][debtAsset] = userBorrowBalances[user][debtAsset] - debtToCover;
        reserves[debtAsset].availableLiquidity = reserves[debtAsset].availableLiquidity + debtToCover;
        reserves[debtAsset].totalBorrows = reserves[debtAsset].totalBorrows - debtToCover;

        userSupplyBalances[user][collateralAsset] = userSupplyBalances[user][collateralAsset] - collateralAmount;
        reserves[collateralAsset].availableLiquidity = reserves[collateralAsset].availableLiquidity - collateralAmount;

        IERC20(collateralAsset).transfer(msg.sender, collateralAmount);

        emit Liquidation(user, collateralAsset, debtAsset, debtToCover, collateralAmount);
    }

    function getUserAccountData(address user) public view returns (UserData memory) {
        UserData memory data;

        for (uint256 i = 0; i < reserveList.length; i++) {
            address asset = reserveList[i];
            uint256 supplyBalance = userSupplyBalances[user][asset];
            uint256 borrowBalance = userBorrowBalances[user][asset];

            if (supplyBalance > 0) {
                uint256 valueUSD = getAssetValueUSD(asset, supplyBalance);
                data.totalCollateralUSD = data.totalCollateralUSD + valueUSD;
                data.currentLiquidationThreshold = data.currentLiquidationThreshold + (valueUSD * reserves[asset].liquidationThreshold) / 10000;
                data.ltv = data.ltv + (valueUSD * reserves[asset].ltv) / 10000;
            }

            if (borrowBalance > 0) {
                data.totalDebtUSD = data.totalDebtUSD + getAssetValueUSD(asset, borrowBalance);
            }
        }

        if (data.totalCollateralUSD > 0) {
            data.availableBorrowsUSD = ((data.totalCollateralUSD * data.ltv) / 10000) - data.totalDebtUSD;
            if (data.totalDebtUSD > 0) {
                data.healthFactor = ((data.totalCollateralUSD * data.currentLiquidationThreshold) / 10000) * HEALTH_FACTOR_PRECISION / data.totalDebtUSD;
            } else {
                data.healthFactor = type(uint256).max;
            }
        } else {
            data.healthFactor = type(uint256).max;
        }

        return data;
    }

    function getAssetValueUSD(address asset, uint256 amount) public view returns (uint256) {
        uint256 price = priceFeed.latestAnswer(asset);
        return (amount * price) / (10 ** reserves[asset].decimals);
    }

    function calculateCollateralToLiquidate(address collateralAsset, address debtAsset, uint256 debtToCover) public view returns (uint256) {
        uint256 debtValueUSD = getAssetValueUSD(debtAsset, debtToCover);
        uint256 collateralPrice = priceFeed.latestAnswer(collateralAsset);
        uint256 collateralAmount = ((debtValueUSD * LIQUIDATION_BONUS) / 10000) * (10 ** reserves[collateralAsset].decimals) / collateralPrice;
        return collateralAmount;
    }

    function getUserSupplyBalance(address asset, address user) external view returns (uint256) {
        return userSupplyBalances[user][asset];
    }

    function getUserBorrowBalance(address asset, address user) external view returns (uint256) {
        return userBorrowBalances[user][asset];
    }
}