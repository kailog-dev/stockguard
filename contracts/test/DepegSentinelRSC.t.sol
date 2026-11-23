// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../src/DepegSentinelRSC.sol";

interface Vm {
    function etch(address, bytes calldata) external;
    function prank(address) external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
}

/// @dev Stand-in for the Reactive system contract, etched at 0x8888...8888.
contract MockSystem {
    uint256 public subscriptions;
    uint256 public lastSubChain;
    address public lastSubContract;
    uint256 public lastSubTopic0;

    uint256 public callbacks;
    uint256 public lastCbChain;
    address public lastCbRecipient;
    uint64 public lastCbGas;
    bytes public lastCbPayload;

    function subscribe(uint256 c, address a, uint256 t0, uint256, uint256, uint256) external {
        subscriptions++;
        lastSubChain = c;
        lastSubContract = a;
        lastSubTopic0 = t0;
    }

    function requestCallbackV_1_0(IReactiveSystem.CallbackConfiguration_V_1_0 memory cfg) external {
        callbacks++;
        lastCbChain = cfg.chainId;
        lastCbRecipient = cfg.recipient;
        lastCbGas = cfg.gasLimit;
        lastCbPayload = cfg.payload;
    }

    function debt(address) external pure returns (uint256) {
        return 0;
    }

    function callReact(DepegSentinelRSC rsc, DepegSentinelRSC.LogRecord calldata log_) external {
        rsc.react(log_);
    }
}

contract DepegSentinelRSCTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address internal constant SYSTEM = 0x8888888888888888888888888888888888888888;
    uint256 internal constant BASE_SEPOLIA = 84532;
    address internal constant REGISTRY = address(0x5106);
    address internal constant ASSET = address(0xB201);

    DepegSentinelRSC internal rsc;
    MockSystem internal sys;

    function setUp() public {
        vm.etch(SYSTEM, type(MockSystem).runtimeCode);
        sys = MockSystem(SYSTEM);
        rsc = new DepegSentinelRSC(BASE_SEPOLIA, BASE_SEPOLIA, REGISTRY, 200);
    }

    function _log(uint256 chainId, address emitter, uint256 topic0, uint256 depegBps)
        internal
        pure
        returns (DepegSentinelRSC.LogRecord memory l)
    {
        l.chainId = chainId;
        l.contractAddress = emitter;
        l.topic0 = topic0;
        l.topic1 = uint256(uint160(ASSET));
        l.data = abi.encode(uint256(100e8), uint256(103e8), depegBps, uint256(1_800_000_000));
        l.opCode = 2;
        l.txHash = 0xabc;
        l.logIndex = 7;
    }

    function testSelectorsMatchReactiveLib() public pure {
        // Values produced by `forge inspect` on Reactive-Network/reactive-lib-omni (IReactive / ISystemContract).
        require(DepegSentinelRSC.react.selector == bytes4(0x0d152c2c), "react selector");
        require(DepegSentinelRSC.pay.selector == bytes4(0xc290d691), "pay selector");
        require(IReactiveSystem.subscribe.selector == bytes4(0x5a6aced0), "subscribe selector");
        require(IReactiveSystem.requestCallbackV_1_0.selector == bytes4(0x6407b0c1), "callback selector");
        require(IReactiveSystem.debt.selector == bytes4(0x9b6c56ec), "debt selector");
    }

    function testTopicMatchesRegistryEvent() public view {
        require(
            rsc.DEPEG_ALERT_TOPIC_0()
                == uint256(keccak256("DepegAlertEmitted(address,uint256,uint256,uint256,uint256)")),
            "topic0"
        );
    }

    function testSubscribesOnDeploy() public view {
        require(sys.subscriptions() == 1, "subscribed");
        require(sys.lastSubChain() == BASE_SEPOLIA, "chain");
        require(sys.lastSubContract() == REGISTRY, "registry");
        require(sys.lastSubTopic0() == rsc.DEPEG_ALERT_TOPIC_0(), "topic");
    }

    function testReactRequestsCallbackAboveThreshold() public {
        sys.callReact(rsc, _log(BASE_SEPOLIA, REGISTRY, rsc.DEPEG_ALERT_TOPIC_0(), 300));
        require(sys.callbacks() == 1, "callback requested");
        require(sys.lastCbChain() == BASE_SEPOLIA, "dest chain");
        require(sys.lastCbRecipient() == REGISTRY, "recipient");
        bytes memory expected =
            abi.encodeWithSignature("triggerCircuitBreaker(address,address,uint256)", address(0), ASSET, uint256(300));
        require(keccak256(sys.lastCbPayload()) == keccak256(expected), "payload");
    }

    function testIgnoresBelowThreshold() public {
        sys.callReact(rsc, _log(BASE_SEPOLIA, REGISTRY, rsc.DEPEG_ALERT_TOPIC_0(), 199));
        require(sys.callbacks() == 0, "ignored");
    }

    function testIgnoresWrongChainEmitterOrTopic() public {
        uint256 t0 = rsc.DEPEG_ALERT_TOPIC_0();
        sys.callReact(rsc, _log(1, REGISTRY, t0, 900));
        sys.callReact(rsc, _log(BASE_SEPOLIA, address(0xEE), t0, 900));
        sys.callReact(rsc, _log(BASE_SEPOLIA, REGISTRY, t0 ^ 1, 900));
        require(sys.callbacks() == 0, "all ignored");
    }

    function testOnlySystemCanReact() public {
        DepegSentinelRSC.LogRecord memory l = _log(BASE_SEPOLIA, REGISTRY, rsc.DEPEG_ALERT_TOPIC_0(), 900);
        vm.expectRevert(DepegSentinelRSC.NotSystem.selector);
        rsc.react(l);
    }

    function testCallbackUsesConfiguredGasLimit() public {
        require(rsc.callbackGasLimit() == 1_000_000, "default 1M");
        sys.callReact(rsc, _log(BASE_SEPOLIA, REGISTRY, rsc.DEPEG_ALERT_TOPIC_0(), 300));
        require(sys.lastCbGas() == 1_000_000, "default gas sent");
        rsc.setCallbackGasLimit(600_000);
        sys.callReact(rsc, _log(BASE_SEPOLIA, REGISTRY, rsc.DEPEG_ALERT_TOPIC_0(), 300));
        require(sys.lastCbGas() == 600_000, "updated gas sent");
    }

    function testGasLimitBoundsAndOwner() public {
        vm.expectRevert(abi.encodeWithSelector(DepegSentinelRSC.GasLimitOutOfRange.selector, uint64(99_999)));
        rsc.setCallbackGasLimit(99_999);
        vm.expectRevert(abi.encodeWithSelector(DepegSentinelRSC.GasLimitOutOfRange.selector, uint64(3_000_001)));
        rsc.setCallbackGasLimit(3_000_001);
        vm.prank(address(0xBEEF));
        vm.expectRevert(DepegSentinelRSC.NotOwner.selector);
        rsc.setCallbackGasLimit(500_000);
    }

    function testOnlySystemCanCollectPayment() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert(DepegSentinelRSC.NotSystem.selector);
        rsc.pay(1);
    }
}
