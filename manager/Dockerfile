FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY src ./src
COPY public ./public

ENV PORT=9400 \
    DATA_DIR=/app/data

EXPOSE 9400
# --experimental-sqlite enables the built-in node:sqlite module on
# Node 22 (>= 22.5); on Node 24+ the flag is accepted and unneeded.
CMD ["node", "--experimental-sqlite", "server.js"]
