// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Upfront
/// @notice Sell the future MUSD income of a locked-BTC (veBTC) position on Mezo for MUSD today.
///
///   Seller: offers a permanent veBTC position, the MUSD they want now (`price`) and the MUSD
///           the buyer will receive in total (`owed`). The position moves into this contract.
///   Buyer:  pays `price`. The contract votes the position for the sMUSD gauge, whose voter
///           fees are paid in MUSD, and forwards every MUSD it earns to the buyer.
///   End:    when the buyer has received `owed`, or the seller pays the remainder, or the
///           time limit passes, the position goes back to the seller.
///
///   No loan, no oracle, no liquidation, no admin. The only privileged value is the address
///   that receives the 1% fee, and it is fixed at deployment.
///
/// @dev Facts about Mezo's contracts this design relies on (checked on testnet and mainnet):
///   - `Reward.getReward(tokenId, tokens)` pays `ownerOf(tokenId)`; only owner/approved may call.
///   - A veBTC has zero voting power in the block it is transferred, so the vote is cast in
///     `buy`, never in `offer`.
///   - A position can vote once per epoch. `buy` reverts if the position is not already voting
///     100% for the sMUSD pool and cannot vote right now.
///   - A standing vote keeps the weight it was cast with, even if the position's boost has
///     fallen since. Anyone can call `Voter.poke` to bring it up to date. `buy` does that first,
///     so the buyer's `minWeight` check is made against the live weight.
///   - Returning a position never depends on the reward contract: a failed claim is skipped.
///   - Boost is keyed to the veBTC id (BoostVoter.getBoost(tokenId)), so it survives custody.

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IVeBTC {
    struct LockedBalance {
        int128 amount;
        uint256 end;
        bool isPermanent;
        uint256 boost;
    }

    function locked(uint256 tokenId) external view returns (LockedBalance memory);
    function ownerOf(uint256 tokenId) external view returns (address);
    function transferFrom(address from, address to, uint256 tokenId) external;
    function escrowType(uint256 tokenId) external view returns (uint8);
    function grantManager(uint256 tokenId) external view returns (address);
}

interface IVoter {
    function ve() external view returns (address);
    function gauges(address pool) external view returns (address);
    function gaugeToFees(address gauge) external view returns (address);
    function vote(uint256 tokenId, address[] calldata poolVote, uint256[] calldata weights) external;
    function poke(uint256 tokenId) external;
    function votes(uint256 tokenId, address pool) external view returns (uint256);
    function usedWeights(uint256 tokenId) external view returns (uint256);
    function weights(address pool) external view returns (uint256);
    function epochStart(uint256 timestamp) external pure returns (uint256);
}

interface IReward {
    function getReward(uint256 tokenId, address[] calldata tokens) external;
    function earned(address token, uint256 tokenId) external view returns (uint256);
    function tokenRewardsPerEpoch(address token, uint256 epochStart) external view returns (uint256);
}

