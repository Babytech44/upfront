# Upfront

**Get your Bitcoin yield today.** Bitcoin locked on Mezo (veBTC) earns MUSD every week. Upfront lets the owner sell that future income for MUSD now, with no loan and no liquidation, and get the position back afterwards.

Mezo Buildathon, Wave 2. Track: DeFi. Status: deployed and source-verified on Mezo testnet.

## In plain terms: rent paid in advance

Think of a landlord. The house earns rent every month, but the landlord needs money today. Someone pays the next three months of rent now, at a small discount, and collects the rent from the tenant until they have received what was agreed. The landlord never sells the house and owes nothing.

Upfront does the same for Bitcoin locked on Mezo:

| In the story | On Mezo |
|---|---|
| The house | Your locked Bitcoin (veBTC). It stays locked and is never sold. |
| The rent | The MUSD that Mezo pays the position every week. |
| The landlord | The seller, who gets MUSD today. |
| The person who pays in advance | The buyer, who receives the weekly MUSD until paid. |
| The agent holding the papers | The Upfront contract. It hands the position back once the buyer has been paid. |

One difference: this rent is not fixed. Mezo sets it each week. If it falls, the buyer waits longer, and the seller never owes a top-up.

| | |
|---|---|
| Live app | **https://upfront-black.vercel.app** (works without a wallet) |
| Repository | https://github.com/Babytech44/upfront |
| Deck | [deck/Upfront-deck.pdf](deck/Upfront-deck.pdf) (11 slides) |
| Contract (Mezo testnet, 31611) | [`0x5D62b7E4c0Aa860F47A8Ab8B9410986A1fFd8b17`](https://explorer.test.mezo.org/address/0x5D62b7E4c0Aa860F47A8Ab8B9410986A1fFd8b17) |
| Source | Verified on the explorer (0.8.28, london, optimizer 200). The deployed bytecode matches this repo's build. |
| First position offered | veBTC #1744 (0.02 BTC, permanent) |

Transactions on Mezo testnet (all sent from the product's contract or to it, no scripts):

| Step | Transaction |
|---|---|
| Deploy Upfront | [`0x66b6b010…76dc4e`](https://explorer.test.mezo.org/tx/0x66b6b0102b2e0f884e1bb3611b5b4fbe8f6f88c3ff6f843e2ed89b7a3976dc4e) |
| Seller approves position #1744 | [`0x15e05331…10df9e`](https://explorer.test.mezo.org/tx/0x15e053312dd58010accf994f84cc56bfe2a791f28304b6d255fe2bbd0b10df9e) |
| Seller offers 30 MUSD today against 33 MUSD of income (offer 0) | [`0x822a79af…1d2ed5`](https://explorer.test.mezo.org/tx/0x822a79afdb02d6551f3a5bf54043b73578d0aca95d99ad41fe063a17671d2ed5) |
| Buyer pays 30 MUSD for offer 0; the contract votes the position for the sMUSD gauge | [`0x2cd45a92…ad194f`](https://explorer.test.mezo.org/tx/0x2cd45a923d0de4d09050182d42231678ba5098ea51ea16da74e1e7d06dad194f) |
| First payout to the buyer | TODO (after Thursday 19 Nov 2026, 00:00 UTC) |

> TODO before submitting: video link. The first payout hash can only be added after 19 Nov.

## How it works

One contract, `src/Upfront.sol`. No price oracle, no liquidation, no admin, no upgrade.

| Step | Who | What happens |
|---|---|---|
| `offer` | Seller | Names a price (MUSD today) and an amount owed (MUSD the buyer receives in total). The position moves into the contract. MUSD it had already earned is paid to the seller. |
| `buy` | Buyer | Pays the price. The seller receives it less a 1% fee. The contract votes the position for Mezo's sMUSD gauge at its live weight. |
| `collect` | Anyone | After each weekly reset, claims the position's MUSD from Mezo and sends it to the buyer. |
| End | | When the buyer has received the amount owed, the position returns to the seller. The seller can also pay the remainder early (`settle`). After the time limit anyone can return it (`close`). |

The seller sells an **amount**, not a number of weeks. Boost comes from veMEZO votes outside the contract, so a seller who lets boost fall only waits longer for their own position.

## What it uses on Mezo

- **veBTC** (`VotingEscrow`): custody of the position, `locked()`, `escrowType()`, `grantManager()`.
- **Voter**: `vote()` and `poke()` for the sMUSD gauge.
- **FeesVotingReward** of the sMUSD gauge: `getReward()`, which pays MUSD to the position's holder.
- **MUSD**: both the price and the income are MUSD. No mock tokens anywhere.

## Web app

`web/` is a static page: `index.html`, `app.js` and a local copy of ethers. There is no build step and no server.

- It reads from Mezo's public RPC, so the numbers, the open offers and every sale in progress show without a wallet.
- Paste any wallet address to see what its locked positions could get today. A link such as `?wallet=0x...` opens the page with that wallet already checked.
- A wallet is asked for only when you press a button that sends a transaction: offer, buy, collect, pay the rest early, cancel.
- Contract errors are shown in plain words.

Run it locally:

```bash
python3 -m http.server 8000 --directory web
# open http://localhost:8000
```

`web/test/` holds browser checks written with Playwright:

- `live-checks.js`: 35 checks without a wallet, run in Chromium, Firefox and WebKit. Loading, bad input, wallets with many positions, the sell maths, phone widths, and recovery when Mezo's RPC is unreachable.
- `fork-checks-1.js` and `fork-checks-2.js`: 35 checks of every wallet action against a local fork of Mezo testnet, with a stand-in wallet that fails the way MetaMask does. They cover the wrong network, refused requests, offer, cancel, buy, collect, settle, a stale page, a position that voted elsewhere, the first hour after a weekly reset, making a timed lock permanent, and returning a position after the time limit.
- `e2e.js`: the first, shorter run of the main path.

The header of each file has the commands.

## Tests

All tests run against a fork of Mezo's real contracts. Nothing is mocked.

```bash
curl -L https://foundry.paradigm.xyz | bash && foundryup   # once
forge test -vv                                              # 18 tests, Mezo testnet state
MAINNET=1 forge test --match-contract UpfrontMainnetSmoke -vv   # full cycle on mainnet state
```

What they show:

- A real position moves into the contract and keeps its boost and its vote.
- After the weekly reset, `collect` pays the buyer real MUSD from Mezo's fee contract.
- On mainnet state, position #5651 (4.8 BTC, 5x): the seller receives 20,523 MUSD it had left unclaimed, and the buyer is paid 534 MUSD for the first week.
- A recorded vote weight can be out of date. Testnet position #1324 was counted at 1.57 when its live weight was 0.99. `buy` refreshes it first, and the buyer's `minWeight` protects them.
- A position that voted elsewhere this week cannot be bought until the next reset; the buyer pays nothing.
- The position always comes back, even if Mezo's reward contract reverts.

The fork tests move time forward to pass the weekly reset. On the live chain the first real payout lands after Thursday 19 Nov 2026, 00:00 UTC.

## Deploy

```bash
# testnet (chain 31611). Gas is paid in test BTC from https://faucet.test.mezo.org
forge script script/Deploy.s.sol --rpc-url mezo_testnet --broadcast --private-key $PRIVATE_KEY
```

Set `FEE_RECIPIENT=0x...` to send the 1% fee somewhere other than the deployer.

No Foundry? `src/Upfront.sol` is a single file with no imports. Paste it into https://remix.ethereum.org, compile with 0.8.28, EVM version `london`, optimizer 200 runs, and deploy with these five arguments (testnet):

| Argument | Testnet (31611) | Mainnet (31612) |
|---|---|---|
| `ve_` | `0x38E35d92E6Bfc6787272A62345856B13eA12130a` | `0x3D4b1b884A7a1E59fE8589a3296EC8f8cBB6f279` |
| `voter_` | `0x263F1Fd5fB7F866881e1B6cD7d5d6c40Fd985F0D` | `0x48233cCC97B87Ba93bCA212cbEe48e3210211f03` |
| `pool_` (sMUSD) | `0x6f461c68B2c5492C0F5CCEc5a264d692aA7A8e16` | `0xb4D498029af77680cD1eF828b967f010d06C51CC` |
| `musd_` | `0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503` | `0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186` |
| `feeRecipient_` | your wallet | your wallet |

Verify the source on the explorer (single file, 0.8.28, london, optimizer 200): https://explorer.test.mezo.org

## First run on testnet, from the command line

Use test wallets only. `SELLER_KEY` holds a permanent veBTC position; `BUYER_KEY` holds test MUSD.

```bash
export RPC=https://rpc.test.mezo.org
export VE=0x38E35d92E6Bfc6787272A62345856B13eA12130a
export MUSD=0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503
export UP=<deployed Upfront address>
export SELLER=<seller address>

# 1. find the seller's position id; make it permanent if it is not
cast call $VE "ownerToNFTokenIdList(address,uint256)(uint256)" $SELLER 0 --rpc-url $RPC
export ID=<position id>
cast send $VE "lockPermanent(uint256)" $ID --rpc-url $RPC --private-key $SELLER_KEY

# 2. seller: offer 12 weeks' limit, 30 MUSD today against 33 MUSD of income
cast send $VE "approve(address,uint256)" $UP $ID --rpc-url $RPC --private-key $SELLER_KEY
cast send $UP "offer(uint256,uint256,uint256,uint32)" $ID $(cast to-wei 30) $(cast to-wei 33) 12 --rpc-url $RPC --private-key $SELLER_KEY

# 3. buyer: buy offer 0
cast send $MUSD "approve(address,uint256)" $UP $(cast to-wei 30) --rpc-url $RPC --private-key $BUYER_KEY
cast send $UP "buy(uint256,uint256)" 0 1 --rpc-url $RPC --private-key $BUYER_KEY

# 4. anyone: collect (pays zero until the weekly reset on Thursday 00:00 UTC)
cast send $UP "collect(uint256)" 0 --rpc-url $RPC --private-key $BUYER_KEY
cast call $UP "pending(uint256)(uint256)" 0 --rpc-url $RPC
```

Rules that come from Mezo's contracts:

- Do not vote with the position in the Mezo app in the week you offer it, unless you vote 100% for sMUSD.
- `buy` must be in a later block than `offer`.
- Buying is closed for the first hour after the weekly reset.
- Only permanent locks are accepted. Grant-backed and managed positions are refused.

## Known limits

- **The buyer carries the income risk.** The sMUSD gauge has paid veBTC voters exactly 10,000 MUSD a week on mainnet for seven weeks. If Mezo changes that, or more voters join the gauge, the buyer is repaid more slowly, and may not be repaid in full by the time limit.
- **Other income stays with the seller.** Upfront only claims MUSD from the sMUSD gauge's fee contract. Anything else the position earned stays claimable on Mezo after the position returns.
- **Small market today.** About 20 mainnet positions outside the two largest earn 10 MUSD a week or more.
- **Not audited.**

## Fee

1% of the price, paid by the seller at purchase. Fixed in the contract.
