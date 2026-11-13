/* Checks of the wallet menu (Switch account, Disconnect) with a stand-in wallet that holds two accounts.
   Nothing is signed. One run uses a wallet that supports wallet_requestPermissions and
   wallet_revokePermissions (as MetaMask does), the other a wallet that knows neither.

   npm i playwright && npx playwright install chromium
   node web/test/wallet-menu-checks.js                      # against the live site
   SITE=http://localhost:8000 node web/test/wallet-menu-checks.js */
const { chromium } = require('playwright');
const URL = process.env.SITE || 'https://upfront-black.vercel.app';
const A = '0xc6bd6bad18f7c31fe002c94010d49cd812e93934', B = '0x00504ea32c2f40df4dde656e56760d7cea594a37';
let fail = 0, total = 0; const ok = (n, c, x = '') => { total++; console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? ' :: ' + String(x).slice(0, 220) : '')); if (!c) fail++; };
const mock = ([a, b, modern]) => {
  const load = () => { try { return JSON.parse(localStorage.getItem('mock-wallet')) || {}; } catch (e) { return {}; } };
  const st = Object.assign({ allowed: [], pick: a, reject: false }, load());
  const save = () => localStorage.setItem('mock-wallet', JSON.stringify({ allowed: st.allowed }));
  const subs = {}; const calls = [];
  const err = (code, message) => Object.assign(new Error(message), { code });
  window.__w = { st, calls, a, b };
  window.ethereum = {
    isMetaMask: true,
    on(ev, fn) { (subs[ev] = subs[ev] || []).push(fn); },
    async request({ method }) {
      calls.push(method);
      if (method === 'eth_chainId') return '0x7b7b';
      if (method === 'eth_accounts') return st.allowed;
      if (method === 'eth_requestAccounts') { if (!st.allowed.length) { if (st.reject) throw err(4001, 'User rejected the request.'); st.allowed = [st.pick]; save(); } return st.allowed; }
      if (method === 'wallet_requestPermissions') {
        if (!modern) throw err(-32601, 'The method "wallet_requestPermissions" does not exist / is not available.');
        if (st.reject) throw err(4001, 'User rejected the request.');
        st.allowed = [st.pick]; save(); (subs.accountsChanged || []).forEach((f) => f(st.allowed)); return [{ parentCapability: 'eth_accounts' }];
      }
      if (method === 'wallet_revokePermissions') {
        if (!modern) throw err(-32601, 'The method "wallet_revokePermissions" does not exist / is not available.');
        st.allowed = []; save(); (subs.accountsChanged || []).forEach((f) => f([])); return null;
      }
      throw err(4200, 'not supported in this check: ' + method);
    },
  };
};
const label = (p) => p.$eval('#connect', (e) => e.textContent.trim());
const toast = (p) => p.$eval('#toast', (e) => (e.style.display === 'block' ? e.innerText : ''));
const ready = (p) => p.waitForFunction(() => !document.getElementById('st-pay').textContent.includes('…') && document.getElementById('offers').innerText.includes('Offer #'), null, { timeout: 40000 });
(async () => {
  const b = await chromium.launch(); const errs = [];
  for (const modern of [true, false]) {
    const tag = modern ? 'modern wallet' : 'older wallet';
    const c = await b.newContext({ viewport: { width: 1200, height: 800 } }); const p = await c.newPage();
    p.on('pageerror', (e) => errs.push(tag + ': ' + e.message));
    await p.addInitScript(mock, [A, B, modern]);
    await p.goto(URL + '/', { waitUntil: 'load' }); await ready(p);
    ok(`[${tag}] starts disconnected, menu hidden`, (await label(p)) === 'Connect wallet' && !(await p.isVisible('#walletMenu')));
    await p.click('#connect');
    await p.waitForFunction(() => /0xC6Bd/.test(document.getElementById('connect').textContent), null, { timeout: 15000 }).catch(() => {});
    ok(`[${tag}] connect shows the first account`, (await label(p)) === '0xC6Bd…3934', await label(p));
    await p.waitForSelector('[data-sell]', { timeout: 40000 }).catch(() => {});
    await p.click('#connect');
    ok(`[${tag}] clicking the address opens the menu with both choices`, (await p.isVisible('#switchAcct')) && (await p.isVisible('#disconnect')) && (await p.$eval('#walletAddr', (e) => e.textContent)).toLowerCase() === A && (await p.getAttribute('#connect', 'aria-expanded')) === 'true');
    await p.keyboard.press('Escape');
    ok(`[${tag}] Escape closes the menu`, !(await p.isVisible('#walletMenu')));
    await p.click('#connect'); await p.click('h1');
    ok(`[${tag}] clicking elsewhere closes the menu`, !(await p.isVisible('#walletMenu')));

    // the visitor refuses the wallet's account picker
    await p.evaluate(() => { window.__w.st.reject = true; window.__w.st.pick = window.__w.b; });
    await p.click('#connect'); await p.click('#switchAcct'); await p.waitForTimeout(600);
    ok(`[${tag}] refusing the picker keeps the account`, (await label(p)) === '0xC6Bd…3934' && (modern ? /You cancelled/.test(await toast(p)) : /cannot switch accounts from a website/.test(await toast(p))), await toast(p));
    await p.evaluate(() => { window.__w.st.reject = false; });

    if (modern) {
      await p.click('#connect'); await p.click('#switchAcct');
      await p.waitForFunction(() => /0x0050/.test(document.getElementById('connect').textContent), null, { timeout: 15000 }).catch(() => {});
      ok(`[${tag}] Switch account moves to the account picked in the wallet`, (await label(p)) === '0x0050…4a37' && /Now using 0x0050…4a37/.test(await toast(p)), (await label(p)) + ' / ' + (await toast(p)));
      await p.waitForFunction(() => /0x0050…4a37/.test(document.getElementById('positions').innerText), null, { timeout: 40000 }).catch(() => {});
      ok(`[${tag}] the Sell section follows to the new account`, /0x0050…4a37/.test(await p.$eval('#positions', (e) => e.innerText)) && (await p.$eval('#addr', (e) => e.value)).toLowerCase() === B);
      ok(`[${tag}] My positions shows the new account's sales`, /You sold|You bought/.test(await p.$eval('#mineList', (e) => e.innerText)));
    }

    await p.click('#connect'); await p.click('#disconnect'); await p.waitForTimeout(500);
    ok(`[${tag}] Disconnect resets the button and says so`, (await label(p)) === 'Connect wallet' && /Disconnected/.test(await toast(p)) && !(await p.isVisible('#walletMenu')), await toast(p));
    ok(`[${tag}] Disconnect clears the page of that wallet`, /Connect a wallet/.test(await p.$eval('#mineList', (e) => e.innerText)) && /Nothing to show yet/.test(await p.$eval('#positions', (e) => e.innerText)) && (await p.$eval('#addr', (e) => e.value)) === '');
    ok(`[${tag}] the wallet was asked to revoke its permission`, (await p.evaluate(() => window.__w.calls)).includes('wallet_revokePermissions'));
    await p.reload({ waitUntil: 'load' }); await ready(p); await p.waitForTimeout(800);
    ok(`[${tag}] still disconnected after a reload`, (await label(p)) === 'Connect wallet', `wallet still allows: ${JSON.stringify(await p.evaluate(() => window.__w.st.allowed))}`);

    await p.evaluate(() => { window.__w.st.pick = window.__w.b; });
    await p.click('#connect');
    await p.waitForFunction(() => /0x/.test(document.getElementById('connect').textContent), null, { timeout: 15000 }).catch(() => {});
    const want = modern ? '0x0050…4a37' : '0xC6Bd…3934'; // an older wallet can only hand back the account it already allowed
    ok(`[${tag}] Connect after Disconnect ${modern ? 'lets the visitor pick the other account' : 'reconnects'}`, (await label(p)) === want && (await p.evaluate(() => window.__w.calls)).includes('wallet_requestPermissions'), await label(p));
    await p.reload({ waitUntil: 'load' }); await ready(p);
    await p.waitForFunction(() => /0x/.test(document.getElementById('connect').textContent), null, { timeout: 15000 }).catch(() => {});
    ok(`[${tag}] after reconnecting, a reload keeps the wallet connected`, (await label(p)) === want, await label(p));
    await c.close();
  }
  // phone width: the open menu stays on screen
  { const c = await b.newContext({ viewport: { width: 360, height: 740 } }); const p = await c.newPage();
    p.on('pageerror', (e) => errs.push('phone: ' + e.message));
    await p.addInitScript(mock, [A, B, true]);
    await p.goto(URL + '/', { waitUntil: 'load' }); await ready(p);
    await p.click('#connect'); await p.waitForFunction(() => /0x/.test(document.getElementById('connect').textContent), null, { timeout: 15000 });
    await p.click('#connect'); await p.waitForTimeout(300);
    const g = await p.evaluate(() => { const r = document.getElementById('walletMenu').getBoundingClientRect(); return { left: r.left, right: r.right, w: document.documentElement.clientWidth, over: document.documentElement.scrollWidth - document.documentElement.clientWidth, h: [...document.querySelectorAll('#walletMenu button')].map((e) => Math.round(e.getBoundingClientRect().height)) }; });
    ok('[phone 360px] menu fits on screen, no sideways scroll, buttons tall enough to tap', g.left >= 0 && g.right <= g.w && g.over <= 0 && g.h.every((x) => x >= 34), JSON.stringify(g));
    await p.screenshot({ path: process.env.SHOT || '/tmp/menu-phone.png' });
    await c.close(); }
  ok('no page errors', errs.length === 0, errs.join(' | '));
  await b.close();
  console.log(`\nTOTAL ${total} checks, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e.message.slice(0, 400)); process.exit(1); });
