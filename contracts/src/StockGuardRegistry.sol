// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal Chainlink AggregatorV3 interface (Base tokenized-stock NAV feeds, 8 decimals).
interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @notice Minimal view of the Reactive Network callback proxy (debt accounting).
interface IReactiveCallbackProxy {
    function debt(address contract_) external view returns (uint256);
}

/**
 * @title StockGuardRegistry (v2)
 * @notice Non-custodial, non-swap integrity registry for tokenized stocks on Base.
 *
 *  Two separate write paths (v1 mixed them, which let anyone grief official assets):
 *   1. publishAttestation()  — permissionless, RECORD-ONLY. Anyone (user or agent) can log a signed
 *                              risk snapshot. It never changes the canonical asset status and never
 *                              emits DepegAlertEmitted. This is the 1-tap traction path (ERC-8021 suffix
 *                              is appended by the frontend; the contract ignores trailing calldata).
 *   2. reportMarket()        — restricted to trusted reporters. Updates canonical status and emits
 *                              DepegAlertEmitted, which the Reactive sentinel watches.
 *
 *  NAV source: if an asset has a Chainlink feed configured, NAV is read on-chain and the caller's
 *  NAV argument is ignored. Off-hours feeds hold their last value, so navUpdatedAt is stored and the
 *  `navStale` flag is exposed instead of reverting (reverting would block reports exactly when needed).
 *
 *  Reactive callbacks: accepted only when msg.sender is the callback proxy AND the injected first
 *  argument equals our own reactive contract address. The proxy is shared by every Reactive user,
 *  so checking msg.sender alone (v1) let any other team's contract trip our breaker.
 *
 *  All depeg math uses floor division in basis points. packages/core-risk mirrors it exactly.
 */
