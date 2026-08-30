#!/bin/bash
# 写 supervisor 配置
cat > /etc/supervisor/conf.d/nginx.conf << 'EOF'
[program:nginx]
command=nginx -g 'daemon off;'
priority=10
autostart=true
autorestart=true
startretries=5
redirect_stderr=true
stdout_logfile=/tmp/nginx.log
EOF

cat > /etc/supervisor/conf.d/pipeline_wrapper.conf << 'EOF'
[program:pipeline_wrapper]
command=/root/miniconda3/bin/python /root/pipeline_wrapper.py
priority=20
autostart=true
autorestart=true
startretries=5
redirect_stderr=true
stdout_logfile=/tmp/wrap.log
EOF

# 杀掉手动启动的实例（端口释放后 supervisor 会自动拉起）
pkill -f 'nginx: master' 2>/dev/null
pkill -f 'pipeline_wrapper' 2>/dev/null
sleep 3

# 通知 supervisor 加载新配置
supervisorctl -c /usr/supervisor/supervisord.conf reread
supervisorctl -c /usr/supervisor/supervisord.conf update
sleep 3
supervisorctl -c /usr/supervisor/supervisord.conf status
