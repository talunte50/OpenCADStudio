#!/usr/bin/env python3
"""把 .github/glsl-webgl-shim.js 内联注入 dist/index.html（构建后处理）。

为什么在这里做而不是改源码：
    修复内容是「给 GLSL ES 的数组类型补精度限定符」，纯前端运行期行为。
    web-app.html 属于上游仓库文件，改它会在同步上游时引入冲突面；
    dist/index.html 是 trunk 的构建产物，注入放在 CI 里做，上游文件一行都不用动。

为什么内联而不是外链 <script src>：
    1) 不产生额外请求，也不受 CDN 缓存策略影响；
    2) 页面本来就有 inline <script>（web-app.html 里的加载动画），内联不会被任何 CSP 拦；
    3) 位置可控 —— 紧跟 <head> 之后，早于 trunk 注入的 module 脚本（module 默认 defer，
       所以即使它在 head 里，也会晚于本补丁执行）。

失败一律以 ::error:: + 非 0 退出码报错，绝不让「注入没生效」静默通过。
"""

import hashlib
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHIM_PATH = os.path.join(ROOT, ".github", "glsl-webgl-shim.js")
INDEX_PATH = os.path.join(ROOT, "dist", "index.html")
MARKER = "ocs-glsl-shim"
TAG_ATTR = "data-ocs-glsl-shim"


def fail(msg):
    print(f"::error::{msg}")
    sys.exit(1)


def main():
    if not os.path.isfile(SHIM_PATH):
        fail(f"找不到补丁文件: {SHIM_PATH}")
    if not os.path.isfile(INDEX_PATH):
        fail(f"找不到构建产物: {INDEX_PATH}（trunk 构建是否成功？）")

    with open(SHIM_PATH, encoding="utf-8") as fh:
        shim = fh.read()
    with open(INDEX_PATH, encoding="utf-8") as fh:
        html = fh.read()

    # ---- 补丁自身的安全检查 ----
    if MARKER not in shim:
        fail(f"补丁文件里没有标记字符串 '{MARKER}'，无法用于线上校验")
    if len(shim) < 2000:
        fail(f"补丁文件异常（只有 {len(shim)} 字节），疑似被截断")
    low = shim.lower()
    for bad in ("</script", "<!--"):
        if bad in low:
            fail(f"补丁文件包含会破坏内联 <script> 的片段: {bad!r}")
    shim_sha = hashlib.sha256(shim.encode("utf-8")).hexdigest()

    # ---- 幂等：已注入过就直接退出 ----
    if MARKER in html:
        print(f"index.html 里已存在 '{MARKER}'，跳过注入（幂等）")
        return

    # ---- 找锚点：<head ...> 开标签之后 ----
    m = re.search(r"<head\b[^>]*>", html, re.IGNORECASE)
    if not m:
        m = re.search(r"</head\s*>", html, re.IGNORECASE)
    if not m:
        fail("index.html 里既没有 <head> 也没有 </head>，找不到注入锚点"
             "（上游可能改了 html_output 结构，需要人工确认）")
    span = "after <head>" if m.group(0).lower().startswith("<head") else "before </head>"
    insert_at = m.end()

    block = (
        f"\n    <!-- WebGL2/GLES GLSL ES 数组精度兼容补丁：由 CI 注入，源码见 .github/glsl-webgl-shim.js -->\n"
        f'    <script {TAG_ATTR}="1">\n{shim}\n    </script>\n'
    )
    out = html[:insert_at] + block + html[insert_at:]

    # ---- 注入结果自检 ----
    if out.count(MARKER) != html.count(MARKER) + block.count(MARKER):
        fail("注入后标记数量不对，写入被破坏")
    marker_at = out.index(MARKER)
    wasm_at = out.find("_bg.wasm")
    if wasm_at != -1 and marker_at > wasm_at:
        print(f"::warning::{MARKER} 出现在 wasm 引用之后（offset {marker_at} > {wasm_at}），"
              "请确认补丁仍早于应用启动")

    with open(INDEX_PATH, "w", encoding="utf-8") as fh:
        fh.write(out)

    print(f"补丁文件: {SHIM_PATH}")
    print(f"  大小={len(shim.encode('utf-8'))} 字节  sha256={shim_sha}")
    print(f"index.html: {len(html.encode('utf-8'))} -> {len(out.encode('utf-8'))} 字节（{span} 注入）")
    print(f"  标记 '{MARKER}' 首次出现于 offset {marker_at}")
    print("OK 已注入 GLSL 数组精度补丁")


if __name__ == "__main__":
    main()
