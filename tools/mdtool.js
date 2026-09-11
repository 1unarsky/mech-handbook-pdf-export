#!/usr/bin/env node
/*
 * mdtool.js — 机械工程师设计手册(在线版) 导出工具
 *
 * 职责(每个命令都可在中断后安全重跑, 带断点续传):
 *   cats            抓取全部"篇"清单 -> data/cats.json
 *   probe  --cat N  探测第 N 篇的首条正文链记录 id (验证用, 2 次请求)
 *   enumerate [--cat N]  遍历正文记录链(整本或单篇) -> data/cat-<i>.json -> data/chain.json
 *   tree    --cat N      抓取该篇完整目录树 -> data/trees/tree-<i>.json
 *   render  [--cat N]    渲染缺少的正文页 -> data/pages/#####.pdf (跳过已存在)
 *
 * 用法示例:
 *   node tools/mdtool.js cats
 *   node tools/mdtool.js enumerate                 # 整本(先执行 cats)
 *   node tools/mdtool.js enumerate --cat 3
 *   node tools/mdtool.js tree --cat 3
 *   node tools/mdtool.js render --cat 3 --workers 6
 *
 * 依赖: 本机安装 Node.js 与微软 Edge; python+pypdf 仅用于 merge.py。
 */
const fs = require('fs');
const path = require('path');

// 解析 playwright: 依次尝试 本地安装 -> 全局 @playwright/mcp 内置
const PW_CANDIDATES = [
  'playwright',
  'C:/Users/Admin/scoop/persist/nodejs/bin/node_modules/@playwright/mcp/node_modules/playwright',
];
let PW = null;
for (const c of PW_CANDIDATES) {
  try { require.resolve(c); PW = c; break; } catch (e) { /* next */ }
}
if (!PW) {
  console.error('未找到 playwright。请在本机执行: npm i -g @playwright/mcp (或 npm i playwright 后把本文件顶部 PW_CANDIDATES 指向其安装路径)。');
  process.exit(1);
}
const { chromium } = require(PW);

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const PAGES = path.join(DATA, 'pages');
const TREES = path.join(DATA, 'trees');
const CATS_FILE = path.join(DATA, 'cats.json');
const CHAIN_FILE = path.join(DATA, 'chain.json');
const GAL_NAME = '机械工程师设计手册';
const URL = `http://dev.inkcad.com/ykyApp/App/WebBookIndex.aspx?gal=${encodeURIComponent(GAL_NAME)}`;
const numOf = id => (id || '').replace(/^\D+/, '');

const argVal = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt;
};
const hasArg = name => process.argv.includes(name);
const wait = ms => new Promise(r => setTimeout(r, ms));

// ---------------- browser helpers ----------------
let _browser;
let _ctx;
async function getPage() {
  if (!_browser) {
    _browser = await chromium.launch({ channel: 'msedge', headless: true });
    _ctx = await _browser.newContext();
  }
  return _ctx.newPage();
}
async function closeBrowser() { if (_browser) { await _browser.close().catch(() => {}); _browser = null; _ctx = null; } }

async function withPage(fn) {
  const page = await getPage();
  try { return await fn(page); } finally { await page.close().catch(() => {}); }
}

/** 在页面内调用 ykyApp.ashx; 完全复刻网站前端逻辑。返回 data 数组或抛错。 */
async function api(page, callType, callParas, attempts = 5) {
  let lastErr;
  for (let a = 0; a < attempts; a++) {
    try {
      const out = await page.evaluate(async ({ ct, cp }) => {
        const res = await fetch('/ykyApp/App/ykyApp.ashx', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'callType=' + encodeURIComponent(ct) + '&callParas=' + encodeURIComponent(JSON.stringify(cp)),
        });
        const text = await res.text();
        if (!text) throw new Error('empty response');
        eval(text);
        if (typeof retJson === 'undefined') throw new Error('no retJson');
        if (retJson.result !== '0') throw new Error(retJson.err || ('result=' + retJson.result));
        let data = [];
        try { eval(retJson.scriptCode); data = (typeof _templetData !== 'undefined') ? _templetData : []; }
        catch (e) { throw new Error('scriptCode: ' + e.message); }
        return data;
      }, { ct: callType, cp: callParas });
      return out;
    } catch (e) {
      lastErr = e;
      await wait(800 * (a + 1));
    }
  }
  throw new Error(`api ${callType} failed: ${lastErr && lastErr.message}`);
}

