FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/
RUN pnpm install --filter @cirofy/api... --frozen-lockfile=false
COPY packages/shared ./packages/shared
COPY tsconfig.base.json ./
COPY apps/api ./apps/api
WORKDIR /app/packages/shared
RUN pnpm build
WORKDIR /app/apps/api
RUN pnpm prisma:generate
RUN pnpm build
ENV NODE_ENV=production
EXPOSE 4000
CMD ["sh", "-c", "pnpm prisma db push --accept-data-loss; node dist/main.js"]
