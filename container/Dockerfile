FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install --no-audit --no-fund
COPY src ./src
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
 && npm cache clean --force
COPY --from=build /app/dist ./dist

# Mode selected at runtime via T4T_MODE=client|provider. See docs/spec.md §7.
EXPOSE 8080
USER node
ENTRYPOINT ["node", "dist/index.js"]
