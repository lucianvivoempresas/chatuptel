FROM node:22.22.2-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY test ./test

ENV NODE_ENV=production
EXPOSE 3001

CMD ["npm", "start"]