async function openIndex(page) {
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 90000 });
  const hid = await page.evaluate(() => ({
    galPath: document.querySelector('#hidActiveGalPath')?.value,
    userId: document.querySelector('#hidActiveUserId')?.value,
  }));
  if (!hid.galPath) throw new Error('无法取得 galPath(会话未就绪)');
  return hid;
}

const nxt = (page, hid, idNum, dir) => api(page, 'GetNextContent', {
  galPath: hid.galPath, subPath: 'Book', varData: '_templetData',
  id: idNum, next: String(dir), userId: hid.userId,
});
const childDir = (page, hid, parentNum) => api(page, 'GetChildDrawingDir', {
  galPath: hid.galPath, subPath: 'Book', varData: '_templetData',
  parentId: parseInt(parentNum, 10), userId: hid.userId,
});

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }
function readJSON(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }
function writeJSON(f, obj) { fs.writeFileSync(f, JSON.stringify(obj, null, 0), 'utf8'); }

// ---------------- commands ----------------
async function cmdCats() {
  await withPage(async page => {
    const hid = await openIndex(page);
    const top = await api(page, 'GetDrawingDir', {
      galPath: hid.galPath, subPath: 'Book', varData: '_templetData',
      showClass: '1', userId: hid.userId,
    });
    const cats = top.map((n, i) => ({
      i: i + 1, num: numOf(n.id), text: n.text, part: n.itempath, content: n.itemcontent,
    }));
    ensureDir(DATA);
    writeJSON(CATS_FILE, cats);
    console.log(`共 ${cats.length} 篇, 已写入 ${CATS_FILE}`);
    for (const c of cats) console.log(`  ${c.i}. ${c.text}  (${c.part})`);
  });
}

async function catFile(i) { return path.join(DATA, `cat-${i}.json`); }

async function cmdProbe() {
  const i = parseInt(argVal('--cat', '1'), 10);
  await withPage(async page => {
    const cats = readJSON(CATS_FILE);
    const hid = await openIndex(page);
    const c = cats.find(x => x.i === i) || cats[i - 1];
    const head = await nxt(page, hid, parseInt(c.num, 10), '1');
    let start;
    if (head.length === 0) { console.log(`篇${i} 无正文记录`); return; }
    const prev = await nxt(page, hid, parseInt(numOf(head[0].id), 10), '-1');
    start = prev.length ? prev[0] : head[0];
    console.log(`篇${i} 「${c.text}」 ${c.part}`);
    console.log('  next(catRoot):', JSON.stringify(head[0] && { id: head[0].id, text: head[0].text, content: head[0].itemcontent, path: head[0].itempath }));
    console.log('  首条正文记录:', JSON.stringify({ id: start.id, text: start.text, content: start.itemcontent, path: start.itempath }));
  });
}

async function cmdEnumerate() {
  const cats = readJSON(CATS_FILE);
  if (!cats) throw new Error('请先运行: node tools/mdtool.js cats');
  const only = hasArg('--cat') ? [parseInt(argVal('--cat'), 10)] : null;
  for (const c of cats) {
    if (only && !only.includes(c.i)) continue; // 未指定的篇保持其已有缓存不动
    await enumerateOneCat(c);
  }
  // 汇总 chain.json: 收录所有"已完成"的篇(全局顺序, 可跨多次运行累积)
  const chainRecs = [];
  let okCats = 0;
  const pending = [];
  for (const c of cats) {
    const st = readJSON(await catFile(c.i));
    if (!st || !st.done) { pending.push(c.i); continue; }
    for (const r of st.records) chainRecs.push({ catI: c.i, id: r.id, text: r.text, path: r.path, content: r.content });
    okCats++;
  }
  ensureDir(DATA);
  writeJSON(CHAIN_FILE, { cats, records: chainRecs });
  console.log(`chain.json: ${okCats}/${cats.length} 篇 / ${chainRecs.length} 条记录(全局顺序)`);
  if (pending.length) console.log(`  尚未遍历的篇: ${pending.join(', ')}`);
}

