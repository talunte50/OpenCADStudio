#!/usr/bin/env python3
"""Upload local ./dist to Cloudflare Pages via the current Create-deployment API.

Reads env vars: CLOUDFLARE_API_TOKEN, CF_ACCOUNT_ID, PROJECT_NAME.
Writes /tmp/cf_deployment.json = {"id": ..., "url": ...}.
Exit code 0 on success, 1 on any failure.
"""
import os, json, hashlib, mimetypes, urllib.request, urllib.error, uuid, sys


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

    # 2) 组 multipart body: manifest part + 每个唯一 hash 一个文件 part
    boundary = "----cfpages" + uuid.uuid4().hex
    crlf = b"\r\n"
    parts = []

    m_content = json.dumps(manifest).encode()
    parts.append(
        f"--{boundary}".encode()
        + crlf
        + b'Content-Disposition: form-data; name="manifest"' + crlf
        + b"Content-Type: application/json" + crlf + crlf
        + m_content + crlf
    )

    for h, content in unique.items():
        rel = hash2path.get(h, "")
        mime = mimetypes.guess_type(rel)[0] or "application/octet-stream"
        parts.append(
            f"--{boundary}".encode()
            + crlf
            + f'Content-Disposition: form-data; name="{h}"; filename="file"'.encode()
            + crlf
            + f"Content-Type: {mime}".encode() + crlf + crlf
            + content + crlf
        )

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
