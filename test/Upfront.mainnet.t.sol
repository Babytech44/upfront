// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Upfront, IERC20, IVeBTC, IVoter, IReward} from "../src/Upfront.sol";

/// Optional smoke test against Mezo MAINNET state (read-only fork, nothing is sent).
/// Run:  MAINNET=1 forge test --match-contract UpfrontMainnetSmoke -vv
contract UpfrontMainnetSmoke is Test {
    address constant VE = 0x3D4b1b884A7a1E59fE8589a3296EC8f8cBB6f279;
    address constant VOTER = 0x48233cCC97B87Ba93bCA212cbEe48e3210211f03;
    address constant POOL = 0xb4D498029af77680cD1eF828b967f010d06C51CC;
    address constant MUSD = 0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186;
    uint256 constant POSITION = 5651; // 4.8 BTC, permanent, 5x, votes for sMUSD

    function test_fullCycle_onMainnetState() public {
        if (!vm.envOr("MAINNET", false)) {
            vm.skip(true);
        }
        vm.createSelectFork(vm.envOr("MEZO_MAINNET_RPC", string("https://mainnet.mezo.public.validationcloud.io")));
        vm.setEvmVersion("cancun");

        IVeBTC ve = IVeBTC(VE);
        IVoter voter = IVoter(VOTER);
        IERC20 musd = IERC20(MUSD);
        address treasury = makeAddr("treasury");
        address buyer = makeAddr("buyer");
        Upfront up = new Upfront(VE, VOTER, POOL, MUSD, treasury);
        IReward fees = up.feesReward();

        vm.prank(address(fees));
        musd.transfer(buyer, 2_000e18);
        vm.prank(buyer);
        (bool ok,) = MUSD.call(abi.encodeWithSignature("approve(address,uint256)", address(up), type(uint256).max));
        assertTrue(ok);

        vm.warp(voter.epochStart(block.timestamp) + 2 days);
        vm.roll(block.number + 1);

        address seller = ve.ownerOf(POSITION);
        uint256 backlog = fees.earned(MUSD, POSITION);
        uint256 sellerBefore = musd.balanceOf(seller);
        uint256 boost = ve.locked(POSITION).boost;
        emit log_named_decimal_uint("position boost", boost, 18);
        emit log_named_decimal_uint("unclaimed MUSD paid to seller at offer", backlog, 18);

        vm.startPrank(seller);
        (ok,) = VE.call(abi.encodeWithSignature("approve(address,uint256)", address(up), POSITION));
        assertTrue(ok);
        uint256 id = up.offer(POSITION, 1_200e18, 1_349e18, 26);
        vm.stopPrank();
        assertEq(musd.balanceOf(seller) - sellerBefore, backlog);
        vm.roll(block.number + 1);

        vm.prank(buyer);
        up.buy(id, 1);
        assertEq(musd.balanceOf(treasury), 12e18);
        assertEq(ve.locked(POSITION).boost, boost, "boost survives custody on mainnet");
        emit log_named_decimal_uint("weekly MUSD estimate", up.weeklyIncome(POSITION), 18);

        vm.warp(voter.epochStart(block.timestamp) + 1 weeks + 2 hours);
        vm.roll(block.number + 1);
        uint256 b0 = musd.balanceOf(buyer);
        up.collect(id);
        uint256 got = musd.balanceOf(buyer) - b0;
        assertGt(got, 0, "buyer is paid real MUSD after the weekly reset");
        emit log_named_decimal_uint("MUSD paid to buyer for the first week", got, 18);
        assertEq(ve.ownerOf(POSITION), address(up));
    }
}
