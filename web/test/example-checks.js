/* Checks of the "See an example" button and of what a visitor sees right after connecting a wallet.
   The wallet here is a stand-in that only answers "which account" and "which network"; nothing is signed.

   npm i playwright && npx playwright install chromium
   node web/test/example-checks.js                      # against the live site
   SITE=http://localhost:8000 node web/test/example-checks.js */
const { chromium } = require('playwright');
const URL = process.env.SITE || 'https://upfront-black.vercel.app';
const EX = '0xC6Bd6baD18F7c31fE002c94010D49cD812E93934';
let fail = 0; const ok = (n, c, x = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? ' :: ' + x : '')); if (!c) fail++; };
(async () => {
  const b = await chromium.launch();
  for (const w of [1200, 360]) {
    const c = await b.newContext({ viewport: { width: w, height: 800 } }); const p = await c.newPage(); const errs = [];
    p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 120)); });
    await p.goto(URL + '/', { waitUntil: 'load' });
    // a first-time visitor: the example loads by itself
    await p.waitForSelector('[data-sell]', { timeout: 40000 }).catch(() => {});
    const txt = await p.$eval('#positions', (e) => e.innerText.replace(/\n+/g, ' | '));
    ok(`[${w}] the plain page opens with an example position and its slider`, /This is an example/.test(txt) && (await p.$$('[data-sell] [data-weeks]')).length >= 1, txt.slice(0, 160));
    ok(`[${w}] the address box is left empty for the visitor's own address`, (await p.$eval('#addr', (e) => e.value)) === '');
    ok(`[${w}] only the example position is shown, not the rest of that wallet`, (await p.$$('[data-sell]')).length === 1 && !/cannot be offered|holds \d+ locked/.test(txt));
    const g1 = await p.$eval('[data-get]', (e) => e.textContent);
    await p.$eval('[data-weeks]', (e) => { e.value = 8; e.dispatchEvent(new Event('input', { bubbles: true })); });
    const g2 = await p.$eval('[data-get]', (e) => e.textContent);
    ok(`[${w}] slider changes "You get"`, g1 !== g2 && /\d/.test(g2), `${g1} -> ${g2}`);
    ok(`[${w}] "Offer it" is off for a visitor`, await p.$eval('[data-act="offer"]', (e) => e.disabled));
    const over = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(`[${w}] no sideways scroll`, over <= 0, String(over));
    ok(`[${w}] no page errors`, errs.length === 0, errs.join(' | '));
    // Check another wallet afterwards: the example label must go away
    await p.fill('#addr', '0x000000000000000000000000000000000000dEaD'); await p.click('#check');
    await p.waitForFunction(() => /No locked Bitcoin found/.test(document.getElementById('positions').innerText), null, { timeout: 30000 }).catch(() => {});
    ok(`[${w}] checking another wallet replaces the example`, !/This is an example/.test(await p.$eval('#positions', (e) => e.innerText)));
    await c.close();
  }
  // the example cannot be read (Mezo's RPC refuses that one lookup): the page shows the hint and the button instead of an error
  { const c = await b.newContext(); const p = await c.newPage(); let blocked = true;
    await p.route('https://rpc.test.mezo.org/**', (r) => { const d = r.request().postData() || ''; return blocked && d.toLowerCase().includes(EX.slice(2).toLowerCase()) ? r.abort() : r.continue(); });
    await p.goto(URL + '/', { waitUntil: 'load' });
    await p.waitForSelector('[data-example]', { timeout: 90000 }).catch(() => {});
    const hint = await p.$eval('#positions', (e) => e.innerText.replace(/\n+/g, ' | '));
    ok('example unavailable: the hint and "See an example" show instead of an error', /Nothing to show yet/.test(hint) && /See an example/.test(hint) && !/Could not read/.test(hint), hint.slice(0, 160));
    blocked = false;
    await p.click('[data-example]');
    await p.waitForSelector('[data-sell]', { timeout: 40000 }).catch(() => {});
    ok('"See an example" loads it once Mezo answers again, and fills the address box', !!(await p.$('[data-sell]')) && (await p.$eval('#addr', (e) => e.value)) === EX);
    await c.close(); }
  // ?wallet= link still works and shows no hint while loading
  { const c = await b.newContext(); const p = await c.newPage();
    await p.goto(URL + '/?wallet=' + EX, { waitUntil: 'load' });
    let sawHint = false; const t = Date.now();
    while (Date.now() - t < 40000) { const s = await p.$eval('#positions', (e) => e.innerText); if (/Nothing to show yet/.test(s)) sawHint = true; if (await p.$('[data-sell]')) break; await p.waitForTimeout(100); }
    ok('?wallet= link loads the position', !!(await p.$('[data-sell]')));
    ok('?wallet= link never flashes the hint', !sawHint);
    await c.close(); }
  // a wallet that connects: the page should show its positions without pressing "Use my wallet"
  for (const mode of ['at once', 'after example']) {
    const c = await b.newContext(); const p = await c.newPage();
    await p.addInitScript((acct) => {
      let on = false;
      window.ethereum = { isMetaMask: true, on() {}, removeListener() {},
        request: async ({ method }) => {
          if (method === 'eth_requestAccounts') { on = true; return [acct]; }
          if (method === 'eth_accounts') return on ? [acct] : [];
          if (method === 'eth_chainId') return '0x7b7b';
          if (method === 'net_version') return '31611';
          throw Object.assign(new Error('not supported in this check: ' + method), { code: 4200 });
        } };
    }, EX.toLowerCase());
    await p.goto(URL + '/', { waitUntil: 'load' });
    if (mode === 'after example') await p.waitForSelector('[data-sell]', { timeout: 40000 }); // otherwise connect while the example is still loading
    await p.click('#connect');
    await p.waitForFunction(() => { const x = document.querySelector('[data-act="offer"]'); return x && !x.disabled; }, null, { timeout: 40000 }).catch(() => {});
    const txt = await p.$eval('#positions', (e) => e.innerText);
    ok(`connect (${mode}): own position appears, "Offer it" is on, no example label`, !!(await p.$('[data-act="offer"]:not([disabled])')) && !/This is an example/.test(txt), (await p.$eval('#connect', (e) => e.textContent)));
    await c.close();
  }
  // connecting must not replace a wallet the visitor looked up on purpose
  { const c = await b.newContext(); const p = await c.newPage();
    await p.addInitScript(() => { let on = false; const A = '0x000000000000000000000000000000000000dead'; window.ethereum = { on() {}, request: async ({ method }) => { if (method === 'eth_chainId') return '0x7b7b'; if (method === 'eth_requestAccounts') { on = true; return [A]; } if (method === 'eth_accounts') return on ? [A] : []; throw new Error('no'); } }; });
    await p.goto(URL + '/', { waitUntil: 'load' }); await p.waitForSelector('[data-sell]', { timeout: 40000 });
    await p.fill('#addr', '0x58C6A45AcFCc1fD0E5A103Cab2caE00b0B188EC5'); await p.click('#check');
    await p.waitForFunction(() => /0x58C6…8EC5 holds/.test(document.getElementById('positions').innerText), null, { timeout: 120000 }).catch(() => {});
    await p.click('#connect'); await p.waitForTimeout(4000);
    ok('connect keeps a wallet that was looked up on purpose', /0x58C6…8EC5 holds/.test(await p.$eval('#positions', (e) => e.innerText)) && /0x0000…dEaD/i.test(await p.$eval('#connect', (e) => e.textContent)), (await p.$eval('#positions', (e) => e.innerText)).slice(0, 80));
    await c.close(); }
  await b.close();
  console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED'); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e.message.slice(0, 400)); process.exit(1); });