async function enumerateOneCat(c) {
  const f = await catFile(c.i);
  const existed = readJSON(f);
  if (existed && existed.done) return existed;
  const recs = (existed && existed.records) ? existed.records.slice() : [];
  console.log(`[篇${c.i} ${c.text}] 开始遍历 ${c.part} ...`);

  const out = { i: c.i, part: c.part, done: false, records: recs };
  await withPage(async page => {
    const hid = await openIndex(page);
    let cur;
    if (recs.length > 0) {
      cur = parseInt(recs[recs.length - 1].id, 10);
    } else {
      const head = await nxt(page, hid, parseInt(c.num, 10), '1');
      if (head.length === 0) { out.done = true; writeJSON(f, out); return; }
      const prev = await nxt(page, hid, parseInt(numOf(head[0].id), 10), '-1');
      const startRec = prev.length ? prev[0] : head[0];
      // 首条正文记录本身也要收录(不能只从它的下一条开始)
      out.records.push({ id: (startRec.id || '').replace(/^\D+/, ''), text: startRec.text || '', path: startRec.itempath || '', content: startRec.itemcontent || '' });
      cur = parseInt(out.records[out.records.length - 1].id, 10);
    }
    const CHUNK = 100;
    let errStreak = 0;
    for (;;) {
      let lastCur = cur;
      let stop = false;
      let chunkErr = false;
      const chunk = await page.evaluate(async ({ galPath, userId, curId, n, part }) => {
        const outRows = [];
        let id = curId;
        for (let i = 0; i < n; i++) {
          try {
            const res = await fetch('/ykyApp/App/ykyApp.ashx', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: 'callType=GetNextContent&callParas=' + encodeURIComponent(JSON.stringify({
                galPath, subPath: 'Book', varData: '_templetData', id, next: '1', userId,
              })),
            });
            const text = await res.text();
            if (!text) { outRows.push({ end: 'empty' }); break; }
            eval(text);
            if (typeof retJson === 'undefined' || retJson.result !== '0') { outRows.push({ end: 'bad' }); break; }
            let data = [];
            try { eval(retJson.scriptCode); data = (typeof _templetData !== 'undefined') ? _templetData : []; }
            catch (e) { outRows.push({ end: 'seval' }); break; }
            const o = data[0];
            if (!o) { outRows.push({ end: 'nodata' }); break; }
            // 离开本 path 前缀 => 属于下一篇, 仅作边界标记, 不入本链
            if (o.itempath && !String(o.itempath).startsWith(part)) {
              outRows.push({ boundary: true, lastId: id });
              break;
            }
            outRows.push({ id: o.id, text: o.text, path: o.itempath, content: o.itemcontent });
            id = parseInt(String(o.id || '').replace(/^\D+/, ''), 10);
          } catch (e) {
            outRows.push({ netErr: true, lastId: id });
            break;
          }
        }
        return outRows;
      }, { galPath: hid.galPath, userId: hid.userId, curId: cur, n: CHUNK, part: c.part });

      for (const r of chunk) {
        if (r.netErr) { chunkErr = true; break; }
        if (r.end) { stop = true; break; }
        if (r.boundary) { stop = true; break; }
        out.records.push({ id: (r.id || '').replace(/^\D+/, ''), text: r.text || '', path: r.path || '', content: r.content || '' });
        lastCur = parseInt((r.id || '').replace(/^\D+/, ''), 10);
      }
      // 保存进度
      writeJSON(f, out);
      cur = lastCur;
      const boundary = chunk.some(r => r.boundary);
      console.log(`  [篇${c.i}] 已抓 ${out.records.length} 条 last=${(out.records[out.records.length - 1] || {}).text || ''} ${boundary ? '[到下一篇边界]' : chunkErr ? '[网络错误, 续传中]' : ''}`);
      if (chunkErr) { errStreak++; if (errStreak >= 6) { console.log(`  篇${c.i} 连续错误过多, 中止(可重跑续传)`); return; } continue; }
      errStreak = 0;
      if (stop || boundary) { out.done = true; writeJSON(f, out); break; }
    }
  });
  return out;
}

