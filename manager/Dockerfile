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
CMD ["node", "server.js"]
