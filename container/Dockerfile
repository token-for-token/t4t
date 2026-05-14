FROM node:20-bookworm-slim AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json tsconfig.json build.mjs ./
RUN npm install --no-audit --no-fund
COPY src ./src
RUN npm run build \
 && npm prune --omit=dev

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Pre-create the data dir owned by `node` so a mounted named volume inherits
# the right ownership (Docker copies image-level mount-point ownership/contents
# into a fresh volume on first mount).
RUN mkdir -p /data && chown node:node /data

# Mode selected at runtime via T4T_MODE=client|provider. See docs/spec.md §7.
EXPOSE 8080
USER node
ENTRYPOINT ["node", "dist/index.js"]