async function cmdTree() {
  const cats = readJSON(CATS_FILE);
  if (!cats) throw new Error('请先运行 cats');
  const i = parseInt(argVal('--cat', '1'), 10);
  const c = cats.find(x => x.i === i);
  ensureDir(TREES);
  const tf = path.join(TREES, `tree-${c.i}.json`);
  if (!hasArg('--force')) {
    const ex = readJSON(tf);
    if (ex && ex.nodes && ex.nodes.length > 0) {
      console.log(`篇${i} 「${c.text}」目录树已存在(${ex.nodes.length} 节点), 跳过(加 --force 重新抓取)`);
      return;
    }
  }
  const nodes = [];
  const failures = [];
  let calls = 0;
  await withPage(async page => {
    const hid = await openIndex(page);
    async function getChildren(node) {
      if (Array.isArray(node.children) && node.children.length > 0) return node.children;
      calls++;
      const num = numOf(node.id);
      if (!num) return [];
      try {
        return await childDir(page, hid, num);
      } catch (e) {
        // 个别节点标题含特殊字符会导致服务端返回的脚本片段无法解析; 跳过该子树, 不中断整棵树
        failures.push({ num, text: node.text, error: String(e.message).slice(0, 120) });
        return [];
      }
    }
    async function walk(node, depth, parent) {
      nodes.push({ num: numOf(node.id), text: node.text, content: node.itemcontent, depth, parent });
      if (depth >= 12) return;
      const ch = await getChildren(node);
      for (const x of ch) await walk(x, depth + 1, numOf(node.id));
    }
    // 需要整棵子树根节点: 用 GetDrawingDir 定位第 i 篇节点
    const top = await api(page, 'GetDrawingDir', {
      galPath: hid.galPath, subPath: 'Book', varData: '_templetData',
      showClass: '1', userId: hid.userId,
    });
    const root = top.find(x => x.text === c.text);
    if (!root) throw new Error('篇节点未找到');
    await walk(root, 0, null);
  });
  writeJSON(tf, { nodes, catI: i, catText: c.text, failures });
  console.log(`篇${i} 「${c.text}」目录树节点: ${nodes.length} (API展开调用 ${calls}, 跳过 ${failures.length} 个无法解析的子树)`);
  for (const f of failures.slice(0, 8)) console.log(`   - 跳过: ${f.text} (id=${f.num}) ${f.error}`);
}

