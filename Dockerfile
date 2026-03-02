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
#   openssh-client  → ssh binary spawned by node-pty
#   sshpass         → auto password auth (no interactive prompt)
#   libstdc++       → required by node-pty native .node module
#   libgcc          → required by node-pty native .node module
RUN apk add --no-cache openssh-client sshpass libstdc++ libgcc

# Copy compiled node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy application files
COPY server.js   ./
COPY src/        ./src/

# Create known_hosts dir so ssh doesn't fail on first connect
RUN mkdir -p /root/.ssh && chmod 700 /root/.ssh

# Persistent data mount
RUN mkdir -p /data
ENV DATA_FILE=/data/cmdb_data.json
ENV PORT=3000
ENV HOME=/root
ENV NODE_ENV=production

EXPOSE 3000
VOLUME ["/data"]

CMD ["node", "server.js"]
