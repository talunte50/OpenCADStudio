#!/usr/bin/env python3
"""Upload local ./dist to Cloudflare Pages via the Create-deployment API.

Reads env vars: CLOUDFLARE_API_TOKEN, CF_ACCOUNT_ID, PROJECT_NAME.
Writes /tmp/cf_deployment.json = {"id": ..., "url": ...}.
Exit code 0 on success, 1 on any failure.

CF Pages create-deployment multipart 约定（官方文档验证过的格式）：
- 字段 1: manifest — 普通 form-data 字段，值是 JSON 字符串 {"/path": "sha256hex"}
- 字段 2..N: 每个唯一内容一个文件 part，name = 该内容的 sha256hex
- 可选字段: production — 普通 form-data 字段，值 "true"
- 关键: 不要对 body 做截断/拼接 hack，所有字段在同一个 parts 列表里顺序追加
"""
import os, json, hashlib, urllib.request, urllib.error, uuid, sys


def _mime_for(rel: str) -> str:
    if rel.endswith(".html"): return "text/html; charset=utf-8"
    if rel.endswith(".js"): return "text/javascript"
    if rel.endswith(".wasm"): return "application/wasm"
    if rel.endswith(".json"): return "application/json"
    if rel.endswith(".ttf"): return "font/ttf"
    if rel.endswith(".otf"): return "font/otf"
    if rel.endswith(".svg"): return "image/svg+xml"
    if rel.endswith(".css"): return "text/css"
    return "application/octet-stream"


def main() -> int:
    base = "https://api.cloudflare.com/client/v4"
    token = os.environ["CLOUDFLARE_API_TOKEN"]
    account = os.environ["CF_ACCOUNT_ID"]
    project = os.environ["PROJECT_NAME"]
    dist_dir = os.environ.get("CF_DIST_DIR", "dist")

    if not os.path.isdir(dist_dir):
        print(f"dist dir not found: {dist_dir}", file=sys.stderr)
        return 1

    # 1) 扫描文件，算 SHA-256，建 manifest（path -> hash）和 唯一内容集
    files = []
    for root, _, fnames in os.walk(dist_dir):
        for fn in fnames:
            p = os.path.join(root, fn)
            rel = "/" + os.path.relpath(p, dist_dir).replace(os.sep, "/")
            with open(p, "rb") as f:
                content = f.read()
            h = hashlib.sha256(content).hexdigest()
            files.append((rel, h, content))
            print(f"  {rel}  ({len(content)} bytes, sha256={h[:12]}...)")

    manifest = {rel: h for rel, h, _ in files}
    unique = {}
    hash2path = {}
    for rel, h, content in files:
        unique[h] = content
        hash2path[h] = rel
    print(f"total {len(files)} files, {len(unique)} unique")

    # 2) 组 multipart body — 所有字段按顺序追加到同一个 parts 列表
    boundary = "----cfpages" + uuid.uuid4().hex
    crlf = b"\r\n"
    parts = []

    # 字段 1: manifest（普通 form-data 文本字段，值为 JSON 字符串）
    m_content = json.dumps(manifest).encode()
    parts.append(
        f"--{boundary}".encode() + crlf
        + b'Content-Disposition: form-data; name="manifest"' + crlf
        + crlf
        + m_content + crlf
    )

    # 字段 2: production（让 deployment 直接上线为可访问的生产版本）
    parts.append(
        f"--{boundary}".encode() + crlf
        + b'Content-Disposition: form-data; name="production"' + crlf
        + crlf
        + b"true" + crlf
    )

    # 字段 3..N: 每个唯一内容一个文件 part（name = sha256）
    for h, content in unique.items():
        rel = hash2path.get(h, "")
        mime = _mime_for(rel)
        parts.append(
            f"--{boundary}".encode() + crlf
            + f'Content-Disposition: form-data; name="{h}"; filename="file"'.encode() + crlf
            + f"Content-Type: {mime}".encode() + crlf + crlf
            + content + crlf
        )

    # 结束 boundary — 直接追加，不做任何截断
    body = b"".join(parts) + f"--{boundary}--".encode() + crlf

    # 3) 调 create deployment
    url = f"{base}/accounts/{account}/pages/projects/{project}/deployments"
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": f"multipart/form-data; boundary={boundary}",
    })
    try:
        with urllib.request.urlopen(req, timeout=900) as r:
            resp = json.load(r)
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", "replace")
        print(f"Create deployment failed (HTTP {e.code}):", file=sys.stderr)
        print(err[:3000], file=sys.stderr)
        return 1

    if not resp.get("success"):
        print("API returned success=false:", file=sys.stderr)
        print(json.dumps(resp.get("errors", resp), indent=2)[:3000], file=sys.stderr)
        return 1

    dep = resp["result"]
    dep_id = dep.get("id")
    dep_url = dep.get("url") or ""
    print(f"Deployment created: {dep_id}")
    print(f"Initial URL: {dep_url}")
    with open("/tmp/cf_deployment.json", "w") as f:
        json.dump({"id": dep_id, "url": dep_url}, f)
    return 0


if __name__ == "__main__":
    sys.exit(main())
