/* Wallet checks, part 2 (run after part 1 on the same fork): the first hour after a reset, buying a position
   that last voted for another gauge, and returning a position after the time limit.

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
  const next = Date.UTC(2026, 10, 26, 0, 0) / 1000;
  // T12 first hour after a reset, with an open offer
  await warp(next + 600);
  p = await open(b, A.BUYER);
  let oc = await p.$$eval('[data-offer]', (cs) => cs.map((c) => ({ t: c.innerText.replace(/\n+/g, ' | '), dis: c.querySelector('[data-act="buy"]').disabled })));
  ok('T12 first hour after the reset: buying is paused with the reason shown', oc.length === 1 && /first hour after the weekly reset/.test(oc[0].t) && oc[0].dis === true, JSON.stringify(oc).slice(-230));
  const stats = await txt(p, '#stats');
  ok('T12b stats sensible right after a reset', !/NaN|undefined/.test(stats) && /in 6d 23h/.test(stats), stats);
  await p.context().close();
  // T14 after the first hour the same offer opens; the contract moves the vote to the savings vault
  await warp(next + 5400);
  p = await open(b, A.BUYER);
  oc = await p.$$eval('[data-offer]', (cs) => cs.map((c) => ({ t: c.innerText.replace(/\n+/g, ' | ').slice(0, 60), dis: c.querySelector('[data-act="buy"]').disabled })));
  ok('T14a offer opens after the first hour', oc.length === 1 && /Open/.test(oc[0].t) && oc[0].dis === false, JSON.stringify(oc));
  t = await act(p, '[data-act="buy"][data-id="3"]');
  const votes = cast(`call ${VOTER} "votes(uint256,address)(uint256)" 1744 0x6f461c68B2c5492C0F5CCEc5a264d692aA7A8e16`);
  ok('T14b buying a position that last voted elsewhere moves its vote to the savings vault', /Bought/.test(t) && /^20000000000000000/.test(votes), t + ' | votes ' + votes);
  const mine = await txt(p, '#mineList');
  ok('T14c collect buttons show what is ready', /Collect [\d,.]+ MUSD/.test(mine), mine.slice(0, 300));
  await p.context().close();
  // T11 time limit passes on offer 2
  const raw = cast(`call ${UP} "getOffer(uint256)((address,address,uint256,uint256,uint256,uint256,uint64,uint32,uint8))" 2`);
  const exp = parseInt(raw.split(',')[6].trim(), 10);
  console.log('INFO offer 2 expiry', exp, new Date(exp * 1000).toISOString());
  await warp(exp + 3600 * 30);
  p = await open(b, A.THIRD);
  const hasClose = !!(await p.$('#offers [data-act="close"][data-id="2"]'));
  ok('T11a after the time limit a "Return the position" button appears', hasClose, (await txt(p, '#offers')).slice(0, 300));
  if (hasClose) {
    t = await act(p, '#offers [data-act="close"][data-id="2"]');
    ok('T11b closing returns the position to the seller', /went back to the seller/.test(t) && cast(`call ${VE} "ownerOf(uint256)(address)" 947`).toLowerCase() === A.SELLER2.toLowerCase(), t);
    const after = await txt(p, '#offers');
    ok('T11c closed sale reads "Time limit reached"', /Offer #2[^]*?Time limit reached/.test(after), after.slice(-300));
  }
  const body = await txt(p, 'body');
  ok('no NaN/undefined anywhere', !/NaN|undefined|\[object/.test(body));
  console.log('INFO stats:', await txt(p, '#stats'));
  await p.context().close();
  ok('no page errors in any step', allLogs.length === 0, allLogs.join(' || '));
  await b.close();
  console.log(`\nTOTAL ${res.length} checks, ${res.filter((r) => !r.pass).length} failed`);
  process.exit(0);
})().catch((e) => { console.error('CRASHED', e.message.slice(0, 900)); process.exit(1); });
