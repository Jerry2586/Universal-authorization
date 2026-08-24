FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@11.19.0 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json ./web/package.json
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json vitest.config.ts ./
COPY database ./database
COPY scripts ./scripts
COPY src ./src
COPY web ./web

RUN pnpm build:all

FROM node:22-alpine AS runner
RUN corepack enable && corepack prepare pnpm@11.19.0 --activate
WORKDIR /app

COPY --from=builder /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/web/package.json ./web/package.json
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY --from=builder /app/database ./database
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/src ./src
COPY --from=builder /app/tsconfig.json ./tsconfig.json

ENV NODE_ENV=production
EXPOSE 3000
RUN chmod +x /app/scripts/docker-entrypoint.sh
ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
