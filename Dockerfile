FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache tini

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY src/      ./src/

RUN mkdir -p /data
ENV DATA_FILE=/data/cmdb_data.json
ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000
VOLUME ["/data"]

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