async function cmdRender() {
  const cats = readJSON(CATS_FILE);
  const chain = readJSON(CHAIN_FILE);
  if (!cats || !chain) throw new Error('请先运行 cats 与 enumerate');
  const only = hasArg('--cat') ? [parseInt(argVal('--cat'), 10)] : null;
  const workers = parseInt(argVal('--workers', '6'), 10);
  const force = hasArg('--force');
  const rangeArg = argVal('--range', null); // 形如 499-598 (按全局 gi)
  let range = null;
  if (rangeArg) { const [a, b] = rangeArg.split('-').map(Number); range = [a, b === undefined ? a : b]; }
  ensureDir(PAGES);
  const records = chain.records.filter(r => !only || only.includes(r.catI));
  if (only) console.log(`渲染范围: ${records.length} 条 (仅这些篇)`);
  else console.log(`渲染整本: ${records.length} 条`);

  const pad = n => String(n).padStart(5, '0');
  const need = [];
  records.forEach(r => {
    const gi = chain.records.indexOf(r);
    if (range && (gi < range[0] || gi > range[1])) return;
    const fp = path.join(PAGES, pad(gi) + '.pdf');
    const st = fs.existsSync(fp) ? fs.statSync(fp).size : 0;
    if (force || !st) need.push({ gi, rec: r });
  });
  console.log(`待渲染 ${need.length}${force ? ' (--force 全部重渲)' : ''}`);
  if (need.length === 0) { console.log('无需渲染。'); return; }

  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 850, height: 1100 } });
  const FIX_CSS = 'form>div:not(#HtmContent){display:none!important} html,body,form{margin:0!important;padding:0!important}';

  async function renderOne({ gi, rec }) {
    const url = `http://dev.inkcad.com/ykyApp/App/ManualContentPage.aspx?gal=${encodeURIComponent(GAL_NAME)}&path=${encodeURIComponent(rec.path)}&content=${encodeURIComponent(rec.content)}`;
    let lastErr;
    for (let attempt = 1; attempt <= 4; attempt++) {
      const page = await ctx.newPage();
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(400);
        await page.addStyleTag({ content: FIX_CSS });
        // 1) 强制所有图片立即加载(含懒加载), 2) 逐步滚动触发, 3) 等待真正解码完成
        await page.evaluate(() => {
          const el = document.getElementById('HtmContent');
          if (!el) return;
          el.querySelectorAll('img').forEach(im => {
            try {
              im.loading = 'eager';
              if (!im.getAttribute('src') && im.dataset && im.dataset.src) im.src = im.dataset.src;
              if (im.dataset && im.dataset.original) im.src = im.dataset.original;
            } catch (e) {}
          });
        });
        await page.evaluate(async () => {
          const h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
          for (let y = 0; y < h; y += 700) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 100)); }
          window.scrollTo(0, 0);
        });
        let settled = false, broken = 0, total = 0;
        for (let k = 0; k < 60; k++) {
          const meta = await page.evaluate(() => {
            const el = document.getElementById('HtmContent');
            const imgs = el ? [...el.getElementsByTagName('img')] : [];
            return {
              textLen: el ? (el.innerText || '').replace(/\s/g, '').length : 0,
              total: imgs.length,
              loading: imgs.filter(im => !im.complete).length,
              broken: imgs.filter(im => im.complete && im.naturalWidth === 0).length,
            };
          }).catch(() => null);
          if (meta && meta.textLen > 0 && meta.loading === 0) { settled = true; broken = meta.broken; total = meta.total; break; }
          await page.waitForTimeout(250);
        }
        // 若有图片损坏/未取到, 重试一次该页(最多到第3次尝试)
        if (settled && broken > 0 && attempt < 3) {
          await page.close().catch(() => {});
          lastErr = new Error(`图片未就绪 ${broken}/${total}`);
          await wait(1200 * attempt);
          continue;
        }
        const fp = path.join(PAGES, pad(gi) + '.pdf');
        await page.pdf({ path: fp, format: 'A4', printBackground: true, margin: { top: '6mm', bottom: '6mm', left: '4mm', right: '4mm' } });
        await page.close().catch(() => {});
        return { gi, ok: true, imgs: total, broken };
      } catch (e) {
        await page.close().catch(() => {});
        lastErr = e;
        await wait(900 * attempt);
      }
    }
    return { gi, ok: false, err: String(lastErr && lastErr.message).slice(0, 140) };
  }

  let idx = 0;
  const failed = [];
  const withBroken = [];
  async function worker() {
    for (;;) {
      const job = need[idx++];
      if (!job) break;
      const r = await renderOne(job);
      if (!r.ok) failed.push(r);
      else if (r.broken > 0) withBroken.push(r);
      const done = Math.min(idx, need.length);
      if (done % 20 === 0 || done === need.length) {
        console.log(`  render ${done}/${need.length} fail=${failed.length} brokenPages=${withBroken.length} gi=${r.gi}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(workers, need.length) }, worker));
  await browser.close().catch(() => {});
  console.log('渲染结束: 成功', need.length - failed.length, '失败', failed.length, '含损坏图片页', withBroken.length);
  if (withBroken.length) console.log('  含损坏图片的页:', JSON.stringify(withBroken.map(x => ({ gi: x.gi, broken: x.broken, imgs: x.imgs }))));
  if (failed.length) {
    fs.writeFileSync(path.join(DATA, 'render-failed.json'), JSON.stringify(failed, null, 0), 'utf8');
    console.log('失败列表 -> data/render-failed.json (重跑 render 会自动续试)');
    process.exitCode = 2;
  }
}

// ---------------- dispatch ----------------
(async () => {
  const cmd = process.argv[2];
  const fns = { cats: cmdCats, enumerate: cmdEnumerate, tree: cmdTree, render: cmdRender, probe: cmdProbe };
  if (!fns[cmd]) {
    console.log('用法: node tools/mdtool.js <cats|probe|enumerate|tree|render> [--cat N] [--workers N]');
    process.exit(1);
  }
  try {
    await fns[cmd]();
  } catch (e) {
    console.error('错误:', e && e.message);
    process.exitCode = 1;
  } finally {
    await closeBrowser();
  }
})();
