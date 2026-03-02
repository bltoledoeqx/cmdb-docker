# ─── Build stage ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# node-pty requires python3 + make + g++ to compile native addon
RUN apk add --no-cache python3 make g++

COPY package.json ./
RUN npm install --omit=dev

# ─── Runtime stage ────────────────────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# Runtime tools:
#   openssh-client  → ssh binary for node-pty to spawn
#   sshpass         → passwordless SSH auth
RUN apk add --no-cache openssh-client sshpass

# Copy compiled node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy application
COPY server.js   ./
COPY src/        ./src/

# Persistent data volume mount point
RUN mkdir -p /data
ENV DATA_FILE=/data/cmdb_data.json
ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

VOLUME ["/data"]

CMD ["node", "server.js"]
