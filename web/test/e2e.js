/* Browser test for the web app. It drives every wallet action through the real page against a local
   fork of Mezo testnet, with a stand-in wallet that signs as the test accounts.

   Run (three terminals, from the repo root):
     anvil --fork-url https://rpc.test.mezo.org --auto-impersonate --chain-id 31611
     cast rpc anvil_mine 0x1          # the fork needs one local block before it answers calls
     python3 -m http.server 8765 --directory web
     npm i playwright && npx playwright install chromium && node web/test/e2e.js

   Before running, give the four accounts gas with anvil_setBalance and send the buyer 40,000 test MUSD
   from any large holder (cast send --unlocked). Covers: offer, buy, buy without funds, collect in full,
   collect in part, settle early, offer again, cancel. */
const { chromium } = require('playwright');
const ANVIL = 'http://127.0.0.1:8545';
const SELLER2 = '0xC6Bd6baD18F7c31fE002c94010D49cD812E93934', BUYER = '0xaF65586A28ef9FAC1159aB594b5E4c1276392EFC', SELLER = '0x00504ea32c2f40df4dde656e56760d7cea594a37';
async function rpc(method, params = []) {
  const r = await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return (await r.json()).result;
}
async function open(browser, account, query = '') {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const p = await ctx.newPage();
  p.logs = [];
  p.on('console', (m) => { if (m.type() === 'error') p.logs.push(m.text().slice(0, 300)); });
  p.on('pageerror', (e) => p.logs.push('pageerror: ' + e.message));
  await p.route('https://rpc.test.mezo.org/**', async (route) => {
    const r = await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: route.request().postData() });
    await route.fulfill({ status: 200, contentType: 'application/json', body: await r.text() });
  });
  await p.addInitScript(([acct, anvil]) => {
    let n = 1;
    window.ethereum = {
      isMetaMask: true,
      on() {},
      async request({ method, params }) {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [acct.toLowerCase()];
        if (method === 'eth_chainId') return '0x7b7b';
        if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;
        const r = await fetch(anvil, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: n++, method, params: params || [] }) });
        const j = await r.json();
        if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; e.data = j.error.data; throw e; }
        return j.result;
      },
    };
  }, [account, ANVIL]);
  await p.goto('http://127.0.0.1:8765/index.html' + query);
  await p.waitForFunction(() => !document.getElementById('st-pay').textContent.includes('…'), null, { timeout: 30000 });
  await p.waitForTimeout(1500);
  return p;
}
const txt = (p, sel) => p.$eval(sel, (e) => e.innerText.replace(/\n+/g, ' | '));
async function act(p, selector, label) {
  await p.evaluate(() => { document.getElementById('toast').innerHTML = ''; });
  await p.click(selector);
  await p.waitForFunction(() => { const t = document.getElementById('toast').innerText; return t && !/waiting for Mezo|confirm in your wallet/.test(t); }, null, { timeout: 60000 }).catch(() => {});
  console.log(`[${label}] toast:`, await p.evaluate(() => { const t = document.getElementById('toast'); return (t.className || 'ok') + ' :: ' + t.innerText; }));
  await p.waitForTimeout(3000);
}
(async () => {
  const b = await chromium.launch();
  // 1. second seller offers position 947 from the app
  let p = await open(b, SELLER2, '?wallet=' + SELLER2);
  console.log('header button:', await txt(p, 'header'));
  await act(p, '[data-act="offer"]', 'offer');
  console.log('offerCount:', parseInt(await rpc('eth_call', [{ to: '0x5D62b7E4c0Aa860F47A8Ab8B9410986A1fFd8b17', data: '0x' + 'offerCount()' }, 'latest']).catch(() => '0x0')) || 'see cast');
  console.log('MINE (seller2):', (await txt(p, '#mineList')).slice(0, 500));
  console.log('OPEN OFFERS:', (await txt(p, '#offers')).slice(0, 700));
  await p.screenshot({ path: '/tmp/pw/s1.png', fullPage: true });
  console.log('logs:', JSON.stringify(p.logs)); await p.context().close();

  // 2a. a wallet with no MUSD tries to buy
  p = await open(b, '0x00504ea32c2f40df4dde656e56760d7cea594a37');
  await act(p, '[data-act="buy"][data-id="1"]', 'buy without MUSD');
  await p.context().close();
  // 2. buyer buys offer 1
  await rpc('anvil_mine', ['0x1']);
  p = await open(b, BUYER);
  await p.fill('[data-whatif="1"]', '50'); await p.waitForTimeout(200);
  console.log('what-if 50%:', await txt(p, '[data-offer="1"] [data-whatif-out]'));
  await act(p, '[data-act="buy"][data-id="1"]', 'buy');
  console.log('MINE (buyer):', (await txt(p, '#mineList')).slice(0, 900));
  await p.screenshot({ path: '/tmp/pw/s2.png', fullPage: true });
  console.log('logs:', JSON.stringify(p.logs)); await p.context().close();

  // 3. jump past the weekly reset; buyer collects offer 0 (should finish) and offer 1 (partial)
  const target = Date.UTC(2026, 10, 19, 1, 30) / 1000;
  await rpc('evm_setNextBlockTimestamp', ['0x' + target.toString(16)]); await rpc('anvil_mine', ['0x1']);
  p = await open(b, BUYER);
  console.log('MINE before collect:', (await txt(p, '#mineList')).slice(0, 900));
  await act(p, '#mineList [data-act="collect"][data-id="0"]', 'collect 0');
  await act(p, '#mineList [data-act="collect"][data-id="1"]', 'collect 1');
  console.log('MINE after collect:', (await txt(p, '#mineList')).slice(0, 900));
  console.log('STATS:', await txt(p, '#stats'));
  await p.screenshot({ path: '/tmp/pw/s3.png', fullPage: true });
  console.log('logs:', JSON.stringify(p.logs)); await p.context().close();

  // 4. seller2 pays the rest of offer 1 early
  p = await open(b, SELLER2);
  console.log('MINE (seller2) before settle:', (await txt(p, '#mineList')).slice(0, 700));
  await act(p, '#mineList [data-act="settle"][data-id="1"]', 'settle 1');
  console.log('MINE (seller2) after settle:', (await txt(p, '#mineList')).slice(0, 600));
  console.log('logs:', JSON.stringify(p.logs)); await p.context().close();

  // 5. first seller: position 1744 should be back and offerable
  p = await open(b, SELLER, '?wallet=' + SELLER);
  console.log('SELLER positions:', (await txt(p, '#positions')).slice(0, 600));
  await act(p, '[data-act="offer"]', 'offer again');
  await rpc('anvil_mine', ['0x1']);
  await act(p, '#mineList [data-act="cancel"]', 'cancel');
  console.log('MINE (seller):', (await txt(p, '#mineList')).slice(0, 500));
  // buying your own offer is impossible; an error path instead: buyer with no MUSD is covered by the balance check
  console.log('logs:', JSON.stringify(p.logs)); await p.context().close();
  await b.close();
})().catch((e) => { console.error('E2E FAILED', e.message.slice(0, 800)); process.exit(1); });
