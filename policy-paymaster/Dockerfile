FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
EXPOSE 3100
# Node 24 runs TypeScript directly (type stripping).
CMD ["node", "src/index.ts"]
