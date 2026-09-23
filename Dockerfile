ARG CADDY_IMAGE=caddy:2.10
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${CADDY_IMAGE} AS caddy
FROM ${NODE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production
COPY --from=caddy /usr/bin/caddy /tmp/caddy
# Copy bytes into a fresh inode: do not retain upstream file capabilities.
# Caddy listens on high ports and must run with the container's empty capability set.
RUN cat /tmp/caddy > /usr/bin/caddy && chmod 0755 /usr/bin/caddy && rm /tmp/caddy
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
