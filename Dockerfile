# Viomocoin — pinned to Node 24 (Active LTS) because the app uses node:sqlite,
# which is only available on Node >= 22.5 and works flagless on 24.
FROM node:24-alpine

WORKDIR /app

# Install production dependencies first (better layer caching).
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# App source.
COPY . .

# Persist the database and uploaded media on a mounted volume, NOT the container
# filesystem (which is wiped on every redeploy). Mount a volume at /data.
ENV NODE_ENV=production \
    VIOMOCOIN_DB=/data/viomocoin.db \
    VIOMOCOIN_UPLOAD_DIR=/data/uploads \
    PORT=5178
VOLUME ["/data"]

EXPOSE 5178

# JWT_SECRET has no default here on purpose — the app refuses to boot in production
# without it. Pass it at runtime:  docker run -e JWT_SECRET=...
CMD ["npm", "start"]
