# Nginx Configuration

## Basic Reverse Proxy

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

## HTTPS Setup

### Using Let's Encrypt

```bash
# Install certbot
sudo apt install certbot python3-certbot-nginx

# Get certificate
sudo certbot --nginx -d fwp.example.com
```

### Manual HTTPS

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

## SSE Streaming

AI API streaming responses require special configuration:

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

## Apply Configuration

```bash
# Copy config
sudo cp fwp.conf /etc/nginx/sites-available/fwp

# Enable site
sudo ln -s /etc/nginx/sites-available/fwp /etc/nginx/sites-enabled/

# Test config
sudo nginx -t

# Reload Nginx
sudo systemctl reload nginx
```

## Next Steps

- [Docker](/en/deployment/docker) — Container deployment
- [Environment](/en/deployment/env) — Configuration options
