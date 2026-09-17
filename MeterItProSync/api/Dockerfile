# Build context is the repo root (MeterItProSync/api imports framework/backend/shared)
FROM node:24 AS framework-builder
WORKDIR /build/framework/backend
COPY framework/backend/package*.json ./
RUN npm ci
COPY framework/backend ./
RUN npm run build

FROM node:24 AS builder
WORKDIR /build/MeterItProSync/api
COPY MeterItProSync/api/package*.json ./
COPY --from=framework-builder /build/framework/backend /build/framework/backend
RUN npm ci --legacy-peer-deps
COPY MeterItProSync/api/tsconfig.json ./
COPY MeterItProSync/api/src ./src
RUN npm run build

FROM node:24-slim
WORKDIR /app/MeterItProSync/api
ENV NODE_ENV=production
COPY MeterItProSync/api/package*.json ./
COPY --from=framework-builder /build/framework/backend /app/framework/backend
RUN npm ci --omit=dev --legacy-peer-deps
COPY --from=builder /build/MeterItProSync/api/dist ./dist
EXPOSE 3002
CMD ["node", "dist/MeterItProSync/api/src/server.js"]
