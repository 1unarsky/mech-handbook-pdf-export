#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
merge.py — 把渲染好的 data/pages/#####.pdf 按各篇目录树合并成带多级书签的 PDF。

用法:
  python tools/merge.py --cat 3           生成第 3 篇  -> out/机械工程师设计手册_第03篇_<篇名>.pdf
  python tools/merge.py --all             生成全部篇(每篇一个文件)
  python tools/merge.py --combined        生成整本单文件 -> out/机械工程师设计手册_全册.pdf

前置: 已依次运行 mdtool cats / enumerate / tree / render。
正文空白页(无文字且无图片)会被剔除, 书签仍指向各节首个有效页。
"""
import os, sys, json, re, argparse
from pypdf import PdfReader, PdfWriter
from pypdf.generic import NameObject

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(BASE, 'data')
PAGES = os.path.join(DATA, 'pages')
TREES = os.path.join(DATA, 'trees')
OUT = os.path.join(BASE, 'out')
BOOK_TITLE = '机械工程师设计手册'

def log(*a):
    print(*a, flush=True)

# ---------------- page helpers ----------------
def page_has_image(page):
    res = page.get('/Resources')
    if res is None:
        return False
    xo = res.get('/XObject')
    if xo is None:
        return False
    try:
        items = xo.get_object()
    except Exception:
        return False
    try:
        for k in items:
            if items[k].get_object().get('/Subtype') == '/Image':
                return True
    except Exception:
        pass
    return False

def page_is_blank(page):
    if (page.extract_text() or '').strip():
        return False
    if page_has_image(page):
        return False
    return True

# ---------------- data ----------------
def load_json(p):
    if not os.path.exists(p):
        raise SystemExit(f'缺少文件 {p}')
    return json.load(open(p, encoding='utf-8'))

def cat_records(records, cat_i):
    return [(gi, rec) for gi, rec in enumerate(records) if rec['catI'] == cat_i]

def load_tree_nodes(cat_i):
    nodes = load_json(os.path.join(TREES, f'tree-{cat_i}.json'))['nodes']
    return nodes

def tree_children(nodes):
    children = {nd['num']: [] for nd in nodes}
    roots = []
    for nd in nodes:
        if nd['depth'] == 0:
            roots.append(nd['num'])
        elif nd['parent'] in children:
            children[nd['parent']].append(nd['num'])
    return roots, children

def compute_anchors(nodes, content_first):
    """每树节点 -> 正文记录全局序号(其内容在正文中最早出现; 缺失则取子树最小)。"""
    _, children = tree_children(nodes)
    by_num = {nd['num']: k for k, nd in enumerate(nodes)}
    anchor = {}
    def calc(num):
        a = content_first.get(nodes[by_num[num]]['content'], -1)
        for cn in children[num]:
            ca = calc(cn)
            if ca >= 0 and (a < 0 or ca < a):
                a = ca
        anchor[num] = a
        return a
    for rn in [x['num'] for x in nodes if x['depth'] == 0]:
        calc(rn)
    return anchor

def append_outline(writer, cat_i, page_of):
    """page_of(gi) -> writer 中 0-based 输出页号。返回 (顶层item, 条目数)。"""
    nodes = load_tree_nodes(cat_i)
    _, children = tree_children(nodes)
    content_first = {}
    # 全局正文字典(content->首个gi)
    for gi, rec in enumerate(RECORDS):
        if rec['catI'] == cat_i and rec['content'] not in content_first:
            content_first[rec['content']] = gi
    anchor = compute_anchors(nodes, content_first)
    by_num = {nd['num']: k for k, nd in enumerate(nodes)}
    root_num = next(nd['num'] for nd in nodes if nd['depth'] == 0)

    counts = {'n': 0}
    def add(num, parent):
        nd = nodes[by_num[num]]
        if nd['depth'] == 0:
            for cn in children[num]:
                add(cn, parent)
            return
        a = anchor[num]
        if a < 0:
            for cn in children[num]:
                add(cn, parent)
            return
        counts['n'] += 1
        it = writer.add_outline_item(nd['text'], page_of(a), parent=parent)
        for cn in children[num]:
            add(cn, it)
    return root_num, counts, add

def sanitize(name):
    return re.sub(r'[\\/:*?"<>|]', '_', name)

_CN = ['零','一','二','三','四','五','六','七','八','九']
def cn_ordinal(n):
    if n < 10:
        return _CN[n]
    if n == 10:
        return '十'
    if n < 20:
        return '十' + _CN[n - 10]
    if n < 100:
        t, o = divmod(n, 10)
        return _CN[t] + '十' + ('' if o == 0 else _CN[o])
    return str(n)

def cat_title(c):
    return f'{BOOK_TITLE} · 第{cn_ordinal(c["i"])}篇 {c["text"]}'

# ---------------- writers ----------------
def add_cover(writer):
    """若存在 data/cover.pdf 则作为封面加入, 返回封面页数。"""
    cov = os.path.join(DATA, 'cover.pdf')
    if not os.path.exists(cov):
        return 0
    n = 0
    for p in PdfReader(cov).pages:
        writer.add_page(p)
        n += 1
    log(f'  封面: {n} 页 ({cov})')
    return n

def new_writer(title):
    w = PdfWriter()
    w.add_metadata({'/Title': title, '/Creator': 'opencode mdtool + pypdf'})
    return w

def add_pages_of_cat(writer, cat_i):
    """向 writer 追加该篇全部页, 返回 {gi: 本篇内0-based起始页} 及统计。"""
    kept_local = {}
    dropped = 0
    kept = 0
    for gi, rec in cat_records(RECORDS, cat_i):
        f = os.path.join(PAGES, f'{gi:05d}.pdf')
        if not os.path.exists(f):
            raise SystemExit(f'缺少正文页 {f}, 请先运行: node tools/mdtool.js render --cat {cat_i}')
        for page in PdfReader(f).pages:
            if page_is_blank(page):
                dropped += 1
                continue
            if gi not in kept_local:
                kept_local[gi] = kept
            writer.add_page(page)
            kept += 1
        if gi not in kept_local:
            kept_local[gi] = kept
    return kept_local, kept, dropped

def finalize(writer, out):
    writer._root_object[NameObject('/PageMode')] = NameObject('/UseOutlines')
    with open(out, 'wb') as fh:
        writer.write(fh)
    log('  页数:', len(writer.pages))
    log('  已保存:', out)

# ---------------- commands ----------------
def merge_single(cat_i, cover=False):
    cat = CATS[cat_i - 1]
    recs = cat_records(RECORDS, cat_i)
    if not recs:
        log(f'[篇{cat_i} {cat["text"]}] 尚未遍历到正文记录, 跳过(请先 enumerate)')
        return
    log(f'[篇{cat_i} {cat["text"]}] 正文记录 {len(recs)} 条')
    writer = new_writer(cat_title(cat))
    cover_n = add_cover(writer) if cover else 0
    kept_local, kept, dropped = add_pages_of_cat(writer, cat_i)
    log(f'  输出 {kept} 页, 剔除空白 {dropped}')
    first_gi = recs[0][0]
    root_item = writer.add_outline_item(cat_title(cat), cover_n + kept_local[first_gi])
    root_num, counts, add = append_outline(writer, cat_i, lambda gi: cover_n + kept_local[gi])
    add(root_num, root_item)
    log(f'  大纲条目 {counts["n"]}')
    finalize(writer, os.path.join(OUT, f'{BOOK_TITLE}_第{cat_i:02d}篇_{sanitize(cat["text"])}.pdf'))

def merge_all(cover=False):
    for c in CATS:
        try:
            merge_single(c['i'], cover=cover)
        except SystemExit as e:
            log('  [跳过]', e)

def merge_combined():
    log('生成整本单文件 ...')
    writer = new_writer(f'{BOOK_TITLE} 全册')
    add_cover(writer)
    cat_start = {}
    kept_of = {}
    present = []
    for c in CATS:
        ci = c['i']
        recs = cat_records(RECORDS, ci)
        if not recs:
            log(f'  [篇{ci}] 未遍历到正文记录, 跳过(请先 enumerate)')
            continue
        try:
            start = len(writer.pages)
            kept_local, kept, dropped = add_pages_of_cat(writer, ci)
        except SystemExit as e:
            log('  [跳过]', e)
            continue
        cat_start[ci] = start
        kept_of[ci] = kept_local
        present.append(ci)
        log(f'  [篇{ci}] 起点页 {start}, 新增 {kept}, 剔除空白 {dropped}')
    root_all = writer.add_outline_item(f'{BOOK_TITLE} · 全册', 0)
    total_items = 0
    for c in CATS:
        ci = c['i']
        if ci not in present:
            continue
        recs = cat_records(RECORDS, ci)
        start = cat_start[ci]
        kl = kept_of[ci]
        def page_of(gi):
            return start + kl[gi]
        ci_item = writer.add_outline_item(cat_title(c), page_of(recs[0][0]), parent=root_all)
        root_num, counts, add = append_outline(writer, ci, page_of)
        add(root_num, ci_item)
        total_items += counts['n']
        log(f'  [篇{ci}] 大纲条目 {counts["n"]}')
    log('整本大纲条目合计:', total_items)
    if len(writer.pages) == 0:
        raise SystemExit('整本无可输出页, 请先完成 render。')
    finalize(writer, os.path.join(OUT, f'{BOOK_TITLE}_全册.pdf'))

# ---------------- main ----------------
ap = argparse.ArgumentParser()
ap.add_argument('--cat', type=int, help='第几篇')
ap.add_argument('--all', action='store_true', help='全部篇各自成文件')
ap.add_argument('--combined', action='store_true', help='整本合成一个文件')
ap.add_argument('--cover', action='store_true', help='单篇/全部篇时也加封面(整本默认自动加)')
a = ap.parse_args()

data = load_json(os.path.join(DATA, 'chain.json'))
CATS = data['cats']
RECORDS = data['records']

if a.combined:
    merge_combined()
elif a.all:
    merge_all(cover=a.cover)
elif a.cat:
    merge_single(a.cat, cover=a.cover)
else:
    ap.print_help()
