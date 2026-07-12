# Nginx 配置

## 基本反向代理

```nginx
server {
    listen 80;
    server_name fwp.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

## HTTPS 配置

### 使用 Let's Encrypt

```bash
# 安装 certbot
sudo apt install certbot python3-certbot-nginx

# 获取证书
sudo certbot --nginx -d fwp.example.com
```

### 手动配置 HTTPS

```nginx
server {
    listen 80;
    server_name fwp.example.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name fwp.example.com;

    ssl_certificate /etc/letsencrypt/live/fwp.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/fwp.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

## SSE 流式响应配置

AI API 的流式响应需要特殊配置：

```nginx
location /v1/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
    chunked_transfer_encoding on;
}
```

## 部署 Nginx 配置

```bash
# 复制配置文件
sudo cp fwp.conf /etc/nginx/sites-available/fwp

# 启用站点
sudo ln -s /etc/nginx/sites-available/fwp /etc/nginx/sites-enabled/

# 测试配置
sudo nginx -t

# 重载 Nginx
sudo systemctl reload nginx
```

## 下一步

