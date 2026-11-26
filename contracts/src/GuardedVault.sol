// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The one function a consumer needs from StockGuardRegistry.
interface IStockGuard {
    function isHealthy(address asset) external view returns (bool);
}

/// @title GuardedVault — example consumer of the StockGuard circuit breaker
/// @notice Shows how a lending market or LP vault would integrate StockGuard: risky actions on a
///         tokenized stock (accepting it as collateral, opening a position) are refused while the
///         asset is unhealthy, and allowed again once the breaker clears. Bookkeeping only — no tokens
///         move, so it can be exercised on testnet without funds.
/// @dev Fails closed: if the registry cannot be read, the action is refused.
contract GuardedVault {
    IStockGuard public immutable guard;

    mapping(address user => mapping(address asset => uint256 amount)) public collateral;

    event CollateralAccepted(address indexed user, address indexed asset, uint256 amount);
    event CollateralRefused(address indexed user, address indexed asset, uint256 amount);

    error AssetUnhealthy(address asset);
    error GuardUnavailable(address asset);
    error ZeroAmount();

    constructor(IStockGuard guard_) {
        guard = guard_;
    }

    /// @notice The integration: three lines in the consumer's own function.
    modifier whenHealthy(address asset) {
        if (!_healthy(asset)) revert AssetUnhealthy(asset);
        _;
    }

    /// @notice Record collateral in a tokenized stock. Reverts while the StockGuard breaker is tripped.
    function depositCollateral(address asset, uint256 amount) external whenHealthy(asset) {
        if (amount == 0) revert ZeroAmount();
        collateral[msg.sender][asset] += amount;
        emit CollateralAccepted(msg.sender, asset, amount);
    }

    /// @notice Non-reverting variant: leaves an on-chain record of a refusal (useful for demos and
    ///         for UIs that want to show "refused because the breaker is active").
    function tryDepositCollateral(address asset, uint256 amount) external returns (bool accepted) {
        if (amount == 0) revert ZeroAmount();
        if (!_healthy(asset)) {
            emit CollateralRefused(msg.sender, asset, amount);
            return false;
        }
        collateral[msg.sender][asset] += amount;
        emit CollateralAccepted(msg.sender, asset, amount);
        return true;
    }

    function _healthy(address asset) internal view returns (bool) {
        try guard.isHealthy(asset) returns (bool ok) {
            return ok;
        } catch {
            return false; // fail closed
        }
    }
}
