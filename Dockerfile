FROM node:22-alpine

RUN corepack enable && corepack prepare pnpm@11.19.0 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json vitest.config.ts ./
COPY database ./database
COPY scripts ./scripts
COPY src ./src

RUN pnpm build

ENV NODE_ENV=production
EXPOSE 3000

RUN chmod +x /app/scripts/docker-entrypoint.sh

ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
