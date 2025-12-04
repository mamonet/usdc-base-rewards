# repo: deploy/Dockerfile
# Multi-stage: toolchain (better-sqlite3 needs a compiler) stays in the builder, the
# runtime image ships prod deps + dist only and runs as a non-root user.

FROM node:20-bookworm-slim AS builder
WORKDIR /app

# node-gyp deps for better-sqlite3
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Prune to production deps, keeping the compiled better-sqlite3 binding.
RUN npm prune --omit=dev


FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations

# Writable only where it needs to be. No secrets are baked in: the treasury key reference,
# webhook secret and provider keys all arrive as env at run time.
RUN mkdir -p /app/data && chown -R node:node /app/data

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
