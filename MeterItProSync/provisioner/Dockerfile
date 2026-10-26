FROM alpine:3.20

# cloudflared is pinned, not 'latest': the download layer is cached by CI
# (cache-from/to type=gha in docker-publish.yml), so a floating URL froze the
# binary at whatever was current when this file last changed. Bump deliberately;
# the changed URL is also what forces the cache miss.
RUN apk add --no-cache curl ca-certificates \
    && curl -fsSL https://github.com/cloudflare/cloudflared/releases/download/2026.10.3/cloudflared-linux-amd64 \
       -o /usr/local/bin/cloudflared \
    && chmod +x /usr/local/bin/cloudflared

COPY start.sh /start.sh
RUN chmod +x /start.sh

ENTRYPOINT ["/start.sh"]
