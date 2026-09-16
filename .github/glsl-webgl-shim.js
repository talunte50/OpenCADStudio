/*!
 * ocs-glsl-shim v2.0.0 —— WebGL2(GLES) 后端的 GLSL ES 数组精度兼容补丁
 * 标记字符串 "ocs-glsl-shim" 供部署后的首页注入校验使用，请勿改动。
 *
 * 【问题】wgpu 的着色器转换器（naga 29.x）生成 GLSL ES 时，数组类型不带精度限定符：
 *
 *     vec4 gradient(vec2 p, vec4 colors[8], float offsets[8], int i) { ... }
 *     vec4 colors_arr[8] = vec4[8](vec4(0.0), ...);
 *     offsets = float[8](a, b, c, d, e, f, g, h);
 *
 * GLSL ES 的 `precision highp float;` 只覆盖【标量/向量/矩阵】声明，**不覆盖数组类型**
 * ——数组不继承元素类型的默认精度。桌面驱动宽容，手机驱动（高通 Adreno 报 S0032）拒绝：
 *
 *     Shader compilation failed: 0:166: S0032: no default precision defined for variable 'vec4[8]'
 *
 * wgpu 把着色器验证错误按【致命】处理 → wasm panic → 页面白屏/弹渲染器错误。
 * iced_wgpu 的 Pipeline::new() 会无条件创建 triangle.solid 与 triangle.gradient 两条管线，
 * 所以只要应用启动就会踩到（不是偶发，也不是某个操作触发）。
 *
 * 【做法 v2：编译失败才改写，且用真实上下文判定】
 * 同时挂 shaderSource 与 compileShader 两个钩子：
 *   1. shaderSource 只记录源码，原样下发 —— 能正常编译的着色器一个字节都不改；
 *   2. compileShader 先按原样编译。**只有编译失败时**才依次尝试三种改写，
 *      每次都用【同一个真实上下文】重新编译来判定成败：
 *        A. 给所有数组类型的声明/形参补显式 highp
 *        B. A + 把 `T x[N] = T[N](...)` 展开成「声明 + 逐元素赋值」
 *        C. B + 把独立赋值 `x = T[N](...)` 也展开成逐元素赋值
 *      三种都失败就还原源码重新编译（保留驱动原始报错，不比现状更糟）。
 * v1 用的是「改写后先在一次性上下文里试编译」——手机上那个额外上下文可能拿不到、或编译
 * 判定不可靠，一旦误判失败就回退原始源码，等于补丁完全不生效。v2 改用真实上下文，且只在
 * 真失败时动手，从根上避免这个问题。
 *
 * 【诊断】
 *   ?glslshim=0      停用补丁（真机排查用，v1 也认这个参数）
 *   ?glslshim=info   左上角显示状态条：版本/着色器数/编译失败数/已修复数
 * 编译失败且三种改写都救不回来时，页面左上角自动浮出报告：驱动原始报错 + 每次改写的报错 +
 * 源码里所有数组相关行（带行号）+ 总行数，可直接截图反馈。
 *
 * 【范围】只作用于主文档里的 WebGL/WebGL2 上下文（GLES 后端）。走 WebGPU 后端的浏览器
 * 不经过 naga 的 GLSL 后端，本补丁自然空转；Web Worker 有独立全局作用域，不在覆盖范围内。
 */
