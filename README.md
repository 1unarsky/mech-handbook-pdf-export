# 机械工程师设计手册（在线版）整本 PDF 导出工具

把 `http://dev.inkcad.com` 上的《机械工程师设计手册》各篇正文 + 多级书签导出为 PDF。
各篇请按下列步骤生成。

---

## 1. 环境要求（一次性准备）

| 依赖 | 用途 | 检查命令 |
|---|---|---|
| Node.js ≥ 18 | 驱动 Edge 无头抓取/渲染 | `node -v` |
| 微软 Edge 浏览器 | 渲染引擎（脚本自动使用本机 Edge） | 安装即有 |
| Python 3 | PDF 合并/书签 | `python --version` |
| pypdf | Python 库，脚本会自动安装 | `python -c "import pypdf"` |

首次运行会自动联网访问 `dev.inkcad.com`；需要**稳定联网**（抓取最怕断网，脚本已做续传，断网后原命令重跑即可）。

> 说明：脚本里 Playwright 路径写死为全局 `@playwright/mcp` 内置的 playwright。
> 若你在别的机器用，请执行 `npm i -g @playwright/mcp`（或 `npm i playwright` 后在 `tools/mdtool.js` 顶部改一行 `PW` 路径），Edge 无需额外下载。

---

## 2. 目录结构

```
book_export/
├─ run.ps1                阶段驱动脚本(推荐入口, 自动检查依赖)
├─ tools/
│  ├─ mdtool.js           Node 工具: cats / enumerate / tree / render
│  └─ merge.py            Python 工具: 合并成 PDF(带目录书签)
├─ data/                  (运行产物/缓存)
│  ├─ cats.json           24 篇清单(含每篇 path)
│  ├─ cat-<i>.json        第 i 篇正文记录链(断点续传)
│  ├─ chain.json          汇总后的全册正文顺序
│  ├─ trees/tree-<i>.json 第 i 篇完整目录树(书签来源)
│  ├─ pages/#####.pdf     每条正文渲染出的 PDF(可单独查看)
│  └─ render-failed.json  上次渲染失败的记录(自动续试)
├─ out/                   ★ 最终 PDF 输出目录
└─ README.md
```

---

## 3. 使用步骤

在 `book_export` 目录打开 **PowerShell**，按顺序执行（每步可中断，重跑同一命令即续传）：

### 0) 环境自检
```powershell
powershell -ExecutionPolicy Bypass -File .\run.ps1 -Stage check
```

### 1) 抓取篇清单（只跑一次）
```powershell
powershell -ExecutionPolicy Bypass -File .\run.ps1 -Stage cats
```

### 2) 遍历正文记录（最耗时，务必留足时间；断点续传）
```powershell
powershell -ExecutionPolicy Bypass -File .\run.ps1 -Stage enumerate
```
逐条抓取全部正文记录（约数千～上万条），每页约 0.2 秒，**整本一次大约 30～60 分钟**。
网络中断时脚本会自动重试；若中途被关闭，**重新执行同一条命令**即可从上次位置继续。

### 3) 抓取各篇目录树（书签层级来源）
```powershell
powershell -ExecutionPolicy Bypass -File .\run.ps1 -Stage trees
```
24 篇顺序抓取，通常数分钟内完成；已有缓存会自动跳过（加 `-Force` 可重抓）。

### 4) 渲染正文页为 PDF
```powershell
powershell -ExecutionPolicy Bypass -File .\run.ps1 -Stage render
```
并发 6 页渲染（可 `-Workers 8`）。按记录跳过已完成文件，可随时中断续跑。
失败记录会写 `data/render-failed.json`，重跑本步骤会自动补渲（每页最多自动重试 4 次）。

### 5) 生成封面（可选，仅一次）
```powershell
powershell -ExecutionPolicy Bypass -File .\run.ps1 -Stage cover
```
把网站首页「北京英科宇科技开发中心」那页渲染为 `data/cover.pdf`。
整本合并(`-Combined`)会**自动**把它作为封面置顶；单篇合并如需封面加 `-Cover`（python 层参数 `--cover`）。

### 6) 合并输出 PDF（带多级书签）
```powershell
# 只出单篇:
powershell -ExecutionPolicy Bypass -File .\run.ps1 -Stage merge -Cat 1

# 逐篇全部输出(每篇一个文件, 推荐):
powershell -ExecutionPolicy Bypass -File .\run.ps1 -Stage merge

# 或整本合成一个文件(自动加封面; 文件很大, 可能 0.5~1GB+, 请确保磁盘空间):
powershell -ExecutionPolicy Bypass -File .\run.ps1 -Stage merge -Combined
```

输出在 `out/`：
- `机械工程师设计手册_第NN篇_<篇名>.pdf`（每篇一个，正文页 + 章/节/子节多级书签）
- `机械工程师设计手册_全册.pdf`（仅 `-Combined` 时生成，首頁为公司封面）

---

## 4. 只想先导出一篇试试

第一篇已全部缓存，直接验证合并即可（几秒）：
```powershell
powershell -ExecutionPolicy Bypass -File .\run.ps1 -Stage check
powershell -ExecutionPolicy Bypass -File .\run.ps1 -Stage merge -Cat 1
```
打开 `out/机械工程师设计手册_第01篇_一般设计资料.pdf` 看效果。

也可以只处理某一篇来试新流程：
```powershell
powershell -ExecutionPolicy Bypass -File .\run.ps1 -Stage enumerate -Cat 2
powershell -ExecutionPolicy Bypass -File .\run.ps1 -Stage trees    -Cat 2
powershell -ExecutionPolicy Bypass -File .\run.ps1 -Stage render   -Cat 2 -Workers 6
powershell -ExecutionPolicy Bypass -File .\run.ps1 -Stage merge    -Cat 2
```

---

## 5. 常见问题

- **抓取极慢 / 频繁断网**：正文记录是一条条顺序请求的（网站无批量接口），慢是正常的。
  减少波动可 `-Workers` 只对渲染生效；抓取阶段请保持网络稳定，断网后重跑续传即可。
- **某篇渲染失败多**：多半是临时网络问题。重跑 `-Stage render -Cat N` 会自动只补缺失页。
- **页码/书签不跳转**：用支持大纲的阅读器（Edge / Adobe / SumatraPDF / 福昕）打开。
- **占空间**：`data/pages`（每篇几百个 0.1~2MB 小 PDF）占大头，产出最终 PDF 后可删除 `data/pages` 与 `data/cat-*.json`、`data/chain.json` 中的非必要缓存（保留 `trees` 便于重合并）。
