// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * Self-contained mirror of the Reactive Network interfaces (reactive-lib-omni):
 *   - LogRecord layout and react() selector are identical to IReactive.react(LogRecord)
 *   - subscribe() / requestCallbackV_1_0() / debt() match ISystemContract
 * Keeping them inline means `forge build` works without `forge install`. If the library changes,
 * test/DepegSentinelRSC.t.sol (testSelectorsMatchReactiveLib values) will tell you.
 */
interface IReactiveSystem {
    struct CallbackConfiguration_V_1_0 {
        uint256 chainId;
        address recipient;
        uint64 gasLimit;
        bytes payload;
    }

    function subscribe(
        uint256 chainId_,
        address contract_,
        uint256 topic0_,
        uint256 topic1_,
        uint256 topic2_,
        uint256 topic3_
    ) external;

    function requestCallbackV_1_0(CallbackConfiguration_V_1_0 memory config_) external;

    function debt(address contract_) external view returns (uint256);
}

/**
 * @title DepegSentinelRSC (Reactive Omni Buildathon - "Every Second Counts")
 * @notice Watches StockGuardRegistry.DepegAlertEmitted on the origin chain (Base Sepolia) and requests a
 *         callback to StockGuardRegistry.triggerCircuitBreaker() on the destination chain - no off-chain bot.
 *
 * Deploy order (testnet):
 *   1. Deploy StockGuardRegistry on Base Sepolia with callbackProxy = 0x476F44b11F5C942c58f4c8E3d0300E5710743585
 *   2. Deploy this contract on Reactive Lasna (chain 5318007) with value (lREACT) to pay for reactions
 *   3. registry.setReactiveSender(<this contract address>)
 *   4. Fund the registry with Base Sepolia ETH so it can pay callback fees (receive / coverDebt)
 *
 * The proxy overwrites the first `address` argument of the payload with this contract's address;
 * the registry only accepts callbacks whose injected address equals its configured reactiveSender.
 */
contract DepegSentinelRSC {
    struct LogRecord {
        uint256 chainId;
        address contractAddress;
        uint256 topic0;
        uint256 topic1;
        uint256 topic2;
        uint256 topic3;
        bytes data;
        uint256 blockNumber;
        uint256 opCode;
        uint256 blockHash;
        uint256 txHash;
        uint256 logIndex;
    }

    IReactiveSystem internal constant SYSTEM = IReactiveSystem(0x8888888888888888888888888888888888888888);
    uint256 internal constant REACTIVE_IGNORE = 0xa65f96fc951c35ead38878e0f0b7a3c744a6f5ccc1476b313353ce31712313ad;

    /// @dev keccak256("DepegAlertEmitted(address,uint256,uint256,uint256,uint256)") - must match the registry.
    uint256 public constant DEPEG_ALERT_TOPIC_0 =
        uint256(keccak256("DepegAlertEmitted(address,uint256,uint256,uint256,uint256)"));
    /// @dev The callback proxy withholds part of this gas for its own accounting and payment settlement, and
    ///      requests under 100,000 are ignored by Reactive. 1,000,000 leaves wide headroom over what
    ///      triggerCircuitBreaker() uses (see EndToEndLoop.t.sol), and the owner can tune it without redeploying.
    uint64 public constant MIN_CALLBACK_GAS = 100_000;
    uint64 public constant MAX_CALLBACK_GAS = 3_000_000;
    uint64 public callbackGasLimit = 1_000_000;

    uint256 public immutable originChainId;
    uint256 public immutable destinationChainId;
    address public immutable registry;
    uint256 public immutable triggerBps;
    address public immutable owner;

    event SentinelFired(address indexed asset, uint256 depegBps, uint256 originTxHash, uint256 originLogIndex);
    event CallbackGasLimitSet(uint64 gasLimit);

    error NotSystem();
    error NotOwner();
    error InsufficientBalance(uint256 required, uint256 available);
    error TransferFailed();
    error GasLimitOutOfRange(uint64 gasLimit);

    modifier onlySystem() {
        if (msg.sender != address(SYSTEM)) revert NotSystem();
        _;
    }

    /**
     * @param originChainId_      84532 (Base Sepolia) on testnet
     * @param destinationChainId_ 84532 as well: the same registry is both origin and destination
     * @param registry_           StockGuardRegistry address on Base Sepolia
     * @param triggerBps_         e.g. 200 (2.00%). Alerts below this are ignored.
     */
    constructor(uint256 originChainId_, uint256 destinationChainId_, address registry_, uint256 triggerBps_)
        payable
    {
        originChainId = originChainId_;
        destinationChainId = destinationChainId_;
        registry = registry_;
        triggerBps = triggerBps_;
        owner = msg.sender;

        SYSTEM.subscribe(
            originChainId_, registry_, DEPEG_ALERT_TOPIC_0, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE
        );
    }

    /// @notice Entry point called by the Reactive system contract for every matching log.
    function react(LogRecord calldata log_) external onlySystem {
        if (log_.chainId != originChainId) return;
        if (log_.contractAddress != registry) return;
        if (log_.topic0 != DEPEG_ALERT_TOPIC_0) return;

        address asset = address(uint160(log_.topic1));
        // non-indexed data: (navPriceE8, dexPriceE8, depegBps, timestamp)
        (,, uint256 depegBps,) = abi.decode(log_.data, (uint256, uint256, uint256, uint256));
        if (depegBps < triggerBps) return;

        bytes memory payload = abi.encodeWithSignature(
            "triggerCircuitBreaker(address,address,uint256)",
            address(0), // replaced by the Reactive Network with this contract's address
            asset,
            depegBps
        );

        SYSTEM.requestCallbackV_1_0(
            IReactiveSystem.CallbackConfiguration_V_1_0({
                chainId: destinationChainId,
                recipient: registry,
                gasLimit: callbackGasLimit,
                payload: payload
            })
        );

        emit SentinelFired(asset, depegBps, log_.txHash, log_.logIndex);
    }

    /// @notice Owner-only: raise or lower the callback gas without redeploying (and without losing the subscription).
    function setCallbackGasLimit(uint64 gasLimit_) external {
        if (msg.sender != owner) revert NotOwner();
        if (gasLimit_ < MIN_CALLBACK_GAS || gasLimit_ > MAX_CALLBACK_GAS) revert GasLimitOutOfRange(gasLimit_);
        callbackGasLimit = gasLimit_;
        emit CallbackGasLimitSet(gasLimit_);
    }

    // ------------------------------------------------------------ payments (lREACT / REACT)
    /// @notice Called by the system contract to charge for reactions.
    function pay(uint256 amount_) external onlySystem {
        _send(payable(msg.sender), amount_);
    }

    /// @notice Settle outstanding debt. A contract in debt stops receiving events.
    function coverDebt() external {
        _send(payable(address(SYSTEM)), SYSTEM.debt(address(this)));
    }

    function withdraw(address payable to, uint256 amount) external {
        if (msg.sender != owner) revert NotOwner();
        _send(to, amount);
    }

    receive() external payable {}

    function _send(address payable to, uint256 amount) internal {
        if (amount == 0) return;
        if (address(this).balance < amount) revert InsufficientBalance(amount, address(this).balance);
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
