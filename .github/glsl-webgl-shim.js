/*!
 * ocs-glsl-shim v1.0.0 —— WebGL2(GLES) 后端的 GLSL ES 数组精度兼容补丁
 * 标记字符串 "ocs-glsl-shim" 供部署后的首页注入校验使用，请勿改动。
 *
 * 【问题】wgpu 的着色器转换器（naga 29.x）生成 GLSL ES 时，数组类型不带精度限定符：
 *
 *     vec4 colors[8]        // 函数形参 / 局部变量声明
 *
 * naga 只在着色器顶部写 `precision highp float;`，而 GLSL ES 里这条语句【不覆盖数组类型】
 * ——数组不继承元素类型的默认精度。桌面 GL 驱动宽容，手机驱动（高通 Adreno 报 S0032）拒绝：
 *
 *     Shader compilation failed: 0:166: S0032: no default precision defined for variable 'vec4[8]'
 *
 * wgpu 把着色器验证错误按【致命】处理 → wasm panic → 页面白屏/弹渲染器错误。
 * iced_wgpu 的 Pipeline::new() 会无条件创建 triangle.solid 与 triangle.gradient 两条管线，
 * 所以只要应用启动就会踩到（不是偶发，也不是某个操作触发）。
 *
 * 【做法】hook WebGL2RenderingContext.prototype.shaderSource，在源码交给驱动之前，
 * 给数组类型的声明/形参补上显式 `highp`。每个改写结果先在一次性上下文里试编译：
 * 失败则退回更激进的改写，仍失败就原样返回——本文件不会让情况比现状更糟。
 *
 * 【范围】只作用于主文档里的 WebGL2 上下文（GLES 后端）。走 WebGPU 后端的浏览器
 * 不经过 naga 的 GLSL 后端，本补丁自然空转；Web Worker 有独立全局作用域，不在覆盖范围内
 * （worker 侧不创建渲染管线，与本崩溃无关）。
 *
 * 【关闭】URL 追加 `?glslshim=0` 可临时停用，用于在真机上判断问题是否由本补丁引起。
 */
