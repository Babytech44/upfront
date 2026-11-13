// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {Upfront} from "../src/Upfront.sol";

/// Deploys Upfront to Mezo testnet (31611) or mainnet (31612).
///   forge script script/Deploy.s.sol --rpc-url mezo_testnet --broadcast --private-key $PRIVATE_KEY
/// Optional: FEE_RECIPIENT=0x... (defaults to the deployer)
contract Deploy is Script {
    function run() external returns (Upfront up) {
        (address ve, address voter, address pool, address musd) = _addresses();
        address feeRecipient = vm.envOr("FEE_RECIPIENT", msg.sender);

        vm.startBroadcast();
        up = new Upfront(ve, voter, pool, musd, feeRecipient);
        vm.stopBroadcast();

        console.log("Upfront deployed at", address(up));
        console.log("fee recipient      ", feeRecipient);
        console.log("sMUSD fee contract ", address(up.feesReward()));
    }

    function _addresses() internal view returns (address ve, address voter, address pool, address musd) {
        if (block.chainid == 31611) {
            ve = 0x38E35d92E6Bfc6787272A62345856B13eA12130a;
            voter = 0x263F1Fd5fB7F866881e1B6cD7d5d6c40Fd985F0D;
            pool = 0x6f461c68B2c5492C0F5CCEc5a264d692aA7A8e16; // sMUSD
            musd = 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503;
        } else if (block.chainid == 31612) {
            ve = 0x3D4b1b884A7a1E59fE8589a3296EC8f8cBB6f279;
            voter = 0x48233cCC97B87Ba93bCA212cbEe48e3210211f03;
            pool = 0xb4D498029af77680cD1eF828b967f010d06C51CC; // sMUSD
            musd = 0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186;
        } else {
            revert("unsupported chain");
        }
    }
}