contract StockGuardRegistry {
    // ------------------------------------------------------------------ types
    enum RiskGrade {
        UNVERIFIED, // 0 - never assessed
        GRADE_A,    // 1 - official issuer, depeg < 50 bps
        GRADE_B,    // 2 - official issuer, 50-199 bps
        GRADE_C,    // 3 - official issuer, 200-499 bps
        CRITICAL    // 4 - not an official issuer, or depeg >= 500 bps, or breaker tripped
    }

    struct AssetStatus {
        bool registered;
        bool isOfficialIssuer;
        bool circuitBreakerActive;
        RiskGrade latestGrade;
        uint64 lastReportAt;
        uint64 navUpdatedAt;
        uint64 breakerTriggeredAt;
        address navFeed;
        uint256 lastNavPriceE8;
        uint256 lastDexPriceE8;
        uint256 lastDepegBps;     // from the last trusted market report
        uint256 breakerDepegBps;  // depeg reported by the alert that tripped the breaker
        string ticker;
    }

    struct Attestation {
        address attester;
        address asset;
        uint256 navPriceE8;
        uint256 dexPriceE8;
        uint256 depegBps;
        RiskGrade grade;
        bool navFromFeed;
        bytes32 reportHash;
        uint64 timestamp;
    }

    // ------------------------------------------------------------------ constants
    uint256 public constant BPS = 10_000;
    uint256 public constant GRADE_B_BPS = 50;
    uint256 public constant GRADE_C_BPS = 200;
    uint256 public constant CRITICAL_BPS = 500;

    // ------------------------------------------------------------------ storage
    address public owner;
    address public pendingOwner;
    mapping(address => bool) public isReporter;

    /// @notice Reactive callback proxy on this chain (Base Sepolia: 0x476F44b11F5C942c58f4c8E3d0300E5710743585).
    ///         address(0) disables Reactive callbacks (e.g. Base mainnet without a Reactive loop).
    address public immutable callbackProxy;
    /// @notice Address of OUR DepegSentinelRSC on the Reactive Network (set after it is deployed).
    address public reactiveSender;

    uint256 public alertThresholdBps = GRADE_C_BPS; // DepegAlertEmitted at >= 2.00%
    uint256 public circuitBreakerCooldown = 60;     // seconds, block.timestamp based
    uint256 public maxNavAge = 26 hours;            // feed heartbeat is 24h during market hours

    uint256 public totalAttestations;
    mapping(address => AssetStatus) private _assets;
    mapping(uint256 => Attestation) private _attestations;

    // ------------------------------------------------------------------ events
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ReporterSet(address indexed reporter, bool allowed);
    event ReactiveSenderSet(address indexed reactiveSender);
    event ConfigUpdated(uint256 alertThresholdBps, uint256 circuitBreakerCooldown, uint256 maxNavAge);
    event AssetRegistered(address indexed asset, string ticker, bool isOfficialIssuer, address navFeed);
    event RiskAttested(
        uint256 indexed attestationId,
        address indexed attester,
        address indexed asset,
        uint256 depegBps,
        RiskGrade grade,
        bytes32 reportHash,
        uint256 timestamp
    );
    event MarketReported(
        address indexed asset,
        address indexed reporter,
        uint256 navPriceE8,
        uint256 dexPriceE8,
        uint256 depegBps,
        RiskGrade grade
    );
    /// @dev Origin event watched by DepegSentinelRSC. Only emitted from reportMarket(). Signature must
    ///      stay identical to DepegSentinelRSC.DEPEG_ALERT_TOPIC_0.
    event DepegAlertEmitted(
        address indexed asset,
        uint256 navPriceE8,
        uint256 dexPriceE8,
        uint256 depegBps,
        uint256 timestamp
    );
    event CircuitBreakerTriggered(address indexed asset, uint256 depegBps, address indexed triggeredBy, uint256 timestamp);
    event CircuitBreakerCleared(address indexed asset, uint256 timestamp);
    event CallbackPaid(uint256 amount);

    // ------------------------------------------------------------------ errors
    error NotOwner();
    error NotPendingOwner();
    error NotReporter();
    error NotCallbackProxy();
    error UnauthorizedReactiveSender(address sender, address expected);
    error InvalidPrice();
    error AssetNotRegistered(address asset);
    error InvalidFeedAnswer();
    error ZeroAddress();
    error InsufficientBalance(uint256 required, uint256 available);
    error TransferFailed();
    error InvalidConfig();

    // ------------------------------------------------------------------ modifiers
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyReporter() {
        if (!isReporter[msg.sender] && msg.sender != owner) revert NotReporter();
        _;
    }

    modifier onlyCallbackProxy() {
        if (callbackProxy == address(0) || msg.sender != callbackProxy) revert NotCallbackProxy();
        _;
    }

    constructor(address callbackProxy_) {
        owner = msg.sender;
        callbackProxy = callbackProxy_;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    // ================================================================== admin
    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    function setReporter(address reporter, bool allowed) external onlyOwner {
        if (reporter == address(0)) revert ZeroAddress();
        isReporter[reporter] = allowed;
        emit ReporterSet(reporter, allowed);
    }

    /// @notice Set after DepegSentinelRSC is deployed on the Reactive Network.
    function setReactiveSender(address sender) external onlyOwner {
        reactiveSender = sender;
        emit ReactiveSenderSet(sender);
    }

    function setConfig(uint256 alertThresholdBps_, uint256 cooldown_, uint256 maxNavAge_) external onlyOwner {
        if (alertThresholdBps_ == 0 || alertThresholdBps_ > BPS || maxNavAge_ == 0) revert InvalidConfig();
        alertThresholdBps = alertThresholdBps_;
        circuitBreakerCooldown = cooldown_;
        maxNavAge = maxNavAge_;
        emit ConfigUpdated(alertThresholdBps_, cooldown_, maxNavAge_);
    }

    /// @notice Register or update a tokenized stock. Use addresses from the Coinbase Tokenized Stocks API
    ///         (GET https://api.coinbase.com/v1/tokenized-stocks) and feeds from docs.base.org.
    function registerAsset(address asset, string calldata ticker, bool isOfficialIssuer, address navFeed)
        external
        onlyOwner
    {
        if (asset == address(0)) revert ZeroAddress();
        AssetStatus storage s = _assets[asset];
        s.registered = true;
        s.isOfficialIssuer = isOfficialIssuer;
        s.ticker = ticker;
        s.navFeed = navFeed;
        emit AssetRegistered(asset, ticker, isOfficialIssuer, navFeed);
    }

    // ================================================================== 1. permissionless attestation (record-only)
    /**
     * @notice 1-tap risk attestation. Record-only: does NOT change canonical status or fire alerts.
     * @param navPriceE8 Caller-observed NAV (8 decimals). Ignored when the asset has a Chainlink feed.
     * @param dexPriceE8 Caller-observed DEX price (8 decimals).
     */
    function publishAttestation(address asset, uint256 navPriceE8, uint256 dexPriceE8, bytes32 reportHash)
        external
        returns (uint256 attestationId)
    {
        if (dexPriceE8 == 0) revert InvalidPrice();
        AssetStatus storage s = _assets[asset];

        bool fromFeed;
        if (s.navFeed != address(0)) {
            (navPriceE8,) = _readNav(s.navFeed);
            fromFeed = true;
        }
        if (navPriceE8 == 0) revert InvalidPrice();

        uint256 depegBps = computeDepegBps(navPriceE8, dexPriceE8);
        RiskGrade grade = computeGrade(s.registered && s.isOfficialIssuer, depegBps);

        attestationId = ++totalAttestations;
        _attestations[attestationId] = Attestation({
            attester: msg.sender,
            asset: asset,
            navPriceE8: navPriceE8,
            dexPriceE8: dexPriceE8,
            depegBps: depegBps,
            grade: grade,
            navFromFeed: fromFeed,
            reportHash: reportHash,
            timestamp: uint64(block.timestamp)
        });

        emit RiskAttested(attestationId, msg.sender, asset, depegBps, grade, reportHash, block.timestamp);
    }

    // ================================================================== 2. trusted market report (canonical)
    function reportMarket(address asset, uint256 navPriceE8, uint256 dexPriceE8) external onlyReporter {
        AssetStatus storage s = _assets[asset];
        if (!s.registered) revert AssetNotRegistered(asset);
        if (dexPriceE8 == 0) revert InvalidPrice();

        if (s.navFeed != address(0)) {
            uint256 navUpdatedAt;
            (navPriceE8, navUpdatedAt) = _readNav(s.navFeed);
            s.navUpdatedAt = uint64(navUpdatedAt);
        } else {
            s.navUpdatedAt = uint64(block.timestamp);
        }
        if (navPriceE8 == 0) revert InvalidPrice();

        uint256 depegBps = computeDepegBps(navPriceE8, dexPriceE8);
        RiskGrade grade = computeGrade(s.isOfficialIssuer, depegBps);

        s.lastNavPriceE8 = navPriceE8;
        s.lastDexPriceE8 = dexPriceE8;
        s.lastDepegBps = depegBps;
        s.lastReportAt = uint64(block.timestamp);
        // A tripped breaker keeps the asset CRITICAL until the owner clears it.
        s.latestGrade = s.circuitBreakerActive ? RiskGrade.CRITICAL : grade;

        emit MarketReported(asset, msg.sender, navPriceE8, dexPriceE8, depegBps, grade);

        if (depegBps >= alertThresholdBps) {
            emit DepegAlertEmitted(asset, navPriceE8, dexPriceE8, depegBps, block.timestamp);
        }
    }

    // ================================================================== 3. circuit breaker
    /**
     * @notice Reactive Network callback. The proxy overwrites the first argument with the address of the
     *         reactive contract that requested the callback; we only accept our own sentinel.
     * @dev Returns silently during cooldown instead of reverting, so a burst of alerts does not waste
     *      callback gas on reverted transactions.
     */
    function triggerCircuitBreaker(address rvmSender, address asset, uint256 depegBps) external onlyCallbackProxy {
        if (rvmSender == address(0) || rvmSender != reactiveSender) {
            revert UnauthorizedReactiveSender(rvmSender, reactiveSender);
        }
        _trip(asset, depegBps);
    }

    /// @notice Manual trigger for the owner (Base mainnet without a Reactive loop, or demos).
    function ownerTriggerCircuitBreaker(address asset, uint256 depegBps) external onlyOwner {
        _trip(asset, depegBps);
    }

    function clearCircuitBreaker(address asset) external onlyOwner {
        AssetStatus storage s = _assets[asset];
        s.circuitBreakerActive = false;
        s.latestGrade = s.lastNavPriceE8 == 0
            ? RiskGrade.UNVERIFIED
            : computeGrade(s.isOfficialIssuer, s.lastDepegBps);
        emit CircuitBreakerCleared(asset, block.timestamp);
    }

    function _trip(address asset, uint256 depegBps) internal {
        AssetStatus storage s = _assets[asset];
        if (!s.registered) revert AssetNotRegistered(asset);
        if (s.circuitBreakerActive && block.timestamp < uint256(s.breakerTriggeredAt) + circuitBreakerCooldown) {
            return; // cooldown: already tripped recently
        }
        s.circuitBreakerActive = true;
        s.breakerTriggeredAt = uint64(block.timestamp);
        s.breakerDepegBps = depegBps;
        s.latestGrade = RiskGrade.CRITICAL;
        emit CircuitBreakerTriggered(asset, depegBps, msg.sender, block.timestamp);
    }

    // ================================================================== Reactive callback payment
    /// @notice Called by the callback proxy to collect callback fees (destination-chain native token).
    function pay(uint256 amount) external onlyCallbackProxy {
        _send(payable(msg.sender), amount);
        emit CallbackPaid(amount);
    }

    /// @notice Settle any outstanding callback debt from this contract's balance. A contract in debt
    ///         receives no callbacks.
    function coverDebt() external {
        if (callbackProxy == address(0)) revert NotCallbackProxy();
        uint256 amount = IReactiveCallbackProxy(callbackProxy).debt(address(this));
        _send(payable(callbackProxy), amount);
        emit CallbackPaid(amount);
    }

    function withdraw(address payable to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        _send(to, amount);
    }

    receive() external payable {}

    function _send(address payable to, uint256 amount) internal {
        if (amount == 0) return;
        if (address(this).balance < amount) revert InsufficientBalance(amount, address(this).balance);
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ================================================================== views / pure math
    function getAsset(address asset) external view returns (AssetStatus memory) {
        return _assets[asset];
    }

    function getAttestation(uint256 id) external view returns (Attestation memory) {
        return _attestations[id];
    }

    /// @notice True when the last NAV update is older than maxNavAge (weekend / off-hours / paused feed).
    function navStale(address asset) external view returns (bool) {
        AssetStatus storage s = _assets[asset];
        return s.navUpdatedAt == 0 || block.timestamp > uint256(s.navUpdatedAt) + maxNavAge;
    }

    /// @notice Healthy = registered official issuer, breaker off, and last canonical grade A or B.
    function isHealthy(address asset) external view returns (bool) {
        AssetStatus storage s = _assets[asset];
        return s.registered && s.isOfficialIssuer && !s.circuitBreakerActive
            && (s.latestGrade == RiskGrade.GRADE_A || s.latestGrade == RiskGrade.GRADE_B);
    }

    /// @notice floor(|dex - nav| * 10000 / nav). Mirrored by core-risk computeDepegBps().
    function computeDepegBps(uint256 navPriceE8, uint256 dexPriceE8) public pure returns (uint256) {
        if (navPriceE8 == 0) revert InvalidPrice();
        uint256 diff = navPriceE8 > dexPriceE8 ? navPriceE8 - dexPriceE8 : dexPriceE8 - navPriceE8;
        return (diff * BPS) / navPriceE8;
    }

    function computeGrade(bool isOfficial, uint256 depegBps) public pure returns (RiskGrade) {
        if (!isOfficial || depegBps >= CRITICAL_BPS) return RiskGrade.CRITICAL;
        if (depegBps >= GRADE_C_BPS) return RiskGrade.GRADE_C;
        if (depegBps >= GRADE_B_BPS) return RiskGrade.GRADE_B;
        return RiskGrade.GRADE_A;
    }

    /// @dev Reads a Chainlink feed and normalises the answer to 8 decimals.
    function _readNav(address feed) internal view returns (uint256 priceE8, uint256 updatedAt) {
        (, int256 answer,, uint256 updated,) = IAggregatorV3(feed).latestRoundData();
        if (answer <= 0) revert InvalidFeedAnswer();
        uint8 dec = IAggregatorV3(feed).decimals();
        uint256 raw = uint256(answer);
        if (dec == 8) priceE8 = raw;
        else if (dec > 8) priceE8 = raw / (10 ** (dec - 8));
        else priceE8 = raw * (10 ** (8 - dec));
        updatedAt = updated;
    }
}
