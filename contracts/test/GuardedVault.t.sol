// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../src/GuardedVault.sol";

interface Vm {
    function expectRevert(bytes calldata) external;
}

contract MockGuard is IStockGuard {
    mapping(address => bool) public healthy;

    function set(address a, bool h) external {
        healthy[a] = h;
    }

    function isHealthy(address a) external view returns (bool) {
        return healthy[a];
    }
}

contract BrokenGuard is IStockGuard {
    function isHealthy(address) external pure returns (bool) {
        revert("down");
    }
}

contract GuardedVaultTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant MSTRC = address(0xb200);

    MockGuard guard;
    GuardedVault vault;

    function setUp() public {
        guard = new MockGuard();
        vault = new GuardedVault(guard);
    }

    function test_acceptsWhenHealthy() public {
        guard.set(MSTRC, true);
        vault.depositCollateral(MSTRC, 100);
        require(vault.collateral(address(this), MSTRC) == 100, "recorded");
    }

    function test_refusesWhileBreakerTripped() public {
        guard.set(MSTRC, false);
        vm.expectRevert(abi.encodeWithSelector(GuardedVault.AssetUnhealthy.selector, MSTRC));
        vault.depositCollateral(MSTRC, 100);
    }

    function test_tryDepositRecordsRefusalThenAcceptsAfterClear() public {
        guard.set(MSTRC, false);
        require(!vault.tryDepositCollateral(MSTRC, 100), "refused while tripped");
        require(vault.collateral(address(this), MSTRC) == 0, "nothing recorded");
        guard.set(MSTRC, true); // breaker cleared
        require(vault.tryDepositCollateral(MSTRC, 100), "accepted after clear");
        require(vault.collateral(address(this), MSTRC) == 100, "recorded after clear");
    }

    function test_failsClosedWhenGuardReverts() public {
        GuardedVault v = new GuardedVault(new BrokenGuard());
        vm.expectRevert(abi.encodeWithSelector(GuardedVault.AssetUnhealthy.selector, MSTRC));
        v.depositCollateral(MSTRC, 1);
        require(!v.tryDepositCollateral(MSTRC, 1), "fail closed");
    }

    function test_zeroAmountReverts() public {
        guard.set(MSTRC, true);
        vm.expectRevert(abi.encodeWithSelector(GuardedVault.ZeroAmount.selector));
        vault.depositCollateral(MSTRC, 0);
    }
}
