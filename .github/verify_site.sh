#!/usr/bin/env bash
# 端到端静态校验：用法 verify_site.sh <站点根URL>
# 退出码 0 = 全部通过；非 0 = 有硬失败
#
# 校验内容：
#   1) 首页 200 且是 HTML
#   2) 从 index.html 解析出 js / wasm 真实路径
#   3) wasm 响应头（Content-Type 必须是 application/wasm，否则 instantiateStreaming 会失败）
#   4) 实际下载 + 解压，检查前 4 字节是否 \0asm（0x0061736d）
#   5) 应用主 wasm 与 worker wasm 都要通过
#   6) 静态资源抽查
set -eo pipefail

BASE="${1%/}"
if [ -z "$BASE" ]; then
  echo "::error::verify_site.sh 需要一个站点 URL 参数"
  exit 1
fi
echo "===== 校验目标: $BASE ====="

UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
FAIL=0

echo "----- 1) 首页 -----"
code=$(curl -s -o /tmp/idx.html -w '%{http_code}' -A "$UA" "$BASE/")
echo "HTTP $code"
if [ "$code" != "200" ]; then
  echo "::error::$BASE 首页返回 $code，期望 200"
  head -c 400 /tmp/idx.html || true; echo
  exit 1
fi
if ! grep -qi '<html' /tmp/idx.html; then
  echo "::error::$BASE 首页不是 HTML"
  head -c 400 /tmp/idx.html || true; echo
  exit 1
fi
echo "OK 首页 200 且为 HTML"

echo "----- 2) 解析 js / wasm 路径 -----"
# 首页里可能有多个 .js 引用（例如我们注入的 GLSL 兼容补丁里带的说明文字），
# 直接取第一个会挑错 —— 必须挑出「应用入口」：判据是同一页面里存在与之配对的 <name>_bg.wasm。
CANDIDATES=$(grep -aoE '/[A-Za-z0-9._-]+\.js' /tmp/idx.html | sort -u || true)
echo "  页面中全部 .js 引用: $(echo "$CANDIDATES" | tr '\n' ' ')"
JS=""
while IFS= read -r cand; do
  [ -n "$cand" ] || continue
  if grep -qF "${cand%.js}_bg.wasm" /tmp/idx.html; then JS="$cand"; break; fi
done <<< "$CANDIDATES"
if [ -z "$JS" ]; then
  echo "::error::index.html 里找不到与 *_bg.wasm 配对的 js 引用（候选: $(echo "$CANDIDATES" | tr '\n' ' ')）"
  exit 1
fi
WASM="${JS%.js}_bg.wasm"
echo "js   = $JS"
echo "wasm = $WASM"

echo "----- 3) 主 wasm -----"
curl -sI -A "$UA" "$BASE$WASM" | tr -d '\r' | sed -n '1,20p'
ct=$(curl -sI -A "$UA" "$BASE$WASM" | tr -d '\r' | grep -i '^content-type:' | head -1 | cut -d: -f2- | xargs || true)
echo "Content-Type = [$ct]"
case "$ct" in
  application/wasm*) echo "OK Content-Type 正确" ;;
  *) echo "::warning::Content-Type 是 [$ct]，浏览器可能拒绝 WebAssembly.instantiateStreaming" ;;
esac
code=$(curl -s --compressed -A "$UA" "$BASE$WASM" -o /tmp/app.wasm -w '%{http_code}' || true)
sz=$(stat -c%s /tmp/app.wasm 2>/dev/null || echo 0)
magic=$(od -An -t x1 -N4 /tmp/app.wasm 2>/dev/null | tr -d ' \n' || true)
echo "http=$code  解压后大小=$sz bytes  前4字节=$magic"
if [ "$magic" != "0061736d" ]; then
  echo "::error::主 wasm 解压后不是合法 WebAssembly（前 4 字节 $magic）→ Content-Encoding 链路有问题"
  FAIL=1
else
  echo "OK 主 wasm 解压后是合法 WebAssembly"
fi

echo "----- 4) worker wasm -----"
WJS_PATH=$(grep -aoE '/worker_pkg/[A-Za-z0-9._-]+\.js' /tmp/idx.html | head -1 || true)
WWASM="/worker_pkg/ocs_web_worker_bg.wasm"
echo "worker wasm = $WWASM"
wcode=$(curl -s --compressed -A "$UA" "$BASE$WWASM" -o /tmp/worker.wasm -w '%{http_code}' || true)
wsz=$(stat -c%s /tmp/worker.wasm 2>/dev/null || echo 0)
wmagic=$(od -An -t x1 -N4 /tmp/worker.wasm 2>/dev/null | tr -d ' \n' || true)
echo "http=$wcode  解压后大小=$wsz bytes  前4字节=$wmagic"
if [ "$wmagic" != "0061736d" ]; then
  echo "::error::worker wasm 解压后不是合法 WebAssembly（前 4 字节 $wmagic）"
  FAIL=1
else
  echo "OK worker wasm 合法"
fi

echo "----- 5) 静态资源抽查 -----"
for p in "/${JS#/}" "/index.html" "/worker_pkg/ocs_web_worker.js"; do
  c=$(curl -s -o /dev/null -w '%{http_code}' -A "$UA" "$BASE$p" || true)
  echo "  $p -> $c"
done

echo "============================================"
if [ "$FAIL" -ne 0 ]; then
  echo "::error::$BASE 校验失败"
  exit 1
fi
echo "  校验通过: $BASE"
echo "============================================"
