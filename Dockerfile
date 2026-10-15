# The hosted tracker (hub, Kamal). Node 26; better-sqlite3 is built here, in the image, never on the box.
# Data lives on the volume at /data (accounts/, catalog.db, accounts.db), never in the image.

FROM node:26-slim AS deps
WORKDIR /app
# Toolchain only for the native module; it stays in this stage.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:26-slim
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data
COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js ./
COPY server ./server
COPY public ./public
COPY scripts/switch.js scripts/restore.js scripts/split-backup.js ./scripts/
COPY extension ./extension
# A pure-JS sha1 shared with the Cloudflare build.
COPY worker/sha1.js ./worker/sha1.js
# The volume is owned by the image's node user (uid 1000): chown 1000:1000 /srv/anime-tracker once.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "server.js"]
