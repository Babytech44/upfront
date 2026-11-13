/* Wallet checks, part 3 (fresh fork): how transactions are sent.
   The page estimates gas on Mezo's public RPC and hands the wallet a plain eth_sendTransaction request.
   These checks cover a newly locked position being offered and bought, a gas estimate that fails once,
   a gas estimate that keeps failing, and errors that come back from the wallet itself.

   Needs a local fork of Mezo testnet and the page served locally:
     anvil --fork-url https://rpc.test.mezo.org --auto-impersonate --chain-id 31611
     cast rpc anvil_mine 0x1
     python3 -m http.server 8765 --directory web
   SELLER_NEW must hold one permanent lock that is not yet offered; BUYER_NEW needs enough test MUSD to buy it. */
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
const ctl = { estimateFails: 0 }; // how many of the page's next gas estimates should fail for no good reason
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
      const asked = (list.find((q) => q.id === o.id) || {}).method;
      if (asked === 'eth_estimateGas' && ctl.estimateFails > 0) { ctl.estimateFails--; delete o.result; o.error = { code: -32000, message: 'rpc error: code = Internal desc = context deadline exceeded' }; continue; }
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
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return w.acct ? [w.acct.toLowerCase()] : [];
        if (method === 'eth_chainId') return w.chain;
        if (method === 'wallet_switchEthereumChain') {
          if (w.rejectSwitch) throw mmErr(4001, 'User rejected the request.');
          if (w.unknownChain) throw mmErr(4902, 'Unrecognized chain ID "0x7b7b". Try adding the chain using wallet_addEthereumChain first.');
          w.chain = params[0].chainId; return null;
        }
        if (method === 'wallet_addEthereumChain') { w.added = params[0]; w.chain = params[0].chainId; return null; }
        if (method === 'eth_sendTransaction' && w.rejectTx) throw mmErr(4001, 'MetaMask Tx Signature: User denied transaction signature.');
        if (method === 'eth_sendTransaction') { (w.sent = w.sent || []).push(params[0]); if (w.sendError) throw mmErr(w.sendError.code, w.sendError.message, w.sendError.data); }
        if (method === 'eth_sendTransaction' && !params[0].gas) { // like MetaMask: estimate, then add half again
          const e = await (await fetch(anvil, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: n++, method: 'eth_estimateGas', params: [params[0]] }) })).json();
          if (e.error) throw mmErr(-32603, 'Internal JSON-RPC error.', { code: e.error.code, message: e.error.message, data: e.error.data });
          params = [{ ...params[0], gas: '0x' + ((BigInt(e.result) * 3n) / 2n).toString(16) }];
        }
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

