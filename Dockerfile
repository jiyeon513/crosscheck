# One container: the API, the agents and the built web app.
FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production \
    PORT=8787 \
    DATA_DIR=/data
EXPOSE 8787
CMD ["node", "--import", "tsx", "server/index.ts"]
