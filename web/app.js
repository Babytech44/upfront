/* Upfront web app. Plain JavaScript, no build step. Reads come from Mezo's public RPC, so the
   page works without a wallet. Writes go through the visitor's own wallet. */
(() => {
  'use strict';
  const { ethers } = window;

  const CFG = {
    chainId: 31611,
    chainHex: '0x7b7b',
    chainName: 'Mezo Testnet',
    rpc: 'https://rpc.test.mezo.org',
    explorer: 'https://explorer.test.mezo.org',
    up: '0x5D62b7E4c0Aa860F47A8Ab8B9410986A1fFd8b17',
    ve: '0x38E35d92E6Bfc6787272A62345856B13eA12130a',
    voter: '0x263F1Fd5fB7F866881e1B6cD7d5d6c40Fd985F0D',
    pool: '0x6f461c68B2c5492C0F5CCEc5a264d692aA7A8e16', // sMUSD
    musd: '0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503',
    fees: '0x613F6386A6549d29a1488F5246C58cE54B128ED4', // sMUSD gauge fee contract
  };

  const ABI = {
    up: [
      'function offerCount() view returns (uint256)',
      'function getOffer(uint256 id) view returns (tuple(address seller, address buyer, uint256 tokenId, uint256 price, uint256 owed, uint256 paid, uint64 expiry, uint32 maxWeeks, uint8 status))',
      'function offer(uint256 tokenId, uint256 price, uint256 owed, uint32 maxWeeks) returns (uint256)',
      'function buy(uint256 id, uint256 minWeight)',
      'function collect(uint256 id)',
      'function settle(uint256 id)',
      'function close(uint256 id)',
      'function cancel(uint256 id)',
    ],
    ve: [
      'function balanceOf(address owner) view returns (uint256)',
      'function ownerToNFTokenIdList(address owner, uint256 index) view returns (uint256)',
      'function locked(uint256 tokenId) view returns (tuple(int128 amount, uint256 end, bool isPermanent, uint256 boost))',
      'function unboostedVotingPowerOfNFT(uint256 tokenId) view returns (uint256)',
      'function escrowType(uint256 tokenId) view returns (uint8)',
      'function grantManager(uint256 tokenId) view returns (address)',
      'function getApproved(uint256 tokenId) view returns (address)',
      'function approve(address approved, uint256 tokenId)',
      'function lockPermanent(uint256 tokenId)',
    ],
    voter: [
      'function weights(address pool) view returns (uint256)',
      'function votes(uint256 tokenId, address pool) view returns (uint256)',
      'function usedWeights(uint256 tokenId) view returns (uint256)',
      'function lastVoted(uint256 tokenId) view returns (uint256)',
    ],
    fees: [
      'function tokenRewardsPerEpoch(address token, uint256 epochStart) view returns (uint256)',
      'function earned(address token, uint256 tokenId) view returns (uint256)',
    ],
    musd: [
      'function balanceOf(address) view returns (uint256)',
      'function allowance(address owner, address spender) view returns (uint256)',
      'function approve(address spender, uint256 amount) returns (bool)',
    ],
  };

  const E18 = 10n ** 18n;
  const WEEK = 604800;
  const STATUS = ['None', 'Open', 'Active', 'Closed', 'Cancelled'];
  const ZERO = '0x0000000000000000000000000000000000000000';

  const rpc = new ethers.JsonRpcProvider(CFG.rpc, CFG.chainId, { staticNetwork: true });
  const R = {
    up: new ethers.Contract(CFG.up, ABI.up, rpc),
    ve: new ethers.Contract(CFG.ve, ABI.ve, rpc),
    voter: new ethers.Contract(CFG.voter, ABI.voter, rpc),
    fees: new ethers.Contract(CFG.fees, ABI.fees, rpc),
    musd: new ethers.Contract(CFG.musd, ABI.musd, rpc),
  };

  const S = { account: null, signer: null, market: null, offers: [], lookup: null, busy: false };

  // ───────────── formatting ─────────────
  const $ = (id) => document.getElementById(id);
  const num = (x) => Number(ethers.formatUnits(x, 18));
  const fmt = (x, dp = 2) => num(x).toLocaleString('en-US', { minimumFractionDigits: dp === 0 ? 0 : Math.min(dp, 2), maximumFractionDigits: dp });
  const fmtBtc = (x) => num(x).toLocaleString('en-US', { maximumFractionDigits: 5 });
  const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);
  const same = (a, b) => a && b && a.toLowerCase() === b.toLowerCase();
  const txLink = (h) => `<a href="${CFG.explorer}/tx/${h}" target="_blank" rel="noopener">View transaction</a>`;
  const boostText = (b) => (b > 0n ? (Number(b) / 1e18).toFixed(2).replace(/\.?0+$/, '') : '1') + 'x boost';
  const weeksText = (w) => (w === Infinity ? 'never at this rate' : w <= 1 ? 'about 1 week' : `about ${w} weeks`);
  function untilText(ts, now) {
    let s = Math.max(0, ts - now);
    const d = Math.floor(s / 86400); s -= d * 86400;
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60);
    return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  }
  const dateText = (ts) => new Date(ts * 1000).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';

  // ───────────── toast and errors ─────────────
  let toastTimer;
  function toast(html, isErr = false, sticky = false) {
    const t = $('toast');
    t.innerHTML = html;
    t.className = isErr ? 'err' : '';
    t.style.display = 'block';
    clearTimeout(toastTimer);
    if (!sticky) toastTimer = setTimeout(() => (t.style.display = 'none'), isErr ? 9000 : 6000);
  }

  const ERRORS = {
    BadTerms: 'Those terms are not allowed. The buyer must receive more than they pay, and the time limit must be 1 to 104 weeks.',
    NotOwner: 'This wallet does not own that position.',
    NotPermanentLock: 'Only permanent locks can be offered. Make the lock permanent first.',
    NotPlainPosition: 'Grant-backed and managed positions cannot be offered.',
    NotSeller: 'Only the seller can do that.',
    BuyerIsSeller: 'You cannot buy your own offer. Use a different wallet.',
    WrongStatus: 'This offer has changed. Refresh the page.',
    WeightTooLow: "The position's voting weight dropped since you loaded the page. Refresh to see the new numbers.",
    NotExpired: 'The time limit has not passed yet.',
    TransferFailed: 'The MUSD transfer failed. Check your MUSD balance.',
    NotVotingForPool: 'The position could not be pointed at the savings-vault gauge.',
    ZeroBalance: 'Mezo gives a position no voting power in the block it moves. Try again in a few seconds.',
    AlreadyVotedOrDeposited: "This position already voted this week. It can be bought after Thursday's reset (00:00 UTC).",
    DistributeWindow: 'Mezo closes voting for the first hour after the weekly reset. Try again after 01:00 UTC.',
    SpecialVotingWindow: 'Mezo closes voting in the last hour of the week. Try again after the reset.',
    NotApprovedOrOwner: 'The contract is not approved to move this position yet.',
  };
  const SELECTORS = Object.fromEntries(Object.keys(ERRORS).map((n) => [ethers.id(n + '()').slice(0, 10), n]));
  function explain(e) {
    if (e && (e.code === 'ACTION_REJECTED' || e.code === 4001 || (e.info && e.info.error && e.info.error.code === 4001))) return 'You cancelled the request in your wallet.';
    const data = (e && (e.data || (e.info && e.info.error && e.info.error.data) || (e.error && e.error.data))) || '';
    const name = typeof data === 'string' ? SELECTORS[data.slice(0, 10)] : null;
    if (name) return ERRORS[name];
    const msg = (e && (e.shortMessage || e.message)) || String(e);
    if (/insufficient funds/i.test(msg)) return 'Not enough test BTC in this wallet to pay for gas.';
    if (/failed to fetch|network/i.test(msg)) return 'Could not reach the Mezo network. Try again.';
    return msg.length > 180 ? msg.slice(0, 180) + '…' : msg;
  }

  // ───────────── reads ─────────────
  async function loadMarket() {
    const block = await rpc.getBlock('latest');
    const now = Number(block.timestamp);
    const es = now - (now % WEEK);
    const [r0, r1, w] = await Promise.all([
      R.fees.tokenRewardsPerEpoch(CFG.musd, es),
      R.fees.tokenRewardsPerEpoch(CFG.musd, es - WEEK),
      R.voter.weights(CFG.pool),
    ]);
    S.market = { now, es, next: es + WEEK, reward: r0 > 0n ? r0 : r1, weight: w };
    return S.market;
  }

  // Everything the app needs to know about one veBTC position.
  async function positionInfo(tokenId) {
    const m = S.market;
    const [lock, unboosted, votes, used, lastVoted, escrowType, grant] = await Promise.all([
      R.ve.locked(tokenId),
      R.ve.unboostedVotingPowerOfNFT(tokenId).catch(() => 0n),
      R.voter.votes(tokenId, CFG.pool),
      R.voter.usedWeights(tokenId),
      R.voter.lastVoted(tokenId),
      R.ve.escrowType(tokenId),
      R.ve.grantManager(tokenId),
    ]);
    const boost = lock.boost;
    // Mezo reports zero voting power in the block a position changes hands; a permanent lock's power is its BTC amount.
    const base = unboosted > 0n ? unboosted : lock.isPermanent ? BigInt(lock.amount) : 0n;
    const liveWeight = (base * (boost > 0n ? boost : E18)) / E18;
    const onPool = used > 0n && votes === used;
    const total = onPool ? m.weight - votes + liveWeight : m.weight + liveWeight;
    const weekly = total > 0n ? (m.reward * liveWeight) / total : 0n;
    const firstHour = m.now < m.es + 3600;
    const lastHour = m.now >= m.next - 3600;
    const votedThisWeek = Number(lastVoted) >= m.es;
    let blocked = null;
    if (firstHour) blocked = 'Mezo closes voting for the first hour after the weekly reset. Buying opens at 01:00 UTC.';
    else if (lastHour) blocked = 'Mezo closes voting in the last hour of the week. Buying reopens after the reset.';
    else if (!onPool && votedThisWeek) blocked = "This position voted for another gauge this week. It can be bought after Thursday's reset.";
    return {
      tokenId: BigInt(tokenId), amount: lock.amount, permanent: lock.isPermanent, end: Number(lock.end), boost, liveWeight, onPool,
      weekly, blocked, plain: Number(escrowType) === 0 && grant === ZERO,
    };
  }

  async function loadOffers() {
    const n = Number(await R.up.offerCount());
    const raw = await Promise.all([...Array(n).keys()].map((i) => R.up.getOffer(i)));
    S.offers = await Promise.all(raw.map(async (o, id) => {
      const offer = { id, seller: o.seller, buyer: o.buyer, tokenId: o.tokenId, price: o.price, owed: o.owed, paid: o.paid, expiry: Number(o.expiry), maxWeeks: Number(o.maxWeeks), status: Number(o.status) };
      if (offer.status === 1 || offer.status === 2) {
        const [pos, pending] = await Promise.all([positionInfo(o.tokenId), R.fees.earned(CFG.musd, o.tokenId).catch(() => 0n)]);
        offer.pos = pos;
        offer.pending = pending;
      }
      return offer;
    }));
  }

  async function loadLookup(addr) {
    const n = Number(await R.ve.balanceOf(addr));
    const ids = await Promise.all([...Array(n).keys()].map((i) => R.ve.ownerToNFTokenIdList(addr, i)));
    const positions = (await Promise.all(ids.map((id) => positionInfo(id)))).filter((p) => p.amount > 0n);
    positions.sort((a, b) => (b.weekly > a.weekly ? 1 : -1));
    S.lookup = { addr, positions };
  }

  // ───────────── rendering ─────────────
  function renderStats() {
    const m = S.market;
    $('st-pay').textContent = fmt(m.reward, 0);
    const oneBtc = m.weight + E18 > 0n ? (m.reward * E18) / (m.weight + E18) : 0n;
    $('st-btc').textContent = fmt(oneBtc, 0);
    const paid = S.offers.reduce((a, o) => a + o.paid, 0n);
    const sold = S.offers.filter((o) => o.status === 2 || o.status === 3).length;
    $('st-paid').textContent = fmt(paid, 2);
    $('st-offers').textContent = `MUSD · ${sold} sale${sold === 1 ? '' : 's'}, ${S.offers.filter((o) => o.status === 1).length} open`;
    $('st-next').textContent = 'in ' + untilText(m.next, m.now);
    $('st-next-date').textContent = dateText(m.next);
    const f = $('f-contract');
    f.textContent = CFG.up;
    f.href = `${CFG.explorer}/address/${CFG.up}`;
  }

  const weeksToRepay = (remaining, weekly) => (weekly > 0n ? Math.ceil(Number(remaining) / Number(weekly)) : Infinity);

  function offerCard(o) {
    const p = o.pos;
    const gain = o.owed - o.price;
    const pct = (Number(gain) / Number(o.price)) * 100;
    const weeks = weeksToRepay(o.owed, p.weekly);
    const mine = same(o.seller, S.account);
    return `
    <div class="card" data-offer="${o.id}">
      <div class="row"><div><b>Offer #${o.id}</b> · position #${o.tokenId} <span class="tag">${fmtBtc(p.amount)} BTC</span> <span class="tag">${boostText(p.boost)}</span></div>
        <span class="tag ${p.blocked ? 'warn' : 'good'}">${p.blocked ? 'Opens later' : 'Open'}</span></div>
      <div class="grid2" style="margin-top:8px">
        <div><div class="note">You pay</div><div class="big">${fmt(o.price)} <small>MUSD</small></div></div>
        <div><div class="note">You receive</div><div class="big" style="color:var(--good)">${fmt(o.owed)} <small>MUSD</small></div></div>
      </div>
      <div class="row"><span class="k">Your gain</span><span class="v">${fmt(gain)} MUSD (${pct.toFixed(1)}%)</span></div>
      <div class="row"><span class="k">This position earns</span><span class="v">about ${fmt(p.weekly)} MUSD a week</span></div>
      <div class="row"><span class="k">Paid back in</span><span class="v">${weeksText(weeks)}</span></div>
      <div class="row"><span class="k">Time limit</span><span class="v">${o.maxWeeks} weeks from purchase</span></div>
      <div style="margin-top:8px">
        <div class="note">What if Mezo's weekly payout changes? <b><span data-whatif-label>100%</span> of today's payout</b></div>
        <input type="range" min="10" max="100" step="5" value="100" data-whatif="${o.id}">
        <div class="note" data-whatif-out>Paid back in ${weeksText(weeks)}.</div>
      </div>
      ${p.blocked ? `<div class="note warn" style="margin-top:8px">${p.blocked}</div>` : ''}
      <div class="actions">
        ${mine ? `<button class="ghost" data-act="cancel" data-id="${o.id}">Cancel my offer</button>` : `<button data-act="buy" data-id="${o.id}" ${p.blocked ? 'disabled' : ''}>Pay ${fmt(o.price)} MUSD</button>`}
        <span class="note" style="align-self:center">Seller ${short(o.seller)}</span>
      </div>
    </div>`;
  }

  function progressCard(o, role) {
    const pct = o.owed > 0n ? Math.min(100, (Number(o.paid) / Number(o.owed)) * 100) : 0;
    const m = S.market;
    const st = STATUS[o.status];
    const tag = o.status === 2 ? '<span class="tag good">Paying</span>' : o.status === 3 ? '<span class="tag">Finished</span>' : o.status === 4 ? '<span class="tag">Cancelled</span>' : '<span class="tag warn">Waiting for a buyer</span>';
    let lines = '';
    let actions = '';
    if (o.status === 2) {
      const remaining = o.owed - o.paid;
      const weeks = weeksToRepay(remaining, o.pos.weekly);
      const expired = m.now >= o.expiry;
      lines = `
        <div class="row"><span class="k">Ready to collect now</span><span class="v">${fmt(o.pending)} MUSD</span></div>
        <div class="row"><span class="k">Next payout from Mezo</span><span class="v">${dateText(m.next)} · about ${fmt(o.pos.weekly)} MUSD</span></div>
        <div class="row"><span class="k">Still owed to the buyer</span><span class="v">${fmt(remaining)} MUSD · ${weeksText(weeks)}</span></div>
        <div class="row"><span class="k">Time limit</span><span class="v">${dateText(o.expiry)}</span></div>`;
      actions += `<button class="small" data-act="collect" data-id="${o.id}" ${o.pending > 0n ? '' : 'disabled'}>Collect ${o.pending > 0n ? fmt(o.pending) + ' MUSD' : ''}</button>`;
      if (role === 'seller') actions += `<button class="small ghost" data-act="settle" data-id="${o.id}">Pay ${fmt(remaining)} MUSD and take my position back</button>`;
      if (expired) actions += `<button class="small ghost" data-act="close" data-id="${o.id}">Return the position (time limit passed)</button>`;
      if (o.pending === 0n) actions += `<span class="note" style="align-self:center">Nothing to collect until Mezo's weekly reset.</span>`;
    } else if (o.status === 1 && role === 'seller') {
      actions = `<button class="small ghost" data-act="cancel" data-id="${o.id}">Cancel and take my position back</button>`;
    }
    const who = role === 'seller' ? 'You sold' : role === 'buyer' ? 'You bought' : `Seller ${short(o.seller)}${o.buyer !== ZERO ? ' · buyer ' + short(o.buyer) : ''}`;
    const terms = o.status === 1 ? `${role === 'seller' ? 'You are asking' : 'Asking'} ${fmt(o.price)} MUSD today for ${fmt(o.owed)} MUSD of income`
      : o.status === 4 ? `${role === 'seller' ? 'You cancelled this' : 'Cancelled'} before anyone bought. The position went back to the seller.`
      : `${who} · ${fmt(o.price)} MUSD paid for ${fmt(o.owed)} MUSD of income`;
    const showPaid = o.status === 2 || o.status === 3;
    return `
    <div class="card">
      <div class="row"><div><b>Offer #${o.id}</b> · position #${o.tokenId} ${o.pos ? `<span class="tag">${fmtBtc(o.pos.amount)} BTC</span>` : ''}</div>${tag}</div>
      <div class="note">${terms}</div>
      ${showPaid ? `<div class="bar"><i style="width:${pct}%"></i></div>
      <div class="row"><span class="k">Paid to the buyer</span><span class="v">${fmt(o.paid)} of ${fmt(o.owed)} MUSD</span></div>` : ''}
      ${o.status === 3 ? `<div class="note">${o.paid >= o.owed ? 'Paid in full. The position is back with the seller.' : 'Time limit reached. The position is back with the seller.'}</div>` : ''}
      ${lines}
      ${actions ? `<div class="actions">${actions}</div>` : ''}
    </div>`;
  }

  function renderOffers() {
    const open = S.offers.filter((o) => o.status === 1);
    const rest = S.offers.filter((o) => o.status === 2 || o.status === 3);
    let html = open.length ? `<div class="grid2">${open.map(offerCard).join('')}</div>` : '<div class="empty">No open offers right now. Sellers: make one above.</div>';
    if (rest.length) {
      html += `<h3 style="margin:22px 0 10px;font-size:17px">Sales in progress and finished</h3><div class="grid2">${rest.map((o) => progressCard(o, 'public')).join('')}</div>`;
    }
    $('offers').innerHTML = html;
  }

  function renderMine() {
    if (!S.account) {
      $('mineList').innerHTML = '<div class="empty">Connect a wallet to see your offers.</div>';
      return;
    }
    const mine = S.offers.filter((o) => same(o.seller, S.account) || same(o.buyer, S.account));
    $('mineList').innerHTML = mine.length
      ? `<div class="grid2">${mine.map((o) => progressCard(o, same(o.seller, S.account) ? 'seller' : 'buyer')).join('')}</div>`
      : '<div class="empty">This wallet has no offers yet.</div>';
  }

  function sellCard(p, owner) {
    const head = `<div class="row"><div><b>Position #${p.tokenId}</b> <span class="tag">${fmtBtc(p.amount)} BTC</span> <span class="tag">${boostText(p.boost)}</span></div>
      <span class="note">earns about <b>${fmt(p.weekly)} MUSD</b> a week</span></div>`;
    const isMine = same(owner, S.account);
    if (!p.plain) return `<div class="card">${head}<div class="note warn">Grant-backed and managed positions cannot be offered.</div></div>`;
    if (!p.permanent) {
      const expired = p.end <= S.market.now;
      return `<div class="card">${head}
        <div class="note warn">${expired ? 'This lock has expired. Withdraw or re-lock it in the Mezo app.' : 'This is a timed lock. Upfront accepts permanent locks only, because a timed lock loses voting power every week.'}</div>
        ${!expired && isMine ? `<div class="actions"><button class="small" data-act="permanent" data-id="${p.tokenId}">Make it permanent</button></div>` : ''}</div>`;
    }
    if (p.weekly === 0n) return `<div class="card">${head}<div class="note">This position would earn nothing at the moment.</div></div>`;
    return `<div class="card" data-sell="${p.tokenId}" data-weekly="${p.weekly}">
      ${head}
      <div style="margin-top:10px">
        <div class="note">How many weeks of income do you want today? <b><span data-weeks-label>4</span> weeks</b></div>
        <input type="range" min="1" max="12" step="1" value="4" data-weeks>
      </div>
      <div class="row"><span class="k">Buyer's reward for waiting</span>
        <select data-reward><option value="5">5%</option><option value="10" selected>10%</option><option value="15">15%</option><option value="20">20%</option></select></div>
      <div style="margin:8px 0"><div class="note">You get, when a buyer accepts</div><div class="big" style="color:var(--good)"><span data-get>…</span> <small>MUSD</small></div></div>
      <div class="row"><span class="k">Buyer pays</span><span class="v"><span data-price></span> MUSD</span></div>
      <div class="row"><span class="k">Buyer receives from your position</span><span class="v"><span data-owed></span> MUSD</span></div>
      <div class="row"><span class="k">Position back in</span><span class="v" data-back></span></div>
      <div class="row"><span class="k">Time limit</span><span class="v"><span data-limit></span> weeks</span></div>
      <div class="row"><span class="k">Fee</span><span class="v">1% of what the buyer pays</span></div>
      ${p.blocked && !p.onPool ? `<div class="note warn">${p.blocked} You can still offer it now.</div>` : ''}
      <div class="actions">
        <button data-act="offer" data-id="${p.tokenId}" ${isMine ? '' : 'disabled'}>Offer it</button>
        ${isMine ? '<span class="note" style="align-self:center">Two confirmations: allow, then offer.</span>' : '<span class="note" style="align-self:center">Connect this wallet to make the offer.</span>'}
      </div>
    </div>`;
  }

  function sellTerms(card) {
    const weekly = BigInt(card.dataset.weekly);
    const weeks = Number(card.querySelector('[data-weeks]').value);
    const reward = Number(card.querySelector('[data-reward]').value);
    const cent = 10n ** 16n;
    const owed = ((weekly * BigInt(weeks)) / cent) * cent; // round down to 0.01 MUSD
    const price = (((owed * 100n) / BigInt(100 + reward)) / cent) * cent;
    const maxWeeks = Math.min(104, Math.max(4, weeks * 3));
    return { weeks, owed, price, get: (price * 99n) / 100n, maxWeeks };
  }

  function updateSellCard(card) {
    const t = sellTerms(card);
    card.querySelector('[data-weeks-label]').textContent = t.weeks;
    card.querySelector('[data-get]').textContent = fmt(t.get);
    card.querySelector('[data-price]').textContent = fmt(t.price);
    card.querySelector('[data-owed]').textContent = fmt(t.owed);
    card.querySelector('[data-back]').textContent = weeksText(t.weeks) + " at today's payout";
    card.querySelector('[data-limit]').textContent = t.maxWeeks;
    const btn = card.querySelector('[data-act="offer"]');
    if (btn && t.price === 0n) btn.disabled = true;
  }

  function renderLookup() {
    const el = $('positions');
    if (!S.lookup) { el.innerHTML = ''; return; }
    const { addr, positions } = S.lookup;
    const inUpfront = S.offers.filter((o) => same(o.seller, addr) && (o.status === 1 || o.status === 2));
    let html = '';
    if (inUpfront.length) {
      html += `<div class="note" style="margin-bottom:10px">${inUpfront.length} position${inUpfront.length === 1 ? ' of this wallet is' : 's of this wallet are'} already in Upfront: ${inUpfront.map((o) => `offer #${o.id} (${STATUS[o.status].toLowerCase()})`).join(', ')}. See <a href="#mine">My positions</a>.</div>`;
    }
    if (!positions.length) {
      html += `<div class="empty">No locked Bitcoin found in ${short(addr)}. Lock BTC in the <a href="https://testnet.mezo.org" target="_blank" rel="noopener">Mezo app</a> with "Auto max-lock" on, then come back.</div>`;
    } else {
      const now = S.market.now;
      const usable = positions.filter((p) => p.plain && (p.permanent || p.end > now));
      const other = positions.filter((p) => !usable.includes(p));
      const total = usable.filter((p) => p.permanent).reduce((a, p) => a + p.weekly, 0n);
      html += `<div class="note" style="margin-bottom:10px">${short(addr)} holds ${positions.length} locked position${positions.length === 1 ? '' : 's'}. ${total > 0n ? `The permanent ones could earn about <b>${fmt(total)} MUSD a week</b> from the savings-vault gauge.` : ''}</div>`;
      if (usable.length) html += `<div class="grid2">${usable.map((p) => sellCard(p, addr)).join('')}</div>`;
      if (other.length) {
        html += `<div class="card" style="margin-top:14px"><b>${other.length} position${other.length === 1 ? '' : 's'} that cannot be offered</b>` +
          other.map((p) => `<div class="row"><span class="k">Position #${p.tokenId} · ${fmtBtc(p.amount)} BTC</span><span class="note">${!p.plain ? 'grant-backed or managed' : 'lock expired: withdraw or re-lock it in the Mezo app'}</span></div>`).join('') + '</div>';
      }
    }
    el.innerHTML = html;
    el.querySelectorAll('[data-sell]').forEach(updateSellCard);
  }

  function renderAll() {
    renderStats();
    renderOffers();
    renderMine();
    renderLookup();
    $('connect').textContent = S.account ? short(S.account) : 'Connect wallet';
  }

  async function refresh() {
    await loadMarket();
    await loadOffers();
    if (S.lookup) await loadLookup(S.lookup.addr);
    renderAll();
  }

  // ───────────── wallet ─────────────
  async function connect() {
    if (!window.ethereum) {
      toast('No wallet found in this browser. Install MetaMask or another wallet, then reload.', true);
      return false;
    }
    try {
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
      await ensureChain();
      const bp = new ethers.BrowserProvider(window.ethereum);
      S.signer = await bp.getSigner();
      S.account = ethers.getAddress(accounts[0]);
      renderAll();
      return true;
    } catch (e) {
      toast(explain(e), true);
      return false;
    }
  }

  async function ensureChain() {
    const current = await window.ethereum.request({ method: 'eth_chainId' });
    if (current === CFG.chainHex) return;
    try {
      await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CFG.chainHex }] });
    } catch (e) {
      if (e.code !== 4902 && !/unrecognized|not been added/i.test(e.message || '')) throw e;
      await window.ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [{ chainId: CFG.chainHex, chainName: CFG.chainName, nativeCurrency: { name: 'Bitcoin', symbol: 'BTC', decimals: 18 }, rpcUrls: [CFG.rpc], blockExplorerUrls: [CFG.explorer] }],
      });
    }
  }

  async function writer() {
    if (!S.account && !(await connect())) return null;
    await ensureChain();
    const bp = new ethers.BrowserProvider(window.ethereum);
    S.signer = await bp.getSigner();
    return {
      up: new ethers.Contract(CFG.up, ABI.up, S.signer),
      ve: new ethers.Contract(CFG.ve, ABI.ve, S.signer),
      musd: new ethers.Contract(CFG.musd, ABI.musd, S.signer),
    };
  }

  async function send(label, fn) {
    toast(`${label}: confirm in your wallet…`, false, true);
    const tx = await fn();
    toast(`${label}: waiting for Mezo… ${txLink(tx.hash)}`, false, true);
    await tx.wait();
    return tx.hash;
  }

  // ───────────── actions ─────────────
  const ACTIONS = {
    async offer(id, btn) {
      const card = btn.closest('[data-sell]');
      const t = sellTerms(card);
      const w = await writer(); if (!w) return;
      if (!same(await R.ve.getApproved(id), CFG.up)) await send('Step 1 of 2, allow Upfront to hold the position', () => w.ve.approve(CFG.up, id));
      const h = await send('Step 2 of 2, make the offer', () => w.up.offer(id, t.price, t.owed, t.maxWeeks));
      toast(`Offer made. You will receive ${fmt(t.get)} MUSD when a buyer accepts. ${txLink(h)}`);
    },
    async buy(id) {
      const o = S.offers[id];
      const w = await writer(); if (!w) return;
      if (same(o.seller, S.account)) throw { data: ethers.id('BuyerIsSeller()').slice(0, 10) };
      const bal = await R.musd.balanceOf(S.account);
      if (bal < o.price) { toast(`This wallet has ${fmt(bal)} MUSD and the offer costs ${fmt(o.price)}. Swap test BTC for MUSD in the Mezo app first.`, true); return; }
      if ((await R.musd.allowance(S.account, CFG.up)) < o.price) await send('Step 1 of 2, allow Upfront to take the MUSD', () => w.musd.approve(CFG.up, o.price));
      const minWeight = (o.pos.liveWeight * 99n) / 100n;
      const h = await send('Step 2 of 2, buy', () => w.up.buy(id, minWeight));
      toast(`Bought. This position's MUSD now comes to you until you have received ${fmt(o.owed)} MUSD. ${txLink(h)}`);
    },
    async collect(id) {
      const w = await writer(); if (!w) return;
      const h = await send('Collect', () => w.up.collect(id));
      toast(`Collected and sent to the buyer. ${txLink(h)}`);
    },
    async settle(id) {
      const o = S.offers[id];
      const w = await writer(); if (!w) return;
      const remaining = o.owed - o.paid;
      if ((await R.musd.allowance(S.account, CFG.up)) < remaining) await send('Step 1 of 2, allow Upfront to take the MUSD', () => w.musd.approve(CFG.up, remaining));
      const h = await send('Step 2 of 2, pay the rest', () => w.up.settle(id));
      toast(`Paid. Your position is back in your wallet. ${txLink(h)}`);
    },
    async close(id) {
      const w = await writer(); if (!w) return;
      const h = await send('Return the position', () => w.up.close(id));
      toast(`The position went back to the seller. ${txLink(h)}`);
    },
    async cancel(id) {
      const w = await writer(); if (!w) return;
      const h = await send('Cancel the offer', () => w.up.cancel(id));
      toast(`Offer cancelled. Your position is back in your wallet. ${txLink(h)}`);
    },
    async permanent(id) {
      const w = await writer(); if (!w) return;
      const h = await send('Make the lock permanent', () => w.ve.lockPermanent(id));
      toast(`Done. This position can now be offered. ${txLink(h)}`);
    },
  };

  async function runAction(btn) {
    if (S.busy) return;
    const act = btn.dataset.act;
    const id = Number(btn.dataset.id);
    S.busy = true;
    btn.disabled = true;
    try {
      await ACTIONS[act](id, btn);
      await refresh();
    } catch (e) {
      console.error(e);
      toast(explain(e), true);
      btn.disabled = false;
    } finally {
      S.busy = false;
    }
  }

  async function doLookup(addr) {
    addr = (addr || '').trim();
    if (!ethers.isAddress(addr)) { toast('That does not look like a wallet address. It should start with 0x and have 42 characters.', true); return; }
    $('positions').innerHTML = '<div class="empty">Reading locked positions from Mezo…</div>';
    try {
      if (!S.market) await loadMarket();
      await loadLookup(ethers.getAddress(addr.toLowerCase()));
      renderLookup();
    } catch (e) {
      console.error(e);
      $('positions').innerHTML = `<div class="empty">Could not read from Mezo: ${explain(e)}</div>`;
    }
  }

  // ───────────── events ─────────────
  document.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-act]');
    if (btn && !btn.disabled) runAction(btn);
  });
  document.addEventListener('input', (ev) => {
    const sell = ev.target.closest('[data-sell]');
    if (sell) updateSellCard(sell);
    if (ev.target.matches('[data-whatif]')) {
      const o = S.offers[Number(ev.target.dataset.whatif)];
      const share = Number(ev.target.value);
      const weekly = (o.pos.weekly * BigInt(share)) / 100n;
      const weeks = weeksToRepay(o.owed, weekly);
      const card = ev.target.closest('[data-offer]');
      card.querySelector('[data-whatif-label]').textContent = share + '%';
      const byLimit = weekly * BigInt(o.maxWeeks);
      card.querySelector('[data-whatif-out]').innerHTML = weeks <= o.maxWeeks
        ? `Paid back in ${weeksText(weeks)}.`
        : `<span style="color:var(--bad)">Not fully paid by the ${o.maxWeeks}-week limit: you would receive about ${fmt(byLimit < o.owed ? byLimit : o.owed)} of ${fmt(o.owed)} MUSD.</span>`;
    }
  });
  $('check').addEventListener('click', () => doLookup($('addr').value));
  $('addr').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') doLookup($('addr').value); });
  $('useMine').addEventListener('click', async () => {
    if (!S.account && !(await connect())) return;
    $('addr').value = S.account;
    doLookup(S.account);
  });
  $('connect').addEventListener('click', connect);
  if (window.ethereum && window.ethereum.on) {
    window.ethereum.on('accountsChanged', (a) => { S.account = a.length ? ethers.getAddress(a[0]) : null; S.signer = null; renderAll(); });
    window.ethereum.on('chainChanged', () => { S.signer = null; });
  }

  // ───────────── start ─────────────
  (async () => {
    try {
      await refresh();
      const q = new URLSearchParams(location.search).get('wallet');
      if (q && ethers.isAddress(q)) { $('addr').value = q; doLookup(q); }
      if (window.ethereum) {
        const accounts = await window.ethereum.request({ method: 'eth_accounts' }).catch(() => []);
        if (accounts.length) { S.account = ethers.getAddress(accounts[0]); renderAll(); }
      }
    } catch (e) {
      console.error(e);
      $('offers').innerHTML = `<div class="empty">Could not reach the Mezo network: ${explain(e)} Reload to try again.</div>`;
    }
    // keep the numbers fresh without resetting a form the visitor is filling in
    setInterval(async () => {
      if (S.busy) return;
      try { await loadMarket(); await loadOffers(); renderStats(); renderOffers(); renderMine(); } catch (e) { /* try again next minute */ }
    }, 60000);
  })();
})();
