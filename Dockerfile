FROM caddy:2.10 AS caddy
FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=caddy /usr/bin/caddy /usr/bin/caddy
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json Caddyfile ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
RUN mkdir -p /app/var/data /app/var/keys /app/var/artifacts /app/var/uploads \
    /app/runtime/license /app/runtime/build /app/runtime/worker /app/runtime/caddy-data /app/runtime/caddy-config \
    && chown -R node:node /app
USER node
EXPOSE 8080 8443 8443/udp
CMD ["node", "scripts/docker/start.js"]
