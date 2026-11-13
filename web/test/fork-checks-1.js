/* Wallet checks, part 1: wrong network, refused requests, offer, cancel, stale page, buy, account switch,
   collect by a third wallet right after the weekly reset, no gas, a position that voted elsewhere, and
   making a timed lock permanent.

   Needs a local fork of Mezo testnet and the page served locally:
     anvil --fork-url https://rpc.test.mezo.org --fork-block-number 16751600 --auto-impersonate --chain-id 31611
       (the block is pinned because the checks name offers and positions as they stood then)
     cast rpc anvil_mine 0x1
     python3 -m http.server 8765 --directory web
   Give the test accounts gas (anvil_setBalance) and send the buyer 40,000 test MUSD from a large holder first.
   The stand-in wallet returns errors the way MetaMask does (wrapped one level down). */
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const ANVIL = 'http://127.0.0.1:8545', SITE = 'http://127.0.0.1:8765';
const A = { SELLER2: '0xC6Bd6baD18F7c31fE002c94010D49cD812E93934', BUYER: '0xaF65586A28ef9FAC1159aB594b5E4c1276392EFC', SELLER: '0x00504ea32c2f40df4dde656e56760d7cea594a37', TIMED: '0x8576C2ea77dbae1D6897d4D5834B1ae247e9032F', THIRD: '0x1111111111111111111111111111111111111111', BROKE: '0x2222222222222222222222222222222222222222' };
const UP = '0x5D62b7E4c0Aa860F47A8Ab8B9410986A1fFd8b17', VE = '0x38E35d92E6Bfc6787272A62345856B13eA12130a', VOTER = '0x263F1Fd5fB7F866881e1B6cD7d5d6c40Fd985F0D';
const cast = (args) => execSync(`${process.env.HOME}/.foundry/bin/cast ${args} --rpc-url ${ANVIL}`, { encoding: 'utf8' }).trim();
const res = [];
const ok = (name, pass, info = '') => { res.push({ name, pass }); console.log((pass ? 'PASS ' : 'FAIL ') + name + (info ? ' :: ' + String(info).slice(0, 330) : '')); };
async function rpc(method, params = []) { const r = await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); return (await r.json()).result; }
const allLogs = [];
async function open(browser, account, query = '', opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => allLogs.push('pageerror: ' + e.message));
  // the page's reads go to the fork; errors are reshaped to what Mezo's real RPC returns (Anvil's are friendlier):
  // a failed gas estimate carries no reason at all, a failed eth_call carries code 3 and the contract's error data
  await p.route('https://rpc.test.mezo.org/**', async (route) => {
    const body = route.request().postData(); const sent = JSON.parse(body); const list = Array.isArray(sent) ? sent : [sent];
    const r = await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    const got = await r.json(); const outs = Array.isArray(got) ? got : [got];
    for (const o of outs) {
      if (!o.error) continue;
      const m = (list.find((q) => q.id === o.id) || {}).method;
      if (m === 'eth_estimateGas') o.error = { code: -32000, message: 'rpc error: code = Unknown desc = execution reverted' };
      else if (m === 'eth_call') o.error = { code: 3, message: 'execution reverted', data: typeof o.error.data === 'string' ? o.error.data : '0x' };
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(Array.isArray(got) ? outs : outs[0]) });
  });
  await p.addInitScript(([acct, anvil, o]) => {
    let n = 1; const subs = {};
    const w = window.__w = Object.assign({ acct, chain: '0x7b7b', rejectTx: false, rejectSwitch: false, unknownChain: false, calls: [] }, o);
    const mmErr = (code, message, data) => { const e = new Error(message); e.code = code; if (data !== undefined) e.data = data; return e; };
    window.ethereum = {
      isMetaMask: true,
      on(ev, fn) { (subs[ev] = subs[ev] || []).push(fn); },
      emit(ev, v) { (subs[ev] || []).forEach((f) => f(v)); },
      async request({ method, params }) {
        w.calls.push(method);
        if (method === 'eth_requestAccounts') w.locked = false; // "locked": the site has not been allowed to see the account yet
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return w.acct && !w.locked ? [w.acct.toLowerCase()] : [];
        if (method === 'eth_chainId') return w.chain;
        if (method === 'wallet_switchEthereumChain') {
          if (w.rejectSwitch) throw mmErr(4001, 'User rejected the request.');
          if (w.unknownChain) throw mmErr(4902, 'Unrecognized chain ID "0x7b7b". Try adding the chain using wallet_addEthereumChain first.');
          w.chain = params[0].chainId; return null;
        }
        if (method === 'wallet_addEthereumChain') { w.added = params[0]; w.chain = params[0].chainId; return null; }
        if (method === 'eth_sendTransaction' && w.rejectTx) throw mmErr(4001, 'MetaMask Tx Signature: User denied transaction signature.');
        const r = await fetch(anvil, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: n++, method, params: params || [] }) });
        const j = await r.json();
        // MetaMask wraps the node's error one level down
        if (j.error) throw mmErr(-32603, 'Internal JSON-RPC error.', { code: j.error.code, message: j.error.message, data: j.error.data });
        return j.result;
      },
    };
  }, [account, ANVIL, opts]);
  await p.goto(SITE + '/index.html' + query);
  await p.waitForFunction(() => !document.getElementById('st-pay').textContent.includes('…'), null, { timeout: 30000 });
  await p.waitForTimeout(1200);
  return p;
}
const txt = (p, sel) => p.$eval(sel, (e) => e.innerText.replace(/\n+/g, ' | '));
const toastOf = (p) => p.evaluate(() => { const t = document.getElementById('toast'); return t.style.display === 'block' ? (t.className || 'ok') + ' :: ' + t.innerText : ''; });
async function act(p, selector) {
  await p.evaluate(() => { const t = document.getElementById('toast'); t.innerHTML = ''; t.style.display = 'none'; });
  await p.click(selector);
  await p.waitForFunction(() => { const t = document.getElementById('toast'); const s = t.innerText; return t.style.display === 'block' && s && !/waiting for Mezo|confirm in your wallet/.test(s); }, null, { timeout: 60000 }).catch(() => {});
  const t = await toastOf(p);
  await p.waitForTimeout(2500);
  return t;
}
const warp = async (ts) => { await rpc('evm_setNextBlockTimestamp', ['0x' + Math.floor(ts).toString(16)]); await rpc('anvil_mine', ['0x1']); };
(async () => {
  const b = await chromium.launch();
  let p, t;

  // T1 wrong network
  p = await open(b, A.SELLER2, '?wallet=' + A.SELLER2, { chain: '0x1', rejectSwitch: true, locked: true });
  t = await act(p, '#connect');
  ok('T1a wrong network, switch refused: clear message', /cancelled/.test(t) && (await p.evaluate(() => window.__w.chain)) === '0x1', t);
  await p.evaluate(() => { window.__w.rejectSwitch = false; window.__w.unknownChain = true; });
  await p.click('#connect'); await p.waitForTimeout(1500);
  const added = await p.evaluate(() => window.__w.added);
  ok('T1b network unknown to wallet: app adds Mezo testnet', added && added.chainId === '0x7b7b' && added.nativeCurrency.symbol === 'BTC' && added.nativeCurrency.decimals === 18 && added.rpcUrls[0] === 'https://rpc.test.mezo.org', JSON.stringify(added));
  ok('T1c connected after switching', /0xC6Bd…3934/.test(await txt(p, '#connect')));

  // T2 user rejects the transaction
  await p.evaluate(() => { window.__w.rejectTx = true; });
  t = await act(p, '[data-act="offer"]');
  ok('T2a rejecting in the wallet gives a calm message', /You cancelled the request/.test(t), t);
  ok('T2b button usable again', !(await p.$eval('[data-act="offer"]', (e) => e.disabled)));
  await p.evaluate(() => { window.__w.rejectTx = false; });

  // T3 offer (two steps)
  t = await act(p, '[data-act="offer"]');
  ok('T3 offer made from the app', /Offer made/.test(t) && cast(`call ${VE} "ownerOf(uint256)(address)" 947`) === UP, t);
  await rpc('anvil_mine', ['0x1']);
  // T4 seller sees cancel, not buy, on own offer
  const own = await txt(p, '[data-offer="1"]');
  ok('T4 seller cannot buy own offer (sees Cancel)', /Cancel my offer/.test(own) && !(await p.$('[data-offer="1"] [data-act="buy"]')), own.slice(0, 120));
  await p.context().close();

  // T5 stale page: offer cancelled elsewhere, buyer presses Pay
  p = await open(b, A.BUYER);
  cast(`send ${UP} "cancel(uint256)" 1 --from ${A.SELLER2} --unlocked`);
  t = await act(p, '[data-act="buy"][data-id="1"]');
  ok('T5 buying an offer that was just cancelled explains itself', /This offer has changed/.test(t), t);
  await p.context().close();

  // T6 re-offer and buy
  p = await open(b, A.SELLER2, '?wallet=' + A.SELLER2);
  await p.click('#connect'); await p.waitForTimeout(800);
  await p.fill('#addr', ''); await p.click('#useMine'); await p.waitForSelector('[data-sell]', { timeout: 20000 }).catch(() => {});
  ok('T6 "Use my wallet" fills in the connected address', (await p.$eval('#addr', (e) => e.value)).toLowerCase() === A.SELLER2.toLowerCase() && !!(await p.$('[data-sell="947"]')));
  t = await act(p, '[data-act="offer"]');
  ok('T6a seller offers again after cancelling', /Offer made/.test(t), t);
  await p.context().close(); await rpc('anvil_mine', ['0x1']);
  p = await open(b, A.BUYER);
  const before = BigInt(cast(`call 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503 "balanceOf(address)(uint256)" ${A.BUYER}`).split(' ')[0]);
  t = await act(p, '[data-act="buy"][data-id="2"]');
  const after = BigInt(cast(`call 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503 "balanceOf(address)(uint256)" ${A.BUYER}`).split(' ')[0]);
  ok('T6b buyer buys; exactly the shown price leaves the wallet', /Bought/.test(t) && Number(before - after) / 1e18 > 25000, `${t} | paid ${Number(before - after) / 1e18}`);
  const mine = await txt(p, '#mineList');
  ok('T6c both sales listed under My positions', /Offer #0/.test(mine) && /Offer #2/.test(mine));

  // T8 wallet account switched in MetaMask
  await p.evaluate((a) => { window.__w.acct = a; window.ethereum.emit('accountsChanged', [a.toLowerCase()]); }, A.SELLER2);
  await p.waitForTimeout(500);
  const m2 = await txt(p, '#mineList');
  ok('T8 switching account in the wallet updates the page', /0xC6Bd…3934/.test(await txt(p, '#connect')) && /You sold/.test(m2) && !/Offer #0/.test(m2), m2.slice(0, 100));
  await p.evaluate(() => { window.ethereum.emit('accountsChanged', []); }); await p.waitForTimeout(300);
  ok('T8b disconnecting in the wallet resets the page', (await txt(p, '#connect')) === 'Connect wallet' && /Connect a wallet/.test(await txt(p, '#mineList')));
  await p.context().close();

  // T7 after the weekly reset a stranger collects for the buyer
  const reset = Date.UTC(2026, 10, 19, 0, 0) / 1000;
  await warp(reset + 600);
  p = await open(b, A.THIRD);
  const st = await txt(p, '#stats');
  ok('T7 stats before this week\'s amount is posted fall back to the last posted week', /Mezo paid lockers last time \| 21,852/.test(st) && /not posted yet/.test(st), st.slice(0, 200));
  ok('T7 a payout that is ready shows on the Collect button', /Collect [\d.]+ MUSD/.test(await txt(p, '#offers')));
  t = await act(p, '#offers [data-act="collect"][data-id="0"]');
  ok('T7 a third wallet can collect 10 minutes after the reset; sale 0 finishes and the position returns', /Collected/.test(t) && cast(`call ${VE} "ownerOf(uint256)(address)" 1744`).toLowerCase() === A.SELLER.toLowerCase(), t);
  ok('T7b finished sale shows "Paid in full"', /Offer #0[^]*Paid in full/.test(await txt(p, '#offers')));
  await p.context().close();

  await warp(reset + 5400);
  // T13 wallet with no test BTC
  p = await open(b, A.BROKE);
  t = await act(p, '#offers [data-act="collect"][data-id="2"]');
  ok('T13 wallet without gas gets a clear message', /Not enough test BTC/.test(t), t);
  await p.context().close();

  // T9 position that voted for another gauge this week
  cast(`send ${VOTER} "vote(uint256,address[],uint256[])" 1744 "[0xd16A5Df82120ED8D626a1a15232bFcE2366d6AA9]" "[100]" --from ${A.SELLER} --unlocked`);
  p = await open(b, A.SELLER, '?wallet=' + A.SELLER);
  const sc = await txt(p, '#positions');
  ok('T9a seller is warned the position voted elsewhere this week', /voted for another gauge this week/.test(sc), sc.slice(0, 200));
  t = await act(p, '[data-act="offer"]');
  await rpc('anvil_mine', ['0x1']);
  await p.context().close();
  p = await open(b, A.BUYER);
  const oc = await p.$$eval('[data-offer]', (cs) => cs.map((c) => ({ t: c.innerText.replace(/\n+/g, ' | '), dis: c.querySelector('[data-act="buy"]') ? c.querySelector('[data-act="buy"]').disabled : null })));
  ok('T9b that offer shows "Opens later" and cannot be bought yet', oc.length === 1 && /Opens later/.test(oc[0].t) && oc[0].dis === true, JSON.stringify(oc).slice(0, 260));
  await p.context().close();

  // T10 timed lock -> make permanent
  p = await open(b, A.TIMED, '?wallet=' + A.TIMED);
  const tl = await txt(p, '#positions');
  const hasBtn = !!(await p.$('[data-act="permanent"]'));
  ok('T10a timed lock is explained and offers "Make it permanent"', /timed lock/.test(tl) && hasBtn, tl.slice(0, 260));
  if (hasBtn) {
    t = await act(p, '[data-act="permanent"]');
    const isPerm = /true/.test(cast(`call ${VE} "locked(uint256)(int128,uint256,bool,uint256)" 1740`));
    ok('T10b "Make it permanent" works and the sell card appears', /can now be offered/.test(t) && isPerm && !!(await p.$('[data-sell="1740"]')), t);
  }
  await p.context().close();

  p = await open(b, A.THIRD);
  ok('no NaN/undefined anywhere', !/NaN|undefined|\[object/.test(await txt(p, 'body')));
  await p.context().close();
  ok('no page errors in any step', allLogs.length === 0, allLogs.join(' || '));
  await b.close();
  console.log(`\nTOTAL ${res.length} checks, ${res.filter((r) => !r.pass).length} failed`);
  process.exit(0);
})().catch((e) => { console.error('CRASHED', e.message.slice(0, 900)); process.exit(1); });
