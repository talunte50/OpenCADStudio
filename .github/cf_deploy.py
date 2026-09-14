#!/usr/bin/env python3
"""Upload local ./dist to Cloudflare Pages via the current Create-deployment API.

Reads env vars: CLOUDFLARE_API_TOKEN, CF_ACCOUNT_ID, PROJECT_NAME.
Writes /tmp/cf_deployment.json = {"id": ..., "url": ...}.
Exit code 0 on success, 1 on any failure.

Cloudflare Pages "create deployment" multipart 约定：
- 一个普通 form-data 字段 `manifest`：值是 JSON 字符串 {"/path": "sha256hex", ...}
- 每个唯一内容一个 form-data 字段，`name` = 该内容的 sha256hex（无 filename）
- 字段顺序：manifest 在前，hash 字段在后（CF 要求先看到 manifest 建立映射）
"""
import os, json, hashlib, urllib.request, urllib.error, uuid, sys


def main() -> int:
    base = "https://api.cloudflare.com/client/v4"
    token = os.environ["CLOUDFLARE_API_TOKEN"]
    account = os.environ["CF_ACCOUNT_ID"]
    project = os.environ["PROJECT_NAME"]
    dist_dir = os.environ.get("CF_DIST_DIR", "dist")

    if not os.path.isdir(dist_dir):
        print(f"dist dir not found: {dist_dir}", file=sys.stderr)
        return 1

    # 1) 扫描文件，算 SHA-256，建 manifest（URL path -> sha256）和 唯一内容集
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
    for rel, h, content in files:
        unique[h] = content
    print(f"total {len(files)} files, {len(unique)} unique")

    # 2) 组 multipart body。CF 要求 manifest 是普通 form-data 字段（JSON 字符串），
    #    每个 hash 字段是文件 part（name=sha256，不带 filename 也可，CF 按 name 找）。
    boundary = "----cfpages" + uuid.uuid4().hex
    crlf = b"\r\n"
    parts = []

    # manifest 字段（普通 form-data 文本，值为 JSON 字符串）
    m_content = json.dumps(manifest).encode()
    parts.append(
        f"--{boundary}".encode() + crlf
        + b'Content-Disposition: form-data; name="manifest"' + crlf
        + crlf
        + m_content + crlf
    )

    # 每个唯一内容一个 part（name = sha256），文件 part 带 filename + content-type
    for h, content in unique.items():
        # 用对应路径猜 mime
        rel = next((r for r in manifest if manifest[r] == h), "")
        if rel.endswith(".html"):
            mime = "text/html"
        elif rel.endswith(".js"):
            mime = "text/javascript"
        elif rel.endswith(".wasm"):
            mime = "application/wasm"
        elif rel.endswith(".json"):
            mime = "application/json"
        elif rel.endswith(".ttf") or rel.endswith(".otf"):
            mime = "font/ttf"
        elif rel.endswith(".svg"):
            mime = "image/svg+xml"
        else:
            mime = "application/octet-stream"
        parts.append(
            f"--{boundary}".encode() + crlf
            + f'Content-Disposition: form-data; name="{h}"; filename="file"'.encode() + crlf
            + f"Content-Type: {mime}".encode() + crlf + crlf
            + content + crlf
        )

    body = b"".join(parts) + f"--{boundary}--".encode() + crlf

    # 3) 调 create deployment（带 production=true 使其直接上线为可访问版本）
    url = f"{base}/accounts/{account}/pages/projects/{project}/deployments"
    parts2 = [b"production"]
    # 把 production 也作为普通 form-data 字段加进去（值 "true"）
    body = body[:-len(crlf)]  # 去掉结尾的 closing boundary
    # 重新追加 production 字段 + closing boundary
    prod_field = (
        f"--{boundary}".encode() + crlf
        + b'Content-Disposition: form-data; name="production"' + crlf
        + crlf
        + b"true" + crlf
    )
    body = body + prod_field + f"--{boundary}--".encode() + crlf

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
