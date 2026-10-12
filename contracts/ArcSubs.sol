// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal ERC-20 surface used by ArcSubs.
interface IERC20Minimal {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}

/// @title ArcSubs
/// @notice Recurring USDC payments ("subscriptions") with pull-based billing.
///
/// A merchant publishes a plan (price in USDC, billing period). A subscriber approves USDC to this
/// contract once and subscribes; the first period is charged immediately, later periods can be
/// charged by anyone (a keeper, the merchant, the subscriber) once they are due. Money always goes
/// straight from the subscriber to the merchant: the contract never holds funds. The subscriber
/// stays in control: cancelling is one call, and revoking the allowance stops billing too.
///
/// Why it fits Arc: on Arc both the price and the gas fee are denominated in USDC, so a merchant
/// (or keeper) knows in dollars exactly what a billing cycle costs to run.
contract ArcSubs {
    // ---------------------------------------------------------------- types

    struct Plan {
        address merchant;
        uint128 price;      // USDC base units (6 decimals in the ERC-20 interface)
        uint32 period;      // seconds between charges
        bool active;        // when false: no new subscriptions and no renewals
        string name;        // short human-readable label
    }

    struct Subscription {
        uint256 planId;
        address subscriber;
        uint64 nextChargeAt; // earliest time the next period can be charged
        uint32 charges;      // how many periods have been paid so far
        bool active;
    }

    // ---------------------------------------------------------------- storage

    uint32 public constant MIN_PERIOD = 60; // seconds
    uint256 public constant MAX_NAME_BYTES = 64;

    IERC20Minimal public immutable usdc;

    uint256 public planCount;
    uint256 public subscriptionCount;

    mapping(uint256 => Plan) private _plans;
    mapping(uint256 => Subscription) private _subs;
    /// planId => subscriber => id of the currently active subscription (0 = none)
    mapping(uint256 => mapping(address => uint256)) public activeSubscriptionOf;

    uint256 private _lock = 1;

    // ---------------------------------------------------------------- events

    event PlanCreated(uint256 indexed planId, address indexed merchant, uint256 price, uint32 period, string name);
    event PlanStatusChanged(uint256 indexed planId, bool active);
    event Subscribed(uint256 indexed subId, uint256 indexed planId, address indexed subscriber, uint64 nextChargeAt);
    event Charged(uint256 indexed subId, uint256 indexed planId, address indexed subscriber, uint256 amount, uint64 nextChargeAt);
    event Cancelled(uint256 indexed subId, address indexed by);

    // ---------------------------------------------------------------- errors

    error ZeroAddress();
    error InvalidPrice();
    error InvalidPeriod();
    error NameTooLong();
    error UnknownPlan();
    error UnknownSubscription();
    error NotMerchant();
    error NotAuthorized();
    error PlanInactive();
    error AlreadySubscribed();
    error NotActive();
    error NotDue();
    error TransferFailed();
    error Reentrancy();

    // ---------------------------------------------------------------- modifiers

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address usdcToken) {
        if (usdcToken == address(0)) revert ZeroAddress();
        usdc = IERC20Minimal(usdcToken);
    }

    // ---------------------------------------------------------------- merchant

    /// @notice Publish a plan. The caller becomes the merchant that receives every payment.
    function createPlan(uint128 price, uint32 period, string calldata name) external returns (uint256 planId) {
        if (price == 0) revert InvalidPrice();
        if (period < MIN_PERIOD) revert InvalidPeriod();
        if (bytes(name).length > MAX_NAME_BYTES) revert NameTooLong();

        planId = ++planCount;
        _plans[planId] = Plan({merchant: msg.sender, price: price, period: period, active: true, name: name});
        emit PlanCreated(planId, msg.sender, price, period, name);
    }

    /// @notice Pause or resume a plan. A paused plan accepts no new subscribers and no renewals.
    function setPlanActive(uint256 planId, bool active) external {
        Plan storage p = _plans[planId];
        if (p.merchant == address(0)) revert UnknownPlan();
        if (p.merchant != msg.sender) revert NotMerchant();
        p.active = active;
        emit PlanStatusChanged(planId, active);
    }

    // ---------------------------------------------------------------- subscriber

    /// @notice Subscribe to a plan. Requires a prior USDC approval of at least one period's price.
    ///         The first period is charged immediately.
    function subscribe(uint256 planId) external nonReentrant returns (uint256 subId) {
        Plan storage p = _plans[planId];
        if (p.merchant == address(0)) revert UnknownPlan();
        if (!p.active) revert PlanInactive();
        if (activeSubscriptionOf[planId][msg.sender] != 0) revert AlreadySubscribed();

        subId = ++subscriptionCount;
        uint64 next = uint64(block.timestamp) + p.period;
        _subs[subId] = Subscription({
            planId: planId,
            subscriber: msg.sender,
            nextChargeAt: next,
            charges: 1,
            active: true
        });
        activeSubscriptionOf[planId][msg.sender] = subId;

        emit Subscribed(subId, planId, msg.sender, next);
        _pull(msg.sender, p.merchant, p.price);
        emit Charged(subId, planId, msg.sender, p.price, next);
    }

    /// @notice Stop a subscription. Callable by the subscriber or by the plan's merchant.
    function cancel(uint256 subId) external {
        Subscription storage s = _subs[subId];
        if (s.subscriber == address(0)) revert UnknownSubscription();
        if (!s.active) revert NotActive();
        if (msg.sender != s.subscriber && msg.sender != _plans[s.planId].merchant) revert NotAuthorized();

        s.active = false;
        activeSubscriptionOf[s.planId][s.subscriber] = 0;
        emit Cancelled(subId, msg.sender);
    }

    // ---------------------------------------------------------------- keeper

    /// @notice Charge the next period of a subscription once it is due. Callable by anyone;
    ///         funds always go from the subscriber to the plan's merchant.
    /// @dev    If a keeper is late, only ONE period is billed and the schedule restarts from now:
    ///         subscribers are never back-billed for several missed periods at once.
    function charge(uint256 subId) external nonReentrant {
        Subscription storage s = _subs[subId];
        if (s.subscriber == address(0)) revert UnknownSubscription();
        if (!s.active) revert NotActive();

        Plan storage p = _plans[s.planId];
        if (!p.active) revert PlanInactive();
        if (block.timestamp < s.nextChargeAt) revert NotDue();

        uint64 next = s.nextChargeAt + p.period;
        if (next <= block.timestamp) next = uint64(block.timestamp) + p.period;

        s.nextChargeAt = next;
        unchecked { s.charges += 1; }

        emit Charged(subId, s.planId, s.subscriber, p.price, next);
        _pull(s.subscriber, p.merchant, p.price);
    }

    // ---------------------------------------------------------------- views

    function getPlan(uint256 planId) external view returns (Plan memory) {
        if (_plans[planId].merchant == address(0)) revert UnknownPlan();
        return _plans[planId];
    }

    function getSubscription(uint256 subId) external view returns (Subscription memory) {
        if (_subs[subId].subscriber == address(0)) revert UnknownSubscription();
        return _subs[subId];
    }

    /// @notice Whether `charge(subId)` would succeed right now, with the reason if it would not.
    /// @return ok      true when a charge can be executed now
    /// @return reason  0 ok, 1 unknown/cancelled, 2 plan paused, 3 not due yet,
    ///                 4 allowance too low, 5 balance too low
    function canCharge(uint256 subId) external view returns (bool ok, uint8 reason) {
        Subscription storage s = _subs[subId];
        if (s.subscriber == address(0) || !s.active) return (false, 1);
        Plan storage p = _plans[s.planId];
        if (!p.active) return (false, 2);
        if (block.timestamp < s.nextChargeAt) return (false, 3);
        if (usdc.allowance(s.subscriber, address(this)) < p.price) return (false, 4);
        if (usdc.balanceOf(s.subscriber) < p.price) return (false, 5);
        return (true, 0);
    }

    // ---------------------------------------------------------------- internals

    function _pull(address from, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = address(usdc).call(
            abi.encodeWithSelector(IERC20Minimal.transferFrom.selector, from, to, amount)
        );
        if (!ok) revert TransferFailed();
        if (ret.length == 0) {
            // Tokens that return nothing are accepted, but only if a contract actually exists there
            // (a plain call to an address without code would otherwise "succeed" and move no funds).
            if (address(usdc).code.length == 0) revert TransferFailed();
        } else if (ret.length < 32 || !abi.decode(ret, (bool))) {
            revert TransferFailed();
        }
    }
}
