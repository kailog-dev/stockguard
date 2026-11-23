// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../src/StockGuardRegistry.sol";

/// @dev Minimal Foundry cheatcode interface, so the suite runs without installing forge-std.
interface Vm {
    function prank(address) external;
    function warp(uint256) external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function deal(address, uint256) external;
}

contract MockFeed {
    uint8 public decimals;
    int256 public answer;
    uint256 public updatedAt;

    constructor(uint8 d, int256 a) {
        decimals = d;
        answer = a;
        updatedAt = block.timestamp;
    }

    function set(int256 a, uint256 t) external {
        answer = a;
        updatedAt = t;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

contract MockCallbackProxy {
    uint256 public owed;

    function setDebt(uint256 d) external {
        owed = d;
    }

    function debt(address) external view returns (uint256) {
        return owed;
    }

    function relay(StockGuardRegistry r, address rvmSender, address asset, uint256 bps) external {
        r.triggerCircuitBreaker(rvmSender, asset, bps);
    }

    function collect(StockGuardRegistry r, uint256 amount) external {
        r.pay(amount);
    }

    receive() external payable {}
}

contract StockGuardRegistryTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    StockGuardRegistry internal registry;
    MockCallbackProxy internal proxy;
    MockFeed internal feed8;

    address internal constant NVDA = address(0xB201);
    address internal constant AAPL = address(0xB202);
    address internal constant FAKE = address(0xDEAD);
    address internal constant RSC = address(0x5E5E);
    address internal constant REPORTER = address(0xA11CE);
    address internal constant RANDOM = address(0xBEEF);

    function setUp() public {
        vm.warp(1_800_000_000);
        proxy = new MockCallbackProxy();
        registry = new StockGuardRegistry(address(proxy));
        feed8 = new MockFeed(8, 200_00000000); // $200.00
        registry.registerAsset(NVDA, "NVDA", true, address(0));
        registry.registerAsset(AAPL, "AAPL", true, address(feed8));
        registry.setReporter(REPORTER, true);
        registry.setReactiveSender(RSC);
    }

    // ------------------------------------------------------------ depeg math
    function testDepegUsesFloorDivision() public view {
        // 0.4999% -> 49 bps (floor), must stay GRADE_A
        require(registry.computeDepegBps(100_00000000, 100_49990000) == 49, "floor");
        require(registry.computeGrade(true, 49) == StockGuardRegistry.RiskGrade.GRADE_A, "A");
        require(registry.computeGrade(true, 50) == StockGuardRegistry.RiskGrade.GRADE_B, "B");
        require(registry.computeGrade(true, 200) == StockGuardRegistry.RiskGrade.GRADE_C, "C");
        require(registry.computeGrade(true, 500) == StockGuardRegistry.RiskGrade.CRITICAL, "CRIT");
        require(registry.computeGrade(false, 0) == StockGuardRegistry.RiskGrade.CRITICAL, "unofficial");
    }

    // ------------------------------------------------------------ attestation path
    function testOfficialLowDepegAttestationIsGradeA() public {
        uint256 id = registry.publishAttestation(NVDA, 140_00000000, 140_28000000, keccak256("r1"));
        require(id == 1, "id");
        StockGuardRegistry.Attestation memory a = registry.getAttestation(1);
        require(a.depegBps == 20, "20 bps");
        require(a.grade == StockGuardRegistry.RiskGrade.GRADE_A, "A");
        require(!a.navFromFeed, "manual nav");
    }

    function testUnregisteredLookalikeIsCritical() public {
        registry.publishAttestation(FAKE, 100_00000000, 100_00000000, keccak256("fake"));
        require(registry.getAttestation(1).grade == StockGuardRegistry.RiskGrade.CRITICAL, "CRIT");
    }

    function testAttestationCannotGriefCanonicalStatus() public {
        // v1 bug: any wallet could post fake prices and flip an official asset to CRITICAL.
        vm.prank(RANDOM);
        registry.publishAttestation(NVDA, 100_00000000, 150_00000000, bytes32(0));
        StockGuardRegistry.AssetStatus memory s = registry.getAsset(NVDA);
        require(s.latestGrade == StockGuardRegistry.RiskGrade.UNVERIFIED, "canonical untouched");
        require(s.lastDepegBps == 0, "no depeg written");
        require(registry.getAttestation(1).grade == StockGuardRegistry.RiskGrade.CRITICAL, "but recorded");
    }

    function testAttestationUsesFeedNavWhenConfigured() public {
        // caller claims NAV $1 but the feed says $200; feed wins
        registry.publishAttestation(AAPL, 1_00000000, 202_00000000, bytes32(0));
        StockGuardRegistry.Attestation memory a = registry.getAttestation(1);
        require(a.navFromFeed, "feed");
        require(a.navPriceE8 == 200_00000000, "feed nav");
        require(a.depegBps == 100, "1%");
    }

    function testZeroDexPriceReverts() public {
        vm.expectRevert(StockGuardRegistry.InvalidPrice.selector);
        registry.publishAttestation(NVDA, 100_00000000, 0, bytes32(0));
    }

    // ------------------------------------------------------------ reporter path
    function testReporterUpdatesCanonicalStatus() public {
        vm.prank(REPORTER);
        registry.reportMarket(NVDA, 100_00000000, 103_00000000);
        StockGuardRegistry.AssetStatus memory s = registry.getAsset(NVDA);
        require(s.lastDepegBps == 300, "300 bps");
        require(s.latestGrade == StockGuardRegistry.RiskGrade.GRADE_C, "C");
        require(registry.isHealthy(NVDA) == false, "not healthy");
    }

    function testNonReporterCannotReport() public {
        vm.prank(RANDOM);
        vm.expectRevert(StockGuardRegistry.NotReporter.selector);
        registry.reportMarket(NVDA, 100_00000000, 103_00000000);
    }

    function testReportNormalisesEighteenDecimalFeed() public {
        MockFeed f18 = new MockFeed(18, 50e18); // $50 with 18 decimals
        registry.registerAsset(address(0xB203), "TSLA", true, address(f18));
        vm.prank(REPORTER);
        registry.reportMarket(address(0xB203), 0, 50_00000000);
        StockGuardRegistry.AssetStatus memory s = registry.getAsset(address(0xB203));
        require(s.lastNavPriceE8 == 50_00000000, "normalised");
        require(s.latestGrade == StockGuardRegistry.RiskGrade.GRADE_A, "A");
    }

    function testNavStaleFlag() public {
        vm.prank(REPORTER);
        registry.reportMarket(AAPL, 0, 200_00000000);
        require(!registry.navStale(AAPL), "fresh");
        vm.warp(block.timestamp + 27 hours);
        require(registry.navStale(AAPL), "stale after 26h");
    }

    function testNegativeFeedAnswerReverts() public {
        feed8.set(-1, block.timestamp);
        vm.prank(REPORTER);
        vm.expectRevert(StockGuardRegistry.InvalidFeedAnswer.selector);
        registry.reportMarket(AAPL, 0, 200_00000000);
    }

    // ------------------------------------------------------------ reactive callback auth
    function testCallbackFromOurSentinelTripsBreaker() public {
        proxy.relay(registry, RSC, NVDA, 350);
        StockGuardRegistry.AssetStatus memory s = registry.getAsset(NVDA);
        require(s.circuitBreakerActive, "active");
        require(s.latestGrade == StockGuardRegistry.RiskGrade.CRITICAL, "CRIT");
    }

    function testCallbackFromForeignReactiveContractRejected() public {
        // v1 bug: the proxy is shared, so any team's RSC could trip our breaker.
        vm.expectRevert(
            abi.encodeWithSelector(StockGuardRegistry.UnauthorizedReactiveSender.selector, address(0xBAD), RSC)
        );
        proxy.relay(registry, address(0xBAD), NVDA, 9999);
    }

    function testDirectCallNotFromProxyRejected() public {
        vm.prank(RANDOM);
        vm.expectRevert(StockGuardRegistry.NotCallbackProxy.selector);
        registry.triggerCircuitBreaker(RSC, NVDA, 350);
    }

    function testCooldownIsTimestampBased() public {
        proxy.relay(registry, RSC, NVDA, 350);
        uint256 t0 = registry.getAsset(NVDA).breakerTriggeredAt;
        vm.warp(block.timestamp + 30);
        proxy.relay(registry, RSC, NVDA, 900); // inside cooldown: ignored
        require(registry.getAsset(NVDA).breakerDepegBps == 350, "ignored during cooldown");
        require(registry.getAsset(NVDA).breakerTriggeredAt == t0, "timestamp unchanged");
        vm.warp(block.timestamp + 31);
        proxy.relay(registry, RSC, NVDA, 900);
        require(registry.getAsset(NVDA).breakerDepegBps == 900, "re-armed after cooldown");
    }

    function testClearRestoresGradeFromLastReport() public {
        vm.prank(REPORTER);
        registry.reportMarket(NVDA, 100_00000000, 100_10000000); // 10 bps -> A
        registry.ownerTriggerCircuitBreaker(NVDA, 600);
        require(!registry.isHealthy(NVDA), "tripped");
        registry.clearCircuitBreaker(NVDA);
        StockGuardRegistry.AssetStatus memory s = registry.getAsset(NVDA);
        require(!s.circuitBreakerActive, "cleared");
        require(s.latestGrade == StockGuardRegistry.RiskGrade.GRADE_A, "back to last report grade");
        require(s.breakerDepegBps == 600, "alert depeg kept for audit");
    }

    function testOnlyOwnerCanClear() public {
        registry.ownerTriggerCircuitBreaker(NVDA, 600);
        vm.prank(RANDOM);
        vm.expectRevert(StockGuardRegistry.NotOwner.selector);
        registry.clearCircuitBreaker(NVDA);
    }

    function testTripUnregisteredAssetReverts() public {
        vm.expectRevert(abi.encodeWithSelector(StockGuardRegistry.AssetNotRegistered.selector, FAKE));
        registry.ownerTriggerCircuitBreaker(FAKE, 600);
    }

    // ------------------------------------------------------------ payments & ownership
    function testProxyCanCollectCallbackFee() public {
        vm.deal(address(registry), 1 ether);
        proxy.collect(registry, 0.1 ether);
        require(address(proxy).balance == 0.1 ether, "paid");
    }

    function testRandomCannotCollectFee() public {
        vm.deal(address(registry), 1 ether);
        vm.prank(RANDOM);
        vm.expectRevert(StockGuardRegistry.NotCallbackProxy.selector);
        registry.pay(0.1 ether);
    }

    function testCoverDebt() public {
        vm.deal(address(registry), 1 ether);
        proxy.setDebt(0.25 ether);
        registry.coverDebt();
        require(address(proxy).balance == 0.25 ether, "debt covered");
    }

    function testTwoStepOwnership() public {
        registry.transferOwnership(RANDOM);
        require(registry.owner() == address(this), "not yet");
        vm.prank(RANDOM);
        registry.acceptOwnership();
        require(registry.owner() == RANDOM, "transferred");
    }

    receive() external payable {}
}
