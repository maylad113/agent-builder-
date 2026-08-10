# ---- build stage ----
FROM node:20-bookworm-slim AS build
WORKDIR /app

# Native build deps for better-sqlite3
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm run build

# ---- runtime stage ----
FROM node:20-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/data/agentfactory.db

# Runtime build of better-sqlite3 native module
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/migrations ./migrations

# Non-root user for the running process
RUN useradd -r -u 1001 -g node appuser \
    && mkdir -p /app/data \
    && chown -R appuser:node /app
USER appuser

VOLUME ["/app/data"]

EXPOSE 3000

# Migrations auto-apply on boot; no separate step needed.
CMD ["node", "dist/server.cjs"]
