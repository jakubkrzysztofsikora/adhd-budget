FROM node:22-alpine AS builder

WORKDIR /app
COPY mcp-server/package*.json ./
RUN npm ci
COPY mcp-server/tsconfig.json ./
COPY mcp-server/src/ src/
RUN npm run build

FROM node:22-alpine

RUN apk add --no-cache ca-certificates wget

WORKDIR /app
COPY mcp-server/package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist

RUN mkdir -p /app/data && chown node:node /app/data

USER node
EXPOSE 8081

CMD ["node", "dist/index.js"]