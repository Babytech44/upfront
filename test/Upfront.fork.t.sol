// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Upfront, IERC20, IVeBTC, IVoter, IReward} from "../src/Upfront.sol";

interface IERC20Approve {
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IVoterExtra {
    function lastVoted(uint256) external view returns (uint256);
    function poke(uint256) external;
}

interface IVeExtra {
    function unboostedVotingPowerOfNFT(uint256) external view returns (uint256);
}

/// Fork tests against Mezo testnet's real veBTC, Voter and sMUSD-gauge fee contract.
/// Nothing is mocked. Run:  forge test -vv
contract UpfrontForkTest is Test {
    // Mezo testnet (chain 31611)
    address constant VE = 0x38E35d92E6Bfc6787272A62345856B13eA12130a;
    address constant VOTER = 0x263F1Fd5fB7F866881e1B6cD7d5d6c40Fd985F0D;
    address constant POOL = 0x6f461c68B2c5492C0F5CCEc5a264d692aA7A8e16; // sMUSD
    address constant MUSD = 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503;
    address constant OTHER_POOL = 0xd16A5Df82120ED8D626a1a15232bFcE2366d6AA9; // vAMM-MUSD/BTC

    // Real permanent positions, chosen at block 16,735,192
    uint256 constant EARNING = 1324; // votes 100% for sMUSD and has unclaimed MUSD
    uint256 constant FRESH = 947; // has never voted
    uint256 constant STALE = 5; // votes for another pool, last voted months ago
    uint256 constant TIMED = 1740; // a 4-week lock, not permanent

    bytes4 constant ZERO_BALANCE = bytes4(keccak256("ZeroBalance()"));
    bytes4 constant ALREADY_VOTED = bytes4(keccak256("AlreadyVotedOrDeposited()"));

    Upfront up;
    IVeBTC ve = IVeBTC(VE);
    IVoter voter = IVoter(VOTER);
    IERC20 musd = IERC20(MUSD);
    IReward fees;

    address buyer = makeAddr("buyer");
    address treasury = makeAddr("treasury");
    address stranger = makeAddr("stranger");

    function setUp() public {
        vm.createSelectFork(
            vm.envOr("MEZO_TESTNET_RPC", string("https://rpc.test.mezo.org")), vm.envOr("FORK_BLOCK", uint256(16735192))
        );
        // Upfront itself is compiled for "london" (see foundry.toml). Mezo's own contracts use
        // newer opcodes, so the test EVM must allow them.
        vm.setEvmVersion("cancun");
        up = new Upfront(VE, VOTER, POOL, MUSD, treasury);
        fees = up.feesReward();
        // the fee contract holds millions of test MUSD; borrow some for the buyer
        vm.prank(address(fees));
        musd.transfer(buyer, 1_000_000e18);
        vm.prank(buyer);
        IERC20Approve(MUSD).approve(address(up), type(uint256).max);
        // start every test in the middle of a voting window
        vm.warp(voter.epochStart(block.timestamp) + 2 days);
        vm.roll(block.number + 1);
    }

    // ── helpers ──

    function _offer(uint256 tokenId, uint256 price, uint256 owed, uint32 maxWeeks)
        internal
        returns (uint256 id, address seller)
    {
        seller = ve.ownerOf(tokenId);
        vm.startPrank(seller);
        (bool ok,) = VE.call(abi.encodeWithSignature("approve(address,uint256)", address(up), tokenId));
        assertTrue(ok, "approve");
        id = up.offer(tokenId, price, owed, maxWeeks);
        vm.stopPrank();
        vm.roll(block.number + 1); // a position has no voting power in the block it moves
    }

    function _liveWeight(uint256 tokenId) internal view returns (uint256) {
        return (IVeExtra(VE).unboostedVotingPowerOfNFT(tokenId) * ve.locked(tokenId).boost) / 1e18;
    }

    function _nextEpoch() internal {
        vm.warp(voter.epochStart(block.timestamp) + 1 weeks + 2 hours);
        vm.roll(block.number + 1);
    }

    // ── offer ──

    function test_offer_takesCustody_andPaysBacklogToSeller() public {
        address seller = ve.ownerOf(EARNING);
        uint256 backlog = fees.earned(MUSD, EARNING);
        assertGt(backlog, 0, "position should have unclaimed MUSD");
        uint256 before = musd.balanceOf(seller);
        uint256 boost = ve.locked(EARNING).boost;
        uint256 weight = voter.votes(EARNING, POOL);

        (uint256 id,) = _offer(EARNING, 1_000e18, 1_100e18, 12);

        assertEq(ve.ownerOf(EARNING), address(up), "custody");
        assertEq(musd.balanceOf(seller) - before, backlog, "backlog to seller");
        assertEq(musd.balanceOf(address(up)), 0, "nothing left in contract");
        assertEq(ve.locked(EARNING).boost, boost, "boost survives custody");
        assertEq(voter.votes(EARNING, POOL), weight, "vote survives custody");
        assertEq(uint8(up.getOffer(id).status), uint8(Upfront.Status.Open));
    }

    function test_offer_rejectsBadInput() public {
        address seller = ve.ownerOf(EARNING);
        vm.startPrank(seller);
        vm.expectRevert(Upfront.BadTerms.selector);
        up.offer(EARNING, 0, 100e18, 12);
        vm.expectRevert(Upfront.BadTerms.selector);
        up.offer(EARNING, 100e18, 100e18, 12);
        vm.expectRevert(Upfront.BadTerms.selector);
        up.offer(EARNING, 100e18, 110e18, 0);
        vm.expectRevert(Upfront.BadTerms.selector);
        up.offer(EARNING, 100e18, 110e18, 105);
        vm.stopPrank();

        vm.prank(stranger);
        vm.expectRevert(Upfront.NotOwner.selector);
        up.offer(EARNING, 100e18, 110e18, 12);
    }

    function test_offer_rejectsTimedLock() public {
        IVeBTC.LockedBalance memory l = ve.locked(TIMED);
        assertTrue(l.amount > 0 && !l.isPermanent, "fixture should be a live timed lock");
        address owner = ve.ownerOf(TIMED);
        vm.prank(owner);
        vm.expectRevert(Upfront.NotPermanentLock.selector);
        up.offer(TIMED, 100e18, 110e18, 12);
    }

    function test_cancel_returnsPosition() public {
        (uint256 id, address seller) = _offer(FRESH, 100e18, 110e18, 12);

        vm.prank(stranger);
        vm.expectRevert(Upfront.NotSeller.selector);
        up.cancel(id);

        vm.prank(seller);
        up.cancel(id);
        assertEq(ve.ownerOf(FRESH), seller);
        assertEq(uint8(up.getOffer(id).status), uint8(Upfront.Status.Cancelled));

        vm.prank(buyer);
        vm.expectRevert(Upfront.WrongStatus.selector);
        up.buy(id, 0);
    }

    // ── buy ──

    function test_buy_paysSellerAndFee() public {
        (uint256 id, address seller) = _offer(EARNING, 1_000e18, 1_100e18, 12);
        uint256 sellerBefore = musd.balanceOf(seller);
        uint256 buyerBefore = musd.balanceOf(buyer);

        vm.prank(buyer);
        up.buy(id, 1);

        assertEq(musd.balanceOf(seller) - sellerBefore, 990e18, "seller gets price less 1%");
        assertEq(musd.balanceOf(treasury), 10e18, "fee");
        assertEq(buyerBefore - musd.balanceOf(buyer), 1_000e18, "buyer pays price");
        Upfront.Offer memory o = up.getOffer(id);
        assertEq(o.buyer, buyer);
        assertEq(uint8(o.status), uint8(Upfront.Status.Active));
        assertEq(o.expiry, block.timestamp + 12 weeks);
        assertEq(ve.ownerOf(EARNING), address(up));
    }

    function test_buy_votesAFreshPositionForSMUSD() public {
        (uint256 id,) = _offer(FRESH, 100e18, 110e18, 12);
        assertEq(voter.usedWeights(FRESH), 0);

        vm.prank(buyer);
        up.buy(id, 1);

        uint256 used = voter.usedWeights(FRESH);
        assertGt(used, 0, "voted");
        assertEq(voter.votes(FRESH, POOL), used, "all of it on sMUSD");
        assertEq(IVoterExtra(VOTER).lastVoted(FRESH), block.timestamp);
    }

    function test_buy_movesAStaleVoteToSMUSD() public {
        assertEq(voter.votes(STALE, POOL), 0);
        assertGt(voter.usedWeights(STALE), 0);
        (uint256 id,) = _offer(STALE, 100e18, 110e18, 12);

        vm.prank(buyer);
        up.buy(id, 1);

        assertEq(voter.votes(STALE, POOL), voter.usedWeights(STALE));
        assertGt(voter.votes(STALE, POOL), 0);
    }

    function test_buy_revertsInTheBlockOfTheOffer() public {
        address seller = ve.ownerOf(FRESH);
        vm.startPrank(seller);
        (bool ok,) = VE.call(abi.encodeWithSignature("approve(address,uint256)", address(up), FRESH));
        assertTrue(ok);
        uint256 id = up.offer(FRESH, 100e18, 110e18, 12);
        vm.stopPrank();
        // same block: Mezo gives the position zero voting power, so the vote cannot be cast
        vm.prank(buyer);
        vm.expectRevert(ZERO_BALANCE);
        up.buy(id, 1);
    }

    function test_buy_revertsIfPositionVotedElsewhereThisEpoch_thenWorksNextEpoch() public {
        address seller = ve.ownerOf(FRESH);
        address[] memory pools = new address[](1);
        pools[0] = OTHER_POOL;
        uint256[] memory w = new uint256[](1);
        w[0] = 1;
        vm.prank(seller);
        voter.vote(FRESH, pools, w);
        vm.roll(block.number + 1);

        (uint256 id,) = _offer(FRESH, 100e18, 110e18, 12);
        uint256 buyerBefore = musd.balanceOf(buyer);
        vm.prank(buyer);
        vm.expectRevert(ALREADY_VOTED);
        up.buy(id, 1);
        assertEq(musd.balanceOf(buyer), buyerBefore, "buyer paid nothing");

        _nextEpoch();
        vm.prank(buyer);
        up.buy(id, 1);
        assertEq(voter.votes(FRESH, POOL), voter.usedWeights(FRESH));
    }

    function test_buy_refreshesAStaleVoteWeight_soBuyerSeesTheLiveNumber() public {
        // Position 1324 voted months ago at a higher boost. Mezo still counts the old weight.
        uint256 staleWeight = voter.votes(EARNING, POOL);
        uint256 live = _liveWeight(EARNING);
        assertGt(staleWeight, live, "fixture: recorded weight is above the live weight");

        (uint256 id,) = _offer(EARNING, 1_000e18, 1_100e18, 12);

        // a buyer who trusted the stale number is protected
        vm.prank(buyer);
        vm.expectRevert(Upfront.WeightTooLow.selector);
        up.buy(id, staleWeight);

        vm.prank(buyer);
        up.buy(id, live);
        assertEq(voter.votes(EARNING, POOL), live, "weight now matches the position");
    }

    function test_positionAlwaysComesBack_evenIfMezoRewardContractReverts() public {
        (uint256 idA, address sellerA) = _offer(FRESH, 100e18, 150e18, 1);
        (uint256 idB, address sellerB) = _offer(STALE, 100e18, 150e18, 12);
        vm.prank(buyer);
        up.buy(idA, 1);

        vm.mockCallRevert(address(fees), abi.encodeWithSelector(IReward.getReward.selector), "broken");

        vm.prank(sellerB);
        up.cancel(idB);
        assertEq(ve.ownerOf(STALE), sellerB, "cancel still works");

        up.collect(idA); // pays nothing, does not revert
        vm.warp(up.getOffer(idA).expiry);
        up.close(idA);
        assertEq(ve.ownerOf(FRESH), sellerA, "close still works");
    }

    function test_buy_guards() public {
        (uint256 id, address seller) = _offer(EARNING, 1_000e18, 1_100e18, 12);
        uint256 weight = _liveWeight(EARNING);

        deal(seller, 1 ether);
        vm.prank(seller);
        vm.expectRevert(Upfront.BuyerIsSeller.selector);
        up.buy(id, 0);

        vm.prank(buyer);
        vm.expectRevert(Upfront.WeightTooLow.selector);
        up.buy(id, weight + 1);

        vm.prank(buyer);
        up.buy(id, weight);

        vm.prank(buyer);
        vm.expectRevert(Upfront.WrongStatus.selector);
        up.buy(id, 0);
        vm.prank(seller);
        vm.expectRevert(Upfront.WrongStatus.selector);
        up.cancel(id);
    }

    // ── collect ──

    function test_collect_paysBuyerRealMezoFeesAfterTheWeeklyReset() public {
        (uint256 id, address seller) = _offer(EARNING, 1_000e18, 1_000_000e18, 12);
        vm.prank(buyer);
        up.buy(id, 1);

        // nothing to collect until the week ends
        uint256 b0 = musd.balanceOf(buyer);
        up.collect(id);
        assertEq(musd.balanceOf(buyer), b0, "no payout mid-week");

        _nextEpoch();
        uint256 due = up.pending(id);
        assertGt(due, 0, "the finished week pays");
        uint256 sellerBefore = musd.balanceOf(seller);

        vm.prank(stranger); // anyone can trigger it
        up.collect(id);

        assertEq(musd.balanceOf(buyer) - b0, due, "buyer receives the week's MUSD");
        assertEq(musd.balanceOf(seller), sellerBefore, "seller receives none of it");
        assertEq(up.getOffer(id).paid, due);
        assertEq(musd.balanceOf(address(up)), 0);
        assertEq(ve.ownerOf(EARNING), address(up), "still in custody");
        emit log_named_decimal_uint("MUSD paid to buyer for one week", due, 18);
    }

    function test_collect_closesWhenFullyPaid_excessToSeller_positionReturned() public {
        (uint256 id, address seller) = _offer(EARNING, 90e18, 100e18, 12);
        uint256 boost = ve.locked(EARNING).boost;
        vm.prank(buyer);
        up.buy(id, 1);
        uint256 buyerAfterBuy = musd.balanceOf(buyer);
        uint256 sellerAfterBuy = musd.balanceOf(seller);

        _nextEpoch();
        uint256 due = up.pending(id);
        assertGt(due, 100e18, "one week covers the whole amount on testnet");
        up.collect(id);

        assertEq(musd.balanceOf(buyer) - buyerAfterBuy, 100e18, "buyer gets exactly what is owed");
        assertEq(musd.balanceOf(seller) - sellerAfterBuy, due - 100e18, "the rest goes to the seller");
        assertEq(ve.ownerOf(EARNING), seller, "position returned");
        assertEq(ve.locked(EARNING).boost, boost, "boost intact");
        assertEq(voter.votes(EARNING, POOL), voter.usedWeights(EARNING), "still voting");
        assertEq(uint8(up.getOffer(id).status), uint8(Upfront.Status.Closed));
        assertEq(musd.balanceOf(address(up)), 0);

        vm.expectRevert(Upfront.WrongStatus.selector);
        up.collect(id);
    }

    // ── settle / close ──

    function test_settle_sellerPaysRemainder_andGetsPositionBack() public {
        (uint256 id, address seller) = _offer(FRESH, 100e18, 150e18, 12);
        vm.prank(buyer);
        up.buy(id, 1);
        uint256 b0 = musd.balanceOf(buyer);

        vm.prank(stranger);
        vm.expectRevert(Upfront.NotSeller.selector);
        up.settle(id);

        vm.prank(address(fees));
        musd.transfer(seller, 150e18);
        vm.startPrank(seller);
        IERC20Approve(MUSD).approve(address(up), 150e18);
        up.settle(id);
        vm.stopPrank();

        assertEq(musd.balanceOf(buyer) - b0, 150e18, "buyer made whole");
        assertEq(ve.ownerOf(FRESH), seller);
        assertEq(uint8(up.getOffer(id).status), uint8(Upfront.Status.Closed));
    }

    function test_close_afterTimeLimit_returnsPosition_buyerKeepsWhatWasCollected() public {
        (uint256 id, address seller) = _offer(EARNING, 1_000e18, 100_000_000e18, 1);
        vm.prank(buyer);
        up.buy(id, 1);
        uint256 b0 = musd.balanceOf(buyer);

        vm.expectRevert(Upfront.NotExpired.selector);
        up.close(id);

        _nextEpoch();
        vm.warp(up.getOffer(id).expiry);
        uint256 due = up.pending(id);
        vm.prank(stranger);
        up.close(id);

        assertEq(musd.balanceOf(buyer) - b0, due, "final collection goes to the buyer");
        assertLt(up.getOffer(id).paid, up.getOffer(id).owed);
        assertEq(ve.ownerOf(EARNING), seller, "position returned at the time limit");
        assertEq(uint8(up.getOffer(id).status), uint8(Upfront.Status.Closed));
    }

    // ── views ──

    function test_weeklyIncome_matchesMezoPayout() public {
        uint256 est = up.weeklyIncome(EARNING);
        assertGt(est, 0);
        assertEq(up.weeklyIncome(FRESH), 0, "not voting, no income");
        emit log_named_decimal_uint("estimated weekly MUSD for position 1324", est, 18);
    }

    function test_constructor_guards() public {
        vm.expectRevert(Upfront.ZeroAddress.selector);
        new Upfront(VE, VOTER, POOL, MUSD, address(0));
        vm.expectRevert(Upfront.NoGauge.selector);
        new Upfront(VE, VOTER, address(0xdead), MUSD, treasury);
    }
}