(function () {
  "use strict";

  var W = typeof window !== "undefined" ? window : null;
  if (!W || W.__ocsGlslShim) return;

  var VERSION = "1.0.0";
  var MARKER = "ocs-glsl-shim";
  var LOG_LIMIT = 12;

  var stats = {
    version: VERSION,
    installed: false,
    seen: 0,
    rewritten: 0,
    unchanged: 0,
    fallback: 0,
    noProbe: 0,
    expanded: 0,
    logs: 0
  };

  var memo = Object.create(null);
  var origShaderSource = null;
  var probeGl = null;
  var probeDead = false;

  var api = { version: VERSION, marker: MARKER, stats: stats, rewrite: rewrite };
  /* 仅供离线测试/排障使用，运行时不会被调用 */
  api.debug = { addArrayPrecision: addArrayPrecision, expandArrayConstructors: expandArrayConstructors };
  W.__ocsGlslShim = api;

  function log(msg) {
    if (stats.logs >= LOG_LIMIT) return;
    stats.logs++;
    try { console.info("[" + MARKER + "] " + msg); } catch (e) { /* ignore */ }
  }

  var disabled = false;
  try {
    disabled = /(?:^|[?&])glslshim=(?:0|off|false)(?:&|=|$)/i.test(W.location && W.location.search || "");
  } catch (e) { /* ignore */ }
  if (disabled) {
    log("已被 URL 停用(?glslshim=0)，数组精度补丁未安装");
    return;
  }

  /* 只匹配内置基本类型名——结构体类型名不匹配，所以结构体成员/结构体变量不会被误改。 */
  var BUILTIN = "float|int|uint|bool|double|" +
    "vec[234]|ivec[234]|uvec[234]|bvec[234]|" +
    "mat[234]|mat[234]x[234]|" +
    "sampler2D|sampler3D|samplerCube|sampler2DArray|sampler2DShadow|samplerCubeShadow|" +
    "sampler2DArrayShadow|sampler2DMS|sampler2DMSArray|" +
    "isampler2D|isampler3D|isamplerCube|isampler2DArray|isampler2DMS|isampler2DMSArray|" +
    "usampler2D|usampler3D|usamplerCube|usampler2DArray|usampler2DMS|usampler2DMSArray|" +
    "image2D|image3D|imageCube|image2DArray|imageCubeArray|image2DMS|image2DMSArray|" +
    "iimage2D|iimage3D|iimageCube|iimage2DArray|iimageCubeArray|iimage2DMS|iimage2DMSArray|" +
    "uimage2D|uimage3D|uimageCube|uimage2DArray|uimageCubeArray|uimage2DMS|uimage2DMSArray";

  /* <类型> <标识符> [ N ] —— 声明或形参 */
  var DECL_RE = new RegExp("\\b(" + BUILTIN + ")(\\s+)([A-Za-z_]\\w*)(\\s*\\[\\s*\\d+\\s*\\])", "g");

  /* <类型> <标识符> [ N ] = <类型> [ N ] ( —— 带「数组构造」初始化的声明 */
  var INIT_RE = new RegExp(
    "\\b(" + BUILTIN + ")(\\s+)([A-Za-z_]\\w*)(\\s*\\[\\s*(\\d+)\\s*\\])\\s*=\\s*(?:" + BUILTIN +
    ")\\s*\\[\\s*\\5\\s*\\]\\s*\\(", "g");

  /* 类型名前面已经有精度限定符 → 不重复插入（否则会产生 "highp highp" 语法错误） */
  var HAS_PREC_RE = /(?:^|[^A-Za-z0-9_])(?:highp|mediump|lowp)\s+$/;
  /* 带这些限定符的声明不适合做「构造展开」改写 */
  var NO_EXPAND_RE = /(?:^|[^A-Za-z0-9_])(?:const|uniform|in|out|inout|attribute|varying)\s+$/;

  /* ---------- 结构体体范围：结构体成员的精度限定符在 ESSL 里是不合法的，必须跳过 ---------- */
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

  /* ---------- 策略 1：给数组类型的声明/形参补 highp（改动最小） ---------- */
  function addArrayPrecision(src) {
    var skips = structBodyRanges(src);
    var count = 0;
    var out = src.replace(DECL_RE, function (full, type, sp, id, br, offset) {
      if (inRanges(offset, skips)) return full;
      if (HAS_PREC_RE.test(src.slice(Math.max(0, offset - 16), offset))) return full;
      count++;
      return "highp " + full;
    });
    return count ? { src: out, count: count } : null;
  }

  /* ---------- 策略 2：把 `T x[N] = T[N](a0..aN-1);` 拆成「声明 + 逐元素赋值」 ---------- */
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
    if (cur.trim() !== "" || parts.length > 0) parts.push(cur);
    var out = [];
    for (var j = 0; j < parts.length; j++) {
      var t = parts[j].trim();
      if (t !== "") out.push(t);
    }
    return out.length === expected ? out : null;
  }

  function expandArrayConstructors(src) {
    var skips = structBodyRanges(src);
    var re = new RegExp(INIT_RE.source, "g");
    var chunks = [], last = 0, count = 0, m;
    while ((m = re.exec(src)) !== null) {
      var offset = m.index, full = m[0], size = parseInt(m[5], 10);
      if (inRanges(offset, skips)) continue;
      if (NO_EXPAND_RE.test(src.slice(Math.max(0, offset - 24), offset))) continue;
      var open = offset + full.length - 1;
      var end = matchParen(src, open);
      if (end < 0) continue;
      var args = splitArgs(src.slice(open + 1, end), size);
      if (!args) continue;
      var stmts = "", i;
      for (i = 0; i < size; i++) stmts += " " + m[3] + "[" + i + "] = " + args[i] + ";";
      chunks.push(src.slice(last, offset), m[1] + m[2] + m[3] + m[4] + ";" + stmts);
      last = end + 1;
      count++;
    }
    if (!count) return null;
    chunks.push(src.slice(last));
    return { src: chunks.join(""), count: count };
  }

  /* ---------- 试编译：用一次性 WebGL2 上下文验证改写结果 ---------- */
  function probeContext() {
    if (probeDead) return null;
    if (probeGl) return probeGl;
    try {
      var cv = document.createElement("canvas");
      cv.width = 1;
      cv.height = 1;
      var gl = cv.getContext("webgl2", { antialias: false, depth: false, stencil: false });
      if (!gl) { probeDead = true; return null; }
      probeGl = gl;
      return gl;
    } catch (e) {
      probeDead = true;
      return null;
    }
  }

  /* 返回 true=编译通过 / false=编译失败 / null=无法判定（无 GL 或被浏览器限制） */
  function probeCompile(source, stage) {
    var gl = probeContext();
    if (!gl || !origShaderSource) return null;
    var sh = null;
    try {
      sh = gl.createShader(stage === "vertex" ? gl.VERTEX_SHADER : gl.FRAGMENT_SHADER);
      if (!sh) return null;
      origShaderSource.call(gl, sh, source);
      gl.compileShader(sh);
      var ok = !!gl.getShaderParameter(sh, gl.COMPILE_STATUS);
      if (!ok) {
        var info = gl.getShaderInfoLog(sh);
        if (info && String(info).trim() !== "") log("试编译未通过: " + String(info).slice(0, 180));
      }
      return ok;
    } catch (e) {
      return null;
    } finally {
      try { if (sh) gl.deleteShader(sh); } catch (e2) { /* ignore */ }
    }
  }

  /* ---------- 主入口 ---------- */
  function rewrite(source, stage) {
    if (typeof source !== "string" || source.indexOf("[") === -1) return source;
    var cached = memo[source];
    if (cached !== undefined) return cached;

    stage = stage === "vertex" ? "vertex" : "fragment";
    stats.seen++;
    var chosen = source;

    var s1 = addArrayPrecision(source);
    if (!s1) {
      stats.unchanged++;
    } else {
      var ok1 = probeCompile(s1.src, stage);
      if (ok1 !== false) {
        if (ok1 === null) stats.noProbe++;
        chosen = s1.src;
        stats.rewritten++;
        log("着色器 #" + stats.seen + "(" + stage + ")：为 " + s1.count + " 处数组声明补 highp" +
          (ok1 === null ? "（无法试编译，直接采用）" : ""));
      } else {
        var s2 = expandArrayConstructors(s1.src);
        if (s2 && probeCompile(s2.src, stage) !== false) {
          chosen = s2.src;
          stats.rewritten++;
          stats.expanded++;
          log("着色器 #" + stats.seen + "：策略 1 试编译失败，改用策略 2 展开 " + s2.count + " 处数组构造");
        } else {
          stats.fallback++;
          log("着色器 #" + stats.seen + "：改写后试编译失败，回退原始源码（保持现状）");
        }
      }
    }

    memo[source] = chosen;
    return chosen;
  }

  function install() {
    var Ctx = W.WebGL2RenderingContext;
    if (!Ctx || !Ctx.prototype || typeof Ctx.prototype.shaderSource !== "function") {
      log("未找到 WebGL2RenderingContext.shaderSource，补丁未安装（本机大概率走 WebGPU 后端，无需该补丁）");
      return false;
    }
    origShaderSource = Ctx.prototype.shaderSource;
    Ctx.prototype.shaderSource = function (shader, source) {
      var out = source;
      try {
        var stage = "fragment";
        try {
          var t = this.getShaderParameter(shader, this.SHADER_TYPE);
          if (t === this.VERTEX_SHADER) stage = "vertex";
        } catch (e) { /* 取不到就按 fragment 处理：补 highp 对两种阶段都合法 */ }
        out = rewrite(source, stage);
      } catch (e2) {
        stats.fallback++;
        out = source;
      }
      return origShaderSource.call(this, shader, out);
    };
    stats.installed = true;
    log("已安装 WebGL2 shaderSource 钩子 (v" + VERSION + ")");
    return true;
  }

  install();
})();
