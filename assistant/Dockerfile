FROM node:22.22.2-bookworm-slim

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY test ./test

RUN mkdir -p /data && chown node:node /data

ENV NODE_ENV=production
USER node
EXPOSE 3002

CMD ["node", "src/server.js"]
