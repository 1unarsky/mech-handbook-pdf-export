# run.ps1 — 机械工程师设计手册 PDF 导出 · 阶段驱动脚本
#
# 所有阶段均可中断后原命令重跑(自动续传), 输出在 out/ 与 data/。
#
# 用法:
#   powershell -ExecutionPolicy Bypass -File .\run.ps1 -Stage check
#   powershell -ExecutionPolicy Bypass -File .\run.ps1 -Stage cats
#   powershell -ExecutionPolicy Bypass -File .\run.ps1 -Stage enumerate [-Cat 1]
#   powershell -ExecutionPolicy Bypass -File .\run.ps1 -Stage trees   [-Cat 1]
#   powershell -ExecutionPolicy Bypass -File .\run.ps1 -Stage render  [-Cat 1] [-Workers 6]
#   powershell -ExecutionPolicy Bypass -File .\run.ps1 -Stage merge   [-Cat 1] [-Combined]
#
# 参数:
#   -Stage     check|cats|enumerate|trees|render|merge   (默认 check)
#   -Cat       N>0 表示仅处理第 N 篇(仅作为后续 stages 的限定)
#   -Workers   渲染并发页数, 默认 6
#   -Combined  merge 阶段生成整本单文件
#   -Force     强制重新抓取目录树(默认已存在则跳过)
param(
  [ValidateSet('check','cats','enumerate','trees','render','merge','cover')]
  [string]$Stage = 'check',
  [int]$Cat = 0,
  [int]$Workers = 6,
  [switch]$Combined,
  [switch]$Force
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $here

function Say($m) { Write-Host ("[run] " + $m) }
function NodeOK { try { node --version | Out-Null; return $true } catch { return $false } }
function PyOK   { try { python --version | Out-Null; return $true } catch { return $false } }
function PypdfOK { try { python -c "import pypdf; print('pypdf', pypdf.__version__)" 2>$null; return $true } catch { return $false } }

if (-not (NodeOK)) { Say '未找到 Node.js, 请先安装并加入 PATH。'; exit 1 }
if (-not (PyOK))   { Say '未找到 Python, 请先安装。'; exit 1 }
if (-not (PypdfOK)) { Say '未安装 pypdf, 正在安装 ...'; python -m pip install --quiet pypdf; if (-not (PypdfOK)) { Say 'pypdf 安装失败, 请手动执行: python -m pip install pypdf'; exit 1 } }

function Invoke-Node($args) {
  Say "node tools/mdtool.js $args"
  node tools/mdtool.js $args
  if ($LASTEXITCODE -ne 0) { Say "上一步失败(退出码 $LASTEXITCODE)。可原样重跑续传。"; exit $LASTEXITCODE }
}

switch ($Stage) {
  'check' {
    $cats = Join-Path $here 'data\cats.json'
    $chain = Join-Path $here 'data\chain.json'
    $catN = 0; if (Test-Path $cats) { $catN = (Get-Content $cats -Raw -Encoding UTF8 | ConvertFrom-Json).Count }
    $recN = 0; if (Test-Path $chain) { $recN = (Get-Content $chain -Raw -Encoding UTF8 | ConvertFrom-Json).records.Count }
    $treeN = if (Test-Path (Join-Path $here 'data\trees')) { (Get-ChildItem (Join-Path $here 'data\trees') -Filter '*.json' -ErrorAction SilentlyContinue).Count } else { 0 }
    $pageN = if (Test-Path (Join-Path $here 'data\pages')) { (Get-ChildItem (Join-Path $here 'data\pages') -Filter '*.pdf' -ErrorAction SilentlyContinue).Count } else { 0 }
    Say "环境就绪: Node=OK Python+pypdf=OK"
    Say "已抓篇清单: $catN/24 ; 已遍历正文记录: $recN ; 目录树: $treeN/24 ; 已渲染页: $pageN"
    Say ''
    Say '典型流程(每步可中断重跑):'
    Say '  1) powershell -ExecutionPolicy Bypass -File .\run.ps1 -Stage cats'
    Say '  2) powershell -ExecutionPolicy Bypass -File .\run.ps1 -Stage enumerate   (整本遍历, 最慢, 断点续传)'
    Say '  3) powershell -ExecutionPolicy Bypass -File .\run.ps1 -Stage trees'
    Say '  4) powershell -ExecutionPolicy Bypass -File .\run.ps1 -Stage render'
    Say '  5) powershell -ExecutionPolicy Bypass -File .\run.ps1 -Stage merge           (逐篇输出)'
    Say '     可选整本单文件: ... -Stage merge -Combined'
  }
  'cats'    { Invoke-Node 'cats' }
  'cover'   { Invoke-Node 'cover' }
  'enumerate' {
    if ($Cat -gt 0) { Invoke-Node ("enumerate --cat {0}" -f $Cat) }
    else { Invoke-Node 'enumerate' }
  }
  'trees' {
    if ($Cat -gt 0) {
      $flag = if ($Force) { ' --force' } else { '' }
      Invoke-Node ("tree --cat {0}{1}" -f $Cat, $flag)
    } else {
      for ($i = 1; $i -le 24; $i++) {
        $flag = if ($Force) { ' --force' } else { '' }
        Invoke-Node ("tree --cat {0}{1}" -f $i, $flag)
      }
    }
  }
  'render' {
    if ($Cat -gt 0) { Invoke-Node ("render --cat {0} --workers {1}" -f $Cat, $Workers) }
    else { Invoke-Node ("render --workers {0}" -f $Workers) }
  }
  'merge' {
    if ($Combined) {
      python tools\merge.py --combined
    } elseif ($Cat -gt 0) {
      python tools\merge.py --cat $Cat
    } else {
      python tools\merge.py --all
    }
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
}
Pop-Location
Say "完成: $Stage"
