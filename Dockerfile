FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts

RUN mkdir -p /app/var/data /app/var/keys /app/var/artifacts /app/var/uploads /app/runtime/license /app/runtime/build /app/runtime/worker \
    && chown -R node:node /app

USER node
EXPOSE 8787 8788
CMD ["node", "apps/license-api/src/server.js"]
