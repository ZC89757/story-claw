#!/bin/bash
set -e
echo "=== 1. 获取最新 mihomo 下载URL ==="
URL=$(python3 -c "import urllib.request,json; r=json.load(urllib.request.urlopen('https://api.github.com/repos/MetaCubeX/mihomo/releases/latest'));print([a['browser_download_url'] for a in r['assets'] if 'linux-amd64-compatible' in a['name']][0])")
echo "URL: $URL"

echo "=== 2. 下载 ==="
cd /tmp
wget -q --timeout=60 -O mihomo.gz "$URL"
ls -la mihomo.gz

echo "=== 3. 解压安装 ==="
gunzip -f mihomo.gz
chmod +x mihomo
mv mihomo /usr/local/bin/mihomo
/usr/local/bin/mihomo -v 2>&1 | head -3

echo "=== 4. 配置 ==="
mkdir -p /etc/mihomo
python3 -c "
import urllib.request
req=urllib.request.Request('https://short.chaoxing.com/tz/204875623/91c0601486fa11f09bba5c80b6b29854?target=clash',headers={'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'})
open('/etc/mihomo/config.yaml','wb').write(urllib.request.urlopen(req,timeout=30).read())
print('订阅已写入')
"
wc -l /etc/mihomo/config.yaml
echo "=== 安装完成 ==="