contract Upfront {
    // ───────────────────────────── Types ─────────────────────────────

    enum Status {
        None,
        Open, // offered, waiting for a buyer
        Active, // bought, income goes to the buyer
        Closed, // finished, position returned
        Cancelled // withdrawn by the seller before a sale
    }

    struct Offer {
        address seller;
        address buyer;
        uint256 tokenId;
        uint256 price; // MUSD the buyer pays today
        uint256 owed; // MUSD the buyer receives in total
        uint256 paid; // MUSD delivered to the buyer so far
        uint64 expiry; // after this time anyone can return the position (set at purchase)
        uint32 maxWeeks; // time limit chosen by the seller
        Status status;
    }

    // ─────────────────────────── Constants ───────────────────────────

    uint256 public constant FEE_BPS = 100; // 1% of the price, paid by the seller
    uint256 public constant MAX_WEEKS = 104;
    uint8 private constant NORMAL_ESCROW = 0;

    IVeBTC public immutable ve;
    IVoter public immutable voter;
    IERC20 public immutable musd;
    address public immutable pool; // the sMUSD vault, which is the gauge's pool
    IReward public immutable feesReward; // pays MUSD to veBTC that vote for `pool`
    address public immutable feeRecipient;

    // ──────────────────────────── Storage ────────────────────────────

    Offer[] private _offers;
    uint256 private _locked = 1;

    // ──────────────────────────── Events ─────────────────────────────

    event Offered(
        uint256 indexed id,
        address indexed seller,
        uint256 indexed tokenId,
        uint256 price,
        uint256 owed,
        uint32 maxWeeks
    );
    event Cancelled(uint256 indexed id);
    event Bought(uint256 indexed id, address indexed buyer, uint256 price, uint256 fee, uint64 expiry);
    event Collected(uint256 indexed id, uint256 toBuyer, uint256 toSeller);
    event Settled(uint256 indexed id, uint256 paidBySeller);
    event Closed(uint256 indexed id, uint256 paid, uint256 owed, bool expired);

    // ──────────────────────────── Errors ─────────────────────────────

    error Reentrancy();
    error ZeroAddress();
    error WrongVoter();
    error NoGauge();
    error BadTerms();
    error NotOwner();
    error NotPermanentLock();
    error NotPlainPosition();
    error NotSeller();
    error BuyerIsSeller();
    error WrongStatus();
    error NotVotingForPool();
    error WeightTooLow();
    error NotExpired();
    error TransferFailed();

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    // ───────────────────────── Constructor ───────────────────────────

    constructor(address ve_, address voter_, address pool_, address musd_, address feeRecipient_) {
        if (ve_ == address(0) || voter_ == address(0) || pool_ == address(0) || musd_ == address(0)) {
            revert ZeroAddress();
        }
        if (feeRecipient_ == address(0)) revert ZeroAddress();
        if (IVoter(voter_).ve() != ve_) revert WrongVoter();

        address gauge = IVoter(voter_).gauges(pool_);
        if (gauge == address(0)) revert NoGauge();
        address fees = IVoter(voter_).gaugeToFees(gauge);
        if (fees == address(0)) revert NoGauge();

        ve = IVeBTC(ve_);
        voter = IVoter(voter_);
        pool = pool_;
        musd = IERC20(musd_);
        feesReward = IReward(fees);
        feeRecipient = feeRecipient_;
    }

    // ───────────────────────────── Seller ────────────────────────────

    /// @notice Offer the future income of a position. Requires `ve.approve(address(this), tokenId)`.
    /// @param tokenId  A permanent veBTC position owned by the caller.
    /// @param price    MUSD the seller wants today.
    /// @param owed     MUSD the buyer will receive in total. Must be more than `price`.
    /// @param maxWeeks Time limit, counted from the purchase. After it, the position comes back
    ///                 even if the buyer has not received `owed`.
    /// @dev   MUSD the position has already earned is paid to the seller here.
    function offer(uint256 tokenId, uint256 price, uint256 owed, uint32 maxWeeks)
        external
        nonReentrant
        returns (uint256 id)
    {
        if (price == 0 || owed <= price || maxWeeks == 0 || maxWeeks > MAX_WEEKS) revert BadTerms();
        if (ve.ownerOf(tokenId) != msg.sender) revert NotOwner();

        IVeBTC.LockedBalance memory lock = ve.locked(tokenId);
        if (!lock.isPermanent || lock.amount <= 0) revert NotPermanentLock();
        if (ve.escrowType(tokenId) != NORMAL_ESCROW || ve.grantManager(tokenId) != address(0)) {
            revert NotPlainPosition();
        }

        id = _offers.length;
        _offers.push(
            Offer({
                seller: msg.sender,
                buyer: address(0),
                tokenId: tokenId,
                price: price,
                owed: owed,
                paid: 0,
                expiry: 0,
                maxWeeks: maxWeeks,
                status: Status.Open
            })
        );

        ve.transferFrom(msg.sender, address(this), tokenId);
        _send(msg.sender, _claim(tokenId));

        emit Offered(id, msg.sender, tokenId, price, owed, maxWeeks);
    }

    /// @notice Withdraw an offer nobody has bought. Returns the position and anything it earned.
    function cancel(uint256 id) external nonReentrant {
        Offer storage o = _offers[id];
        if (o.status != Status.Open) revert WrongStatus();
        if (msg.sender != o.seller) revert NotSeller();

        o.status = Status.Cancelled;
        _send(o.seller, _claim(o.tokenId));
        ve.transferFrom(address(this), o.seller, o.tokenId);

        emit Cancelled(id);
    }

    /// @notice End a sale early by paying the buyer whatever is still owed.
    function settle(uint256 id) external nonReentrant {
        Offer storage o = _offers[id];
        if (o.status != Status.Active) revert WrongStatus();
        if (msg.sender != o.seller) revert NotSeller();

        _collect(id, o);
        uint256 remaining = o.owed - o.paid;
        if (remaining > 0) {
            o.paid = o.owed;
            _pull(msg.sender, o.buyer, remaining);
        }
        emit Settled(id, remaining);
        _close(id, o, false);
    }

    // ───────────────────────────── Buyer ─────────────────────────────

    /// @notice Buy an offer. Requires `musd.approve(address(this), price)`.
    /// @param minWeight The lowest vote weight on the sMUSD gauge the buyer accepts. It protects
    ///                  the buyer if the position's boost drops between the quote and the purchase.
    /// @dev   Income the position earned before this call belongs to the seller.
    function buy(uint256 id, uint256 minWeight) external nonReentrant {
        Offer storage o = _offers[id];
        if (o.status != Status.Open) revert WrongStatus();
        if (msg.sender == o.seller) revert BuyerIsSeller();

        uint64 expiry = uint64(block.timestamp + uint256(o.maxWeeks) * 1 weeks);
        o.status = Status.Active;
        o.buyer = msg.sender;
        o.expiry = expiry;

        _send(o.seller, _claim(o.tokenId));
        _ensureVote(o.tokenId);
        if (voter.votes(o.tokenId, pool) < minWeight) revert WeightTooLow();

        uint256 fee = (o.price * FEE_BPS) / 10_000;
        _pull(msg.sender, o.seller, o.price - fee);
        if (fee > 0) _pull(msg.sender, feeRecipient, fee);

        emit Bought(id, msg.sender, o.price, fee, expiry);
    }

    // ──────────────────────────── Anyone ─────────────────────────────

    /// @notice Claim the position's MUSD from Mezo and pass it to the buyer. Returns the
    ///         position to the seller once the buyer has received everything owed.
    function collect(uint256 id) external nonReentrant {
        Offer storage o = _offers[id];
        if (o.status != Status.Active) revert WrongStatus();

        _collect(id, o);
        if (o.paid == o.owed) _close(id, o, false);
    }

    /// @notice After the time limit, return the position to the seller. The buyer keeps what
    ///         was collected, including a final collection made here.
    function close(uint256 id) external nonReentrant {
        Offer storage o = _offers[id];
        if (o.status != Status.Active) revert WrongStatus();
        if (block.timestamp < o.expiry) revert NotExpired();

        _collect(id, o);
        _close(id, o, o.paid < o.owed);
    }

    // ───────────────────────────── Views ─────────────────────────────

    function offerCount() external view returns (uint256) {
        return _offers.length;
    }

    function getOffer(uint256 id) external view returns (Offer memory) {
        return _offers[id];
    }

    /// @notice MUSD that `collect` would claim for this offer right now.
    function pending(uint256 id) external view returns (uint256) {
        return feesReward.earned(address(musd), _offers[id].tokenId);
    }

    /// @notice MUSD a position earned in the last finished week at its current vote weight.
    ///         Zero if it is not voting for the sMUSD gauge. A guide for pricing, not a promise.
    function weeklyIncome(uint256 tokenId) external view returns (uint256) {
        uint256 total = voter.weights(pool);
        if (total == 0) return 0;
        uint256 lastEpoch = voter.epochStart(block.timestamp) - 1 weeks;
        return (feesReward.tokenRewardsPerEpoch(address(musd), lastEpoch) * voter.votes(tokenId, pool)) / total;
    }

    // ─────────────────────────── Internals ───────────────────────────

    /// @dev Claims MUSD for a position held here and returns the amount that arrived.
    ///      A failing reward contract must never trap a position, so a revert counts as zero.
    function _claim(uint256 tokenId) private returns (uint256) {
        address[] memory tokens = new address[](1);
        tokens[0] = address(musd);
        uint256 before = musd.balanceOf(address(this));
        try feesReward.getReward(tokenId, tokens) {} catch {}
        return musd.balanceOf(address(this)) - before;
    }

    function _collect(uint256 id, Offer storage o) private {
        uint256 got = _claim(o.tokenId);
        uint256 remaining = o.owed - o.paid;
        uint256 toBuyer = got < remaining ? got : remaining;
        uint256 toSeller = got - toBuyer;

        if (toBuyer > 0) {
            o.paid += toBuyer;
            _send(o.buyer, toBuyer);
        }
        if (toSeller > 0) _send(o.seller, toSeller);
        if (got > 0) emit Collected(id, toBuyer, toSeller);
    }

    function _close(uint256 id, Offer storage o, bool expired) private {
        o.status = Status.Closed;
        ve.transferFrom(address(this), o.seller, o.tokenId);
        emit Closed(id, o.paid, o.owed, expired);
    }

    /// @dev Makes sure the whole vote of a position is on the sMUSD pool at its live weight.
    ///      Already voting there: refresh the weight. Otherwise: cast the vote. Mezo's Voter
    ///      reverts if the position already voted elsewhere this epoch, or in the hour after
    ///      the weekly reset, so `buy` is unavailable in those cases.
    function _ensureVote(uint256 tokenId) private {
        uint256 used = voter.usedWeights(tokenId);
        if (used != 0 && voter.votes(tokenId, pool) == used) {
            voter.poke(tokenId);
        } else {
            address[] memory pools = new address[](1);
            pools[0] = pool;
            uint256[] memory weights = new uint256[](1);
            weights[0] = 1;
            voter.vote(tokenId, pools, weights);
        }

        used = voter.usedWeights(tokenId);
        if (used == 0 || voter.votes(tokenId, pool) != used) revert NotVotingForPool();
    }

    function _send(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, bytes memory data) = address(musd).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        _checked(ok, data);
    }

    function _pull(address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) = address(musd).call(abi.encodeCall(IERC20.transferFrom, (from, to, amount)));
        _checked(ok, data);
    }

    function _checked(bool ok, bytes memory data) private pure {
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
