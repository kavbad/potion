# Potion server image (SPEC §12.8 HA, ROADMAP #27).
# Builds the full pnpm workspace and runs apps/server (node-pg + redis come
# from DATABASE_URL / REDIS_URL at runtime; see docker-compose.ha.yml).
FROM node:20-slim AS build
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app
COPY . .
# Build in RUNTIME-dependency order, not pnpm's dev-inclusive order: the Lab
# packages devDepend on the server for their tests, which makes `pnpm -r build`
# see a cycle and build lab-dial before its deps exist in a clean tree.
RUN pnpm install --frozen-lockfile && node scripts/build-ordered.mjs

# Runtime: same tree (workspace symlinks resolve in place). NODE_ENV=production
# flips the server out of dev-auth bypass — real sessions/api keys required.
FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
EXPOSE 3000
CMD ["node", "apps/server/dist/index.js"]
