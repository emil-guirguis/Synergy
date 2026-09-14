FROM node:24 AS builder
WORKDIR /build/MeterItProSync/mcp
COPY MeterItProSync/mcp/package*.json ./
COPY framework /build/framework
RUN npm ci --legacy-peer-deps
COPY MeterItProSync/mcp/tsconfig.json ./
COPY MeterItProSync/mcp/src ./src
COPY MeterItProSync/mcp/migrations ./migrations
RUN npm run build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY MeterItProSync/mcp/package*.json ./
COPY framework /framework
RUN npm ci --omit=dev --legacy-peer-deps
COPY --from=builder /build/MeterItProSync/mcp/dist ./dist
COPY --from=builder /build/MeterItProSync/mcp/migrations ./migrations
# MCP HTTP port (internal, used by sync-api for meter connectivity checks)
EXPOSE 3003
CMD ["node", "dist/MeterItProSync/mcp/src/index.js"]
