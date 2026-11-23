// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../src/DepegSentinelRSC.sol";
import "../src/StockGuardRegistry.sol";
import {MockSystem} from "./DepegSentinelRSC.t.sol";

interface VmLoop {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function etch(address, bytes calldata) external;
    function prank(address) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
    function warp(uint256) external;
}

/**
 * Origin TX -> Reactive react() -> Callback TX, simulated locally:
 *  1. reporter calls registry.reportMarket() with a 3% depeg -> DepegAlertEmitted
 *  2. the recorded log is fed to DepegSentinelRSC.react() as the Reactive system would
 *  3. the requested payload is delivered by the callback proxy with the RSC address injected
 */
contract EndToEndLoopTest {
    VmLoop internal constant vm = VmLoop(address(uint160(uint256(keccak256("hevm cheat code")))));
    address internal constant SYSTEM = 0x8888888888888888888888888888888888888888;
    address internal constant PROXY = address(0x476F44b11F5C942c58f4c8E3d0300E5710743585);
    address internal constant ASSET = address(0xB201);
    uint256 internal constant BASE_SEPOLIA = 84532;

    StockGuardRegistry internal registry;
    DepegSentinelRSC internal rsc;
    MockSystem internal sys;
    uint256 public lastCallbackGas;

    function setUp() public {
        vm.warp(1_800_000_000);
        vm.etch(SYSTEM, type(MockSystem).runtimeCode);
        sys = MockSystem(SYSTEM);
        registry = new StockGuardRegistry(PROXY);
        registry.registerAsset(ASSET, "NVDA", true, address(0));
        rsc = new DepegSentinelRSC(block.chainid, block.chainid, address(registry), 200);
        registry.setReactiveSender(address(rsc));
    }

    function testFullLoopTripsBreaker() public {
        // 1. origin
        vm.recordLogs();
        registry.reportMarket(ASSET, 100e8, 103e8);
        VmLoop.Log[] memory logs = vm.getRecordedLogs();

        DepegSentinelRSC.LogRecord memory rec;
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(registry) && uint256(logs[i].topics[0]) == rsc.DEPEG_ALERT_TOPIC_0()) {
                rec.chainId = block.chainid;
                rec.contractAddress = logs[i].emitter;
                rec.topic0 = uint256(logs[i].topics[0]);
                rec.topic1 = uint256(logs[i].topics[1]);
                rec.data = logs[i].data;
                rec.opCode = logs[i].topics.length;
                found = true;
            }
        }
        require(found, "origin event emitted");

        // 2. reactive
        sys.callReact(rsc, rec);
        require(sys.callbacks() == 1, "callback requested");
        bytes memory payload = sys.lastCbPayload();

        // 3. callback: the proxy injects the RSC address into the first argument
        assembly {
            mstore(add(payload, 36), sload(rsc.slot))
        }
        vm.prank(PROXY);
        uint256 g0 = gasleft();
        (bool ok,) = address(registry).call(payload);
        uint256 used = g0 - gasleft();
        require(ok, "callback executed");
        // cold first trip: must fit comfortably inside the gas the sentinel requests, leaving room for the
        // proxy's own accounting (docs: the proxy withholds gas for accounting and payment settlement)
        require(used * 4 < rsc.callbackGasLimit(), "callback gas headroom >= 4x");
        lastCallbackGas = used;

        StockGuardRegistry.AssetStatus memory s = registry.getAsset(ASSET);
        require(s.circuitBreakerActive, "breaker tripped");
        require(s.breakerDepegBps == 300, "300 bps");
        emit log_named_uint("triggerCircuitBreaker gas (cold)", lastCallbackGas);
    }

    event log_named_uint(string key, uint256 val);
}