const SELLER_NEW = process.env.SELLER_NEW || '0x473c354eE13FfC8c3CA804ceB812e5aC456627D1';
const BUYER_NEW = process.env.BUYER_NEW || '0x00504ea32c2f40df4dde656e56760d7cea594a37';
const MUSD = '0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503';
const musdOf = (a) => BigInt(cast(`call ${MUSD} "balanceOf(address)(uint256)" ${a}`).split(' ')[0]);
(async () => {
  const b = await chromium.launch();
  await rpc('anvil_setBalance', [A.SELLER2, '0x8AC7230489E80000']);

  // U1: a wallet with a fresh permanent lock connects and offers one week
  let p = await open(b, SELLER_NEW);
  await p.click('#connect');
  await p.waitForSelector('[data-sell] [data-act="offer"]:not([disabled])', { timeout: 40000 }).catch(() => {});
  ok('U1a after Connect the wallet\'s own position shows with "Offer it" on', !!(await p.$('[data-sell] [data-act="offer"]:not([disabled])')), await txt(p, '#positions').catch(() => ''));
  await p.$eval('[data-sell] [data-weeks]', (e) => { e.value = 1; e.dispatchEvent(new Event('input', { bubbles: true })); });
  const get = await p.$eval('[data-get]', (e) => e.textContent);
  const count0 = Number(cast(`call ${UP} "offerCount()(uint256)"`).split(' ')[0]);
  let t = await act(p, '[data-sell] [data-act="offer"]');
  ok('U1b offer of one week goes through', /Offer made/.test(t), t);
  const w1 = await p.evaluate(() => ({ calls: window.__w.calls, sent: window.__w.sent }));
  ok('U1c the wallet was asked only to send: no gas estimate or block lookups through it', !w1.calls.some((m) => /estimateGas|blockNumber|getTransaction/.test(m)), [...new Set(w1.calls)].join(','));
  ok('U1d two requests (allow, offer), each with a gas limit', w1.sent.length === 2 && w1.sent.every((x) => /^0x[0-9a-f]+$/.test(x.gas) && x.from && x.to && x.data), JSON.stringify(w1.sent.map((x) => x.gas)));
  const id = count0;
  ok('U1e the offer is on chain', Number(cast(`call ${UP} "offerCount()(uint256)"`).split(' ')[0]) === count0 + 1);
  await p.context().close();

  // U2: a second wallet buys it
  p = await open(b, BUYER_NEW);
  await p.click('#connect'); await p.waitForTimeout(1500);
  const before = musdOf(SELLER_NEW);
  const sel = `[data-offer="${id}"] [data-act="buy"]`;
  await p.waitForSelector(sel, { timeout: 30000 }).catch(() => {});
  ok('U2a the new offer has a Pay button for another wallet', !!(await p.$(sel + ':not([disabled])')), await txt(p, '#offers').catch(() => ''));
  t = await act(p, sel);
  ok('U2b buying goes through', /^ok :: Bought/.test(t), t);
  const gained = Number(musdOf(SELLER_NEW) - before) / 1e18;
  ok('U2c the seller received what the page promised', Math.abs(gained - Number(get.replace(/,/g, ''))) < 0.01, `page said ${get}, seller got ${gained.toFixed(4)}`);
  await p.context().close();

  // F1: Mezo's gas estimate fails once for no good reason: the page tries again
  p = await open(b, A.SELLER2);
  await p.click('#connect');
  await p.waitForSelector('[data-sell] [data-act="offer"]:not([disabled])', { timeout: 40000 });
  ctl.estimateFails = 1;
  t = await act(p, '[data-sell] [data-act="offer"]');
  ok('F1 one failed gas estimate does not stop the offer', /Offer made/.test(t) && ctl.estimateFails === 0, t);

  // F2: the estimate keeps failing although the call itself is fine: the wallet is left to work out the gas
  const mine = `[data-offer] [data-act="cancel"]`;
  await p.waitForSelector(mine, { timeout: 30000 });
  await p.evaluate(() => { window.__w.sent = []; });
  ctl.estimateFails = 99;
  t = await act(p, mine);
  const sent2 = await p.evaluate(() => window.__w.sent);
  ctl.estimateFails = 0;
  ok('F2 estimate unavailable: sent without a gas limit and still cancelled', /Offer cancelled/.test(t) && sent2.length === 1 && !sent2[0].gas, t + ' ' + JSON.stringify(sent2.map((x) => x.gas)));

  // F3: the wallet itself answers with an error the page has no plain words for: show the wallet's words
  await p.waitForSelector('[data-sell] [data-act="offer"]:not([disabled])', { timeout: 40000 });
  await p.evaluate(() => { window.__w.sendError = { code: -32603, message: 'Internal JSON-RPC error.', data: { code: -32000, message: 'tx fee (1.20 ether) exceeds the configured cap (1.00 ether)' } }; });
  t = await act(p, '[data-sell] [data-act="offer"]');
  ok('F3 an unknown wallet error is shown in the wallet\'s own words', /The wallet reported: tx fee \(1\.20 ether\)/.test(t) && !/coalesce|Internal JSON-RPC/.test(t), t);
  ok('F3b the button works again afterwards', !(await p.$eval('[data-sell] [data-act="offer"]', (e) => e.disabled)));

  // F4: the wallet already has a request open
  await p.evaluate(() => { window.__w.sendError = { code: -32002, message: "Request of type 'eth_sendTransaction' already pending for origin. Please wait." }; });
  t = await act(p, '[data-sell] [data-act="offer"]');
  ok('F4 "request already pending" is explained', /already has a request waiting/.test(t), t);

  // F5: the wallet says nothing useful at all
  await p.evaluate(() => { window.__w.sendError = { code: -32603, message: 'Internal JSON-RPC error.' }; });
  t = await act(p, '[data-sell] [data-act="offer"]');
  ok('F5 a bare wallet error still gives a readable line', /The wallet reported: Internal JSON-RPC error\./.test(t), t);
  await p.context().close();

  ok('no page errors in any step', allLogs.length === 0, allLogs.join(' | '));
  await b.close();
  const failed = res.filter((r) => !r.pass);
  console.log(`\nTOTAL ${res.length} checks, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('CRASH', e.message.slice(0, 500)); process.exit(1); });
