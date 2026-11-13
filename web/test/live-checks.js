/* Checks of the page without a wallet, in Chromium, Firefox and WebKit: loading, bad input, large wallets,
   the sell maths, phone widths, and what happens when Mezo's RPC is unreachable.

   npm i playwright && npx playwright install
   node web/test/live-checks.js                      # against the live site
   SITE=http://localhost:8000 node web/test/live-checks.js */
const pw = require('playwright');
const URL = process.env.SITE || 'https://upfront-black.vercel.app';
const res = [];
const ok = (name, pass, info = '') => { res.push({ name, pass, info }); console.log((pass ? 'PASS ' : 'FAIL ') + name + (info ? ' :: ' + info : '')); };
async function run(browserName) {
  let b;
  try { b = await pw[browserName].launch(); } catch (e) { console.log(`SKIP ${browserName}: ${e.message.split('\n')[0].slice(0, 120)}`); return; }
  console.log(`\n=== ${browserName} ===`);
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  const logs = [], failed = [], bad = [];
  p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.type() + ': ' + m.text().slice(0, 200)); });
  p.on('pageerror', (e) => logs.push('pageerror: ' + e.message.slice(0, 200)));
  p.on('requestfailed', (r) => failed.push(r.url().slice(0, 100)));
  p.on('response', (r) => { if (r.status() >= 400) bad.push(r.status() + ' ' + r.url().slice(0, 100)); });
  const toast = async () => p.evaluate(() => { const t = document.getElementById('toast'); return t.style.display === 'block' ? (t.className || 'ok') + ' :: ' + t.innerText : ''; });
  const t0 = Date.now();
  await p.goto(URL + '/', { waitUntil: 'load' });
  await p.waitForFunction(() => !document.getElementById('st-pay').textContent.includes('…'), null, { timeout: 30000 }).catch(() => {});
  const stats = await p.$eval('#stats', (e) => e.innerText.replace(/\n+/g, ' | '));
  ok('stats load', !stats.includes('…') && /\d/.test(stats), `${Date.now() - t0} ms`);
  ok('no NaN/undefined on page', !/NaN|undefined|null|\[object/.test(await p.$eval('body', (e) => e.innerText)));
  ok('offer 0 visible', /Offer #0/.test(await p.$eval('#offers', (e) => e.innerText)));
  ok('footer contract link', (await p.$eval('#f-contract', (e) => e.href)).endsWith('0x5D62b7E4c0Aa860F47A8Ab8B9410986A1fFd8b17'));
  // connect with no wallet
  await p.click('#connect'); await p.waitForTimeout(300);
  ok('connect without wallet gives a message', /No wallet found/.test(await toast()), await toast());
  await p.click('#useMine'); await p.waitForTimeout(300);
  ok('"Use my wallet" without wallet gives a message', /No wallet found/.test(await toast()));
  // invalid inputs
  for (const bad of ['hello', '0x123', '', '0x00504ea32c2f40df4dde656e56760d7cea594a3', '<img src=x onerror=alert(1)>']) {
    await p.fill('#addr', bad); await p.click('#check'); await p.waitForTimeout(250);
    ok(`invalid address "${bad.slice(0, 20)}" rejected`, /does not look like a wallet/.test(await toast()));
  }
  // uppercase / padded / wrong-checksum forms of a valid address
  for (const [label, v] of [['with spaces', '  0xc6bd6bad18f7c31fe002c94010d49cd812e93934  '], ['checksummed', '0xC6Bd6baD18F7c31fE002c94010D49cD812E93934'], ['upper-case hex', '0xC6BD6BAD18F7C31FE002C94010D49CD812E93934'], ['wrong mixed case', '0xc6Bd6baD18F7c31fE002c94010D49cD812E93934'], ['0X prefix', '0XC6BD6BAD18F7C31FE002C94010D49CD812E93934']]) {
    await p.evaluate(() => { document.getElementById('positions').innerHTML = ''; document.getElementById('toast').style.display = 'none'; });
    await p.fill('#addr', v); await p.press('#addr', 'Enter');
    const got = await p.waitForSelector('[data-sell]', { timeout: 20000 }).then(() => true).catch(() => false);
    ok(`valid address ${label} accepted (Enter key)`, got, got ? '' : await toast());
  }
  // sell card maths at the extremes
  const card = '[data-sell]';
  for (const [w, r] of [[1, '5'], [12, '20'], [4, '10']]) {
    await p.fill(card + ' [data-weeks]', String(w)); await p.selectOption(card + ' [data-reward]', r); await p.waitForTimeout(100);
    const v = await p.$eval(card, (c) => ({ weekly: c.dataset.weekly, get: c.querySelector('[data-get]').textContent, price: c.querySelector('[data-price]').textContent, owed: c.querySelector('[data-owed]').textContent, limit: c.querySelector('[data-limit]').textContent }));
    const n = (s) => Number(s.replace(/,/g, ''));
    const weekly = Number(BigInt(v.weekly)) / 1e18;
    const expOwed = Math.floor(weekly * w * 100) / 100, expPrice = Math.floor((expOwed * 100 / (100 + Number(r))) * 100) / 100;
    const good = Math.abs(n(v.owed) - expOwed) < 0.02 && Math.abs(n(v.price) - expPrice) < 0.02 && Math.abs(n(v.get) - expPrice * 0.99) < 0.02 && n(v.owed) > n(v.price) && Number(v.limit) === Math.min(104, Math.max(4, w * 3));
    ok(`sell maths ${w} weeks, ${r}% reward`, good, JSON.stringify(v));
  }
  // wallet with nothing
  await p.fill('#addr', '0x000000000000000000000000000000000000dEaD'); await p.click('#check');
  await p.waitForFunction(() => /No locked Bitcoin found/.test(document.getElementById('positions').innerText), null, { timeout: 20000 }).catch(() => {});
  ok('empty wallet message', /No locked Bitcoin found/.test(await p.$eval('#positions', (e) => e.innerText)));
  // big holders
  for (const [who, n] of [['0x58C6A45AcFCc1fD0E5A103Cab2caE00b0B188EC5', 72], ['0x134bEDB1aC051CD9DcdC2C340f86382Ca367976F', 243]]) {
    const t = Date.now();
    await p.fill('#addr', who); await p.click('#check');
    await p.waitForFunction(() => /holds \d+ locked|No locked|Could not read/.test(document.getElementById('positions').innerText), null, { timeout: 90000 }).catch(() => {});
    const txt = await p.$eval('#positions', (e) => e.innerText.replace(/\n+/g, ' | ').slice(0, 170));
    // the 243 positions of the second wallet are all empty, so "No locked Bitcoin found" is the right answer for it
    ok(`wallet with ${n} positions`, n === 243 ? /No locked Bitcoin found/.test(txt) : /holds \d+ locked/.test(txt), `${Date.now() - t} ms :: ${txt}`);
  }
  // nav anchors
  for (const id of ['sell', 'buy', 'mine', 'how']) {
    await p.click(`header a[href="#${id}"]`).catch(() => {}); await p.waitForTimeout(700);
    const top = await p.$eval('#' + id, (e) => Math.round(e.getBoundingClientRect().top));
    const atBottom = await p.evaluate(() => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2);
    ok(`nav link #${id} scrolls there`, Math.abs(top) < 150 || atBottom, 'top=' + top);
  }
  ok('page has an icon and a description', await p.evaluate(() => !!document.querySelector('link[rel=icon]') && !!document.querySelector('meta[name=description]')));
  ok('no console errors', logs.length === 0, logs.slice(0, 4).join(' || '));
  ok('no failed requests', failed.length === 0, failed.slice(0, 4).join(' || '));
  ok('no 4xx/5xx responses', bad.length === 0, [...new Set(bad)].slice(0, 4).join(' || '));
  await ctx.close();

  // query-string handling
  const c2 = await b.newContext(); const q = await c2.newPage(); const qlogs = [];
  q.on('pageerror', (e) => qlogs.push(e.message)); q.on('dialog', (d) => { qlogs.push('DIALOG ' + d.message()); d.dismiss(); });
  await q.goto(URL + '/?wallet=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E', { waitUntil: 'load' }); await q.waitForTimeout(2500);
  ok('bad ?wallet= is ignored safely', qlogs.length === 0 && (await q.$eval('#addr', (e) => e.value)) === '', qlogs.join('|'));
  const r404 = await q.goto(URL + '/nope', { waitUntil: 'load' }).catch(() => null);
  console.log('INFO unknown path status:', r404 && r404.status());
  await c2.close();

  // phone sizes
  for (const [w, h] of [[360, 740], [390, 844], [768, 1024]]) {
    const c3 = await b.newContext({ viewport: { width: w, height: h } }); const m = await c3.newPage();
    await m.goto(URL + '/?wallet=0xc6bd6bad18f7c31fe002c94010d49cd812e93934'); await m.waitForSelector('[data-sell]', { timeout: 30000 }).catch(() => {});
    await m.waitForTimeout(500);
    const over = await m.evaluate(() => { const W = document.documentElement.clientWidth; const out = []; document.querySelectorAll('body *').forEach((e) => { const r = e.getBoundingClientRect(); if (r.width && r.right > W + 1) out.push(e.tagName + '.' + e.className + ' ' + Math.round(r.right)); }); return { scroll: document.documentElement.scrollWidth - W, out: out.slice(0, 4) }; });
    ok(`no sideways scroll at ${w}px`, over.scroll <= 0 && over.out.length === 0, JSON.stringify(over));
    const small = await m.evaluate(() => [...document.querySelectorAll('button, header a, select, input[type=text], #addr')].filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.height < 30; }).map((e) => (e.innerText || e.id || e.tagName).slice(0, 20) + ':' + Math.round(e.getBoundingClientRect().height)));
    console.log(`INFO tap targets under 30px tall at ${w}px:`, JSON.stringify(small.slice(0, 8)));
    await c3.close();
  }

  // RPC down, then back
  const c4 = await b.newContext(); const d = await c4.newPage(); let block = true;
  await d.route('https://rpc.test.mezo.org/**', (r) => (block ? r.abort() : r.continue()));
  await d.goto(URL + '/', { waitUntil: 'load' });
  await d.waitForFunction(() => /Could not reach/.test(document.getElementById('offers').innerText), null, { timeout: 60000 }).catch(() => {});
  const downTxt = await d.$eval('#offers', (e) => e.innerText.slice(0, 160));
  ok('RPC down shows a clear message', /Could not reach the Mezo network/.test(downTxt), downTxt.replace(/\n/g, ' '));
  await c4.close();
  await b.close();
}
(async () => {
  for (const n of (process.env.BROWSERS || 'chromium,firefox,webkit').split(',')) await run(n).catch((e) => console.log('CRASH ' + n + ' ' + e.message.slice(0, 300)));
  const f = res.filter((r) => !r.pass);
  setTimeout(() => process.exit(0), 200);
  console.log(`\nTOTAL ${res.length} checks, ${f.length} failed`);
})();