(function () {
  "use strict";

  var W = typeof window !== "undefined" ? window : null;
  if (!W || W.__ocsGlslShim) return;

  var VERSION = "2.0.0";
  var MARKER = "ocs-glsl-shim";
  var LOG_LIMIT = 20;

  var stats = {
    version: VERSION,
    installed: false,
    seen: 0,
    compiled: 0,
    compileFailed: 0,
    repaired: 0,
    unrepairable: 0,
    noSource: 0,
    disabled: false,
    lastError: "",
    lastStage: "",
    lastRepair: ""
  };

  var logCount = 0;
  function log(msg) {
    if (logCount >= LOG_LIMIT) return;
    logCount++;
    try { console.info("[" + MARKER + "] " + msg); } catch (e) { /* ignore */ }
  }

  /* ---------------- URL 开关 ---------------- */
  var param = "";
  try {
    var pm = /(?:^|[?&])glslshim=([^&]*)/i.exec((W.location && W.location.search) || "");
    param = pm ? decodeURIComponent(pm[1]).toLowerCase() : "";
  } catch (e) { /* ignore */ }
  if (param === "0" || param === "off" || param === "false") {
    stats.disabled = true;
    log("已被 URL 停用(?glslshim=0)，数组精度补丁未安装");
    return;
  }
  var wantInfo = param === "info" || param === "dump" || param === "1";

  /* ---------------- 类型名与正则 ---------------- */
  var BUILTIN = "float|int|uint|bool|double|" +
    "vec[234]|ivec[234]|uvec[234]|bvec[234]|" +
    "mat[234]|mat[234]x[234]";

  var PREC = "highp|mediump|lowp";

  /* 数组声明 / 形参：<类型> <名字> [ N ]
     名字带长度后缀的写法只可能出现在声明或形参里（数组构造 vec4[8](...) 没有名字），
     所以不需要语句边界约束；结构体体内会被单独跳过。 */
  var DECL_RE = new RegExp(
    "\\b(" + BUILTIN + ")(\\s+)([A-Za-z_]\\w*)(\\s*\\[\\s*\\d+\\s*\\])", "g");

  /* 带数组构造的声明：<精度?> <类型> <名字> [N] = <类型> [N] ( ... ) */
  var INIT_RE = new RegExp(
    "(^|[;{}])(\\s*)((?:" + PREC + ")\\s+)?" +
    "\\b(" + BUILTIN + ")(\\s+)([A-Za-z_]\\w*)(\\s*\\[\\s*(\\d+)\\s*\\])\\s*=\\s*" +
    "\\b(?:" + BUILTIN + ")\\s*\\[\\s*\\8\\s*\\]\\s*\\(", "g");

  /* 独立的数组赋值：<名字> = <类型> [N] ( ... ) */
  var ASSIGN_RE = new RegExp(
    "(^|[;{}])(\\s*)([A-Za-z_]\\w*)\\s*=\\s*" +
    "\\b(?:" + BUILTIN + ")\\s*\\[\\s*(\\d+)\\s*\\]\\s*\\(", "g");

  /* 类型名紧邻的前一个词已经是精度限定符 → 不再插入，避免 highp highp */
  var HAS_PREC_RE = new RegExp("(?:^|[^A-Za-z0-9_])(?:" + PREC + ")\\s*$");

  /* ---------------- 工具 ---------------- */
  function structBodyRanges(src) {
    var ranges = [];
    var re = /\bstruct\b[^;{}]*\{/g, m;
    while ((m = re.exec(src)) !== null) {
      var start = m.index, depth = 0, j = start + m[0].length - 1;
      for (; j < src.length; j++) {
        var c = src.charAt(j);
        if (c === "{") depth++;
        else if (c === "}") { depth--; if (depth === 0) { j++; break; } }
      }
      ranges.push([start, j]);
    }
    return ranges;
  }

  function inRanges(idx, ranges) {
    for (var i = 0; i < ranges.length; i++) {
      if (idx >= ranges[i][0] && idx < ranges[i][1]) return true;
    }
    return false;
  }

  /* 函数体范围：`)` 紧跟 `{` 视为函数体开头（naga 的写法一致）。
     展开数组构造会引入赋值语句，只在函数体里合法——全局作用域的
     `vec2 uvs[6] = vec2[6](...)` 一旦展开成 `uvs[0] = ...;` 就是语法错误（已实测）。 */
  function funcBodyRanges(src) {
    var ranges = [];
    var re = /\)\s*\{/g, m;
    while ((m = re.exec(src)) !== null) {
      var open = m.index + m[0].length - 1;   /* '{' 的位置 */
      var depth = 0, j = open;
      for (; j < src.length; j++) {
        var c = src.charAt(j);
        if (c === "{") depth++;
        else if (c === "}") { depth--; if (depth === 0) { j++; break; } }
      }
      ranges.push([open, j]);
    }
    return ranges;
  }

  function matchParen(src, open) {
    var depth = 0;
    for (var i = open; i < src.length; i++) {
      var c = src.charAt(i);
      if (c === "(") depth++;
      else if (c === ")") { depth--; if (depth === 0) return i; }
    }
    return -1;
  }

  function splitArgs(text, expected) {
    var parts = [], depth = 0, cur = "";
    for (var i = 0; i < text.length; i++) {
      var c = text.charAt(i);
      if (c === "(" || c === "[") depth++;
      else if (c === ")" || c === "]") depth--;
      if (c === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
      cur += c;
    }
    parts.push(cur);
    var out = [];
    for (var j = 0; j < parts.length; j++) {
      var t = parts[j].trim();
      if (t !== "") out.push(t);
    }
    return out.length === expected ? out : null;
  }

  /* ---------------- 改写 A：数组类型补 highp ---------------- */
  function addArrayPrecision(src) {
    if (typeof src !== "string" || src.indexOf("[") === -1) return null;
    var skips = structBodyRanges(src);
    var count = 0;
    var out = src.replace(DECL_RE, function (full, type, sp, name, br, offset) {
      if (inRanges(offset, skips)) return full;
      if (HAS_PREC_RE.test(src.slice(Math.max(0, offset - 40), offset))) return full;
      count++;
      return "highp " + full;
    });
    return count ? { src: out, count: count } : null;
  }

  /* ---------------- 改写 B：展开「声明 + 数组构造」 ---------------- */
  function expandArrayInits(src) {
    if (typeof src !== "string") return null;
    var skips = structBodyRanges(src);
    var bodies = funcBodyRanges(src);
    var re = new RegExp(INIT_RE.source, "g");
    var chunks = [], last = 0, count = 0, m;
    while ((m = re.exec(src)) !== null) {
      var offset = m.index;
      if (inRanges(offset, skips)) continue;
      if (!inRanges(offset, bodies)) continue;           /* 只在函数体内展开 */
      var size = parseInt(m[8], 10);
      var open = offset + m[0].length - 1;
      var end = matchParen(src, open);
      if (end < 0) continue;
      var args = splitArgs(src.slice(open + 1, end), size);
      if (!args) continue;
      if (!/^\s*;/.test(src.slice(end + 1))) continue;   /* 必须是完整语句 */
      var stmts = "";
      for (var i = 0; i < size; i++) stmts += " " + m[6] + "[" + i + "] = " + args[i] + ";";
      chunks.push(src.slice(last, offset),
        m[1] + m[2] + (m[3] || "") + m[4] + m[5] + m[6] + m[7] + ";" + stmts);
      last = end + 1;
      count++;
      re.lastIndex = end + 1;
    }
    if (!count) return null;
    chunks.push(src.slice(last));
    return { src: chunks.join(""), count: count };
  }

  /* ---------------- 改写 C：展开独立的数组赋值 ---------------- */
  function expandArrayAssigns(src) {
    if (typeof src !== "string") return null;
    var skips = structBodyRanges(src);
    var bodies = funcBodyRanges(src);
    var re = new RegExp(ASSIGN_RE.source, "g");
    var chunks = [], last = 0, count = 0, m;
    while ((m = re.exec(src)) !== null) {
      var offset = m.index;
      if (inRanges(offset, skips)) continue;
      if (!inRanges(offset, bodies)) continue;           /* 只在函数体内展开 */
      var size = parseInt(m[4], 10);
      var open = offset + m[0].length - 1;
      var end = matchParen(src, open);
      if (end < 0) continue;
      var args = splitArgs(src.slice(open + 1, end), size);
      if (!args) continue;
      if (!/^\s*;/.test(src.slice(end + 1))) continue;
      var stmts = "";
      for (var i = 0; i < size; i++) stmts += " " + m[3] + "[" + i + "] = " + args[i] + ";";
      chunks.push(src.slice(last, offset), m[1] + m[2] + stmts);
      last = end + 1;
      count++;
      re.lastIndex = end + 1;
    }
    if (!count) return null;
    chunks.push(src.slice(last));
    return { src: chunks.join(""), count: count };
  }

  /* ---------------- 候选改写序列（累积式） ---------------- */
  function repairCandidates(src) {
    var out = [];
    var a = addArrayPrecision(src);
    var base = a ? a.src : src;
    if (a) out.push({ name: "A 数组补 highp", src: a.src, n: a.count });
    var b = expandArrayInits(base);
    if (b) out.push({ name: "B A+展开数组构造", src: b.src, n: b.count });
    var c = expandArrayAssigns(b ? b.src : base);
    if (c) out.push({ name: "C B+展开数组赋值", src: c.src, n: c.count });
    return out;
  }

  /* ---------------- 诊断浮层 ---------------- */
  var uiBox = null, uiText = null;

  function copyText(t) {
    try {
      if (W.navigator && W.navigator.clipboard && W.navigator.clipboard.writeText) {
        W.navigator.clipboard.writeText(t);
        return;
      }
    } catch (e) { /* ignore */ }
    try {
      var ta = W.document.createElement("textarea");
      ta.value = t;
      ta.style.cssText = "position:fixed;left:-9999px;top:0;";
      W.document.body.appendChild(ta);
      ta.select();
      W.document.execCommand("copy");
      W.document.body.removeChild(ta);
    } catch (e2) { /* ignore */ }
  }

  function ensureUI() {
    if (uiBox || !W.document || !W.document.body) return;
    try {
      uiBox = W.document.createElement("div");
      uiBox.setAttribute("data-ocs-glsl-shim", "ui");
      uiBox.style.cssText = "position:fixed;left:0;top:0;z-index:2147483647;max-width:100%;" +
        "max-height:62%;overflow:auto;background:rgba(0,0,0,.87);color:#8ef;" +
        "font:11px/1.45 monospace;padding:6px 8px;-webkit-user-select:text;user-select:text;";
      uiText = W.document.createElement("div");
      uiText.style.cssText = "white-space:pre-wrap;word-break:break-all;";
      uiBox.appendChild(uiText);
      var btn = W.document.createElement("button");
      btn.textContent = "复制报告";
      btn.style.cssText = "margin-top:6px;font:12px monospace;padding:4px 10px;";
      btn.onclick = function () { copyText(uiText.textContent || ""); };
      uiBox.appendChild(btn);
      var hide = W.document.createElement("button");
      hide.textContent = "关闭";
      hide.style.cssText = "margin:6px 0 0 6px;font:12px monospace;padding:4px 10px;";
      hide.onclick = function () { uiBox.style.display = "none"; };
      uiBox.appendChild(hide);
      W.document.body.appendChild(uiBox);
    } catch (e) { /* ignore */ }
  }

  function showStatus() {
    try {
      ensureUI();
      if (!uiBox) return;
      uiText.textContent = "ocs-glsl-shim v" + VERSION +
        "  已安装=" + stats.installed +
        "  着色器=" + stats.seen +
        "  已编译=" + stats.compiled +
        "  编译失败=" + stats.compileFailed +
        "  已修复=" + stats.repaired +
        "  未能修复=" + stats.unrepairable +
        (stats.lastRepair ? "\n最近修复: " + stats.lastRepair : "");
      uiBox.style.display = "block";
    } catch (e) { /* ignore */ }
  }

  function arrayLines(src) {
    var out = [], lines = String(src).split("\n");
    for (var i = 0; i < lines.length; i++) {
      if (/\[\s*\d+\s*\]/.test(lines[i])) out.push((i + 1) + "| " + lines[i].slice(0, 220));
      if (out.length >= 40) { out.push("...（更多数组行已省略）"); break; }
    }
    return out.length ? out : ["(源码中没有带数字长度的数组行)"];
  }

  function showFailure(info) {
    try {
      ensureUI();
      if (!uiBox) return;
      var body = "ocs-glsl-shim v" + VERSION + " 诊断报告\n" +
        "URL: " + String((W.location && W.location.href) || "") + "\n" +
        "UA : " + String((W.navigator && W.navigator.userAgent) || "") + "\n" +
        "阶段: " + info.stage + "   源码行数: " + info.lines + "   字符数: " + info.len + "\n\n" +
        "--- 驱动原始报错 ---\n" + (info.error || "(空)").slice(0, 900) + "\n\n";
      if (!info.attempts.length) {
        body += "--- 未生成任何改写候选（源码里没有识别到数组声明/构造）---\n\n";
      }
      info.attempts.forEach(function (a) {
        body += "--- 尝试 " + a.name + " 后 ---\n" + (a.error || "(空)").slice(0, 500) + "\n\n";
      });
      body += "--- 数组相关源码行（行号 | 内容）---\n" + info.arrayLines.join("\n") + "\n\n";
      body += "--- 完整源码（可点「复制报告」一次性带走）---\n" + String(info.source).slice(0, 12000) + "\n";
      uiText.textContent = body;
      uiBox.style.display = "block";
    } catch (e) { /* ignore */ }
  }

  var api = {
    version: VERSION,
    marker: MARKER,
    stats: stats,
    lastFailure: null,
    /* 供离线测试与人工排查使用；运行时不会被调用 */
    debug: {
      addArrayPrecision: addArrayPrecision,
      expandArrayInits: expandArrayInits,
      expandArrayAssigns: expandArrayAssigns,
      repairCandidates: repairCandidates
    }
  };
  W.__ocsGlslShim = api;

  /* ---------------- 安装钩子 ---------------- */
  function installOn(proto) {
    if (!proto || !proto.shaderSource || !proto.compileShader) return false;
    if (proto.__ocsGlslShimHooked) return true;

    var origShaderSource = proto.shaderSource;
    var origCompileShader = proto.compileShader;
    var srcOf = new WeakMap();

    proto.shaderSource = function (shader, source) {
      try { if (typeof source === "string") srcOf.set(shader, source); } catch (e) { /* ignore */ }
      stats.seen++;
      return origShaderSource.call(this, shader, source);
    };

    proto.compileShader = function (shader) {
      var ret = origCompileShader.call(this, shader);
      var ok = false;
      try { ok = !!this.getShaderParameter(shader, this.COMPILE_STATUS); } catch (e) { ok = false; }
      stats.compiled++;
      if (ok) { if (wantInfo) showStatus(); return ret; }

      stats.compileFailed++;
      var gl = this;
      var original = null;
      try { original = srcOf.get(shader); } catch (e) { /* ignore */ }
      if (typeof original !== "string") {
        stats.noSource++;
        if (wantInfo) showStatus();
        return ret;
      }

      var stage = "fragment";
      try {
        if (gl.getShaderParameter(shader, gl.SHADER_TYPE) === gl.VERTEX_SHADER) stage = "vertex";
      } catch (e) { /* ignore */ }

      var firstError = "";
      try { firstError = String(gl.getShaderInfoLog(shader) || ""); } catch (e) { /* ignore */ }
      stats.lastError = firstError.slice(0, 200);
      stats.lastStage = stage;
      log("编译失败(" + stage + "): " + firstError.slice(0, 160));

      var attempts = [];
      var cands = repairCandidates(original);
      for (var i = 0; i < cands.length; i++) {
        var ok2 = false, err2 = "";
        try {
          origShaderSource.call(gl, shader, cands[i].src);
          ret = origCompileShader.call(gl, shader);
          ok2 = !!gl.getShaderParameter(shader, gl.COMPILE_STATUS);
          if (!ok2) err2 = String(gl.getShaderInfoLog(shader) || "");
        } catch (e) {
          err2 = "异常: " + String(e);
        }
        if (ok2) {
          stats.repaired++;
          stats.lastRepair = cands[i].name + "（" + cands[i].n + " 处）";
          log("已修复(" + stage + ")：采用「" + cands[i].name + "」，改写 " + cands[i].n + " 处");
          if (wantInfo) showStatus();
          return ret;
        }
        attempts.push({ name: cands[i].name, error: err2 });
        log("「" + cands[i].name + "」后仍失败: " + err2.slice(0, 130));
      }

      /* 全部失败：还原原始源码重新编译，保留驱动自己的报错 */
      try {
        origShaderSource.call(gl, shader, original);
        ret = origCompileShader.call(gl, shader);
      } catch (e) { /* ignore */ }

      stats.unrepairable++;
      var info = {
        stage: stage,
        error: firstError,
        lines: original.split("\n").length,
        len: original.length,
        attempts: attempts,
        arrayLines: arrayLines(original),
        source: original
      };
      api.lastFailure = info;
      log("未能修复(" + stage + ")，已还原源码；候选 " + cands.length + " 种均失败");
      showFailure(info);
      return ret;
    };

    proto.__ocsGlslShimHooked = true;
    return true;
  }

  function install() {
    var ok = false;
    try { ok = installOn(W.WebGL2RenderingContext && W.WebGL2RenderingContext.prototype) || ok; }
    catch (e) { /* ignore */ }
    try { ok = installOn(W.WebGLRenderingContext && W.WebGLRenderingContext.prototype) || ok; }
    catch (e) { /* ignore */ }
    if (!ok) {
      log("未找到 WebGL shaderSource/compileShader，补丁未安装（本机大概率走 WebGPU 后端，无需该补丁）");
      return false;
    }
    stats.installed = true;
    log("已安装 shaderSource + compileShader 钩子 (v" + VERSION + ")，策略=仅在编译失败时改写");
    if (wantInfo) {
      showStatus();
      var n = 0;
      var t = W.setInterval(function () {
        showStatus();
        if (++n >= 15) W.clearInterval(t);
      }, 2000);
    }
    return true;
  }

  install();
})();
