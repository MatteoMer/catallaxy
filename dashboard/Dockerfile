FROM node:22-slim AS build

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

FROM node:22-slim

WORKDIR /app
RUN npm init -y && npm install hono @hono/node-server
COPY --from=build /app/dist ./dist
COPY server.js .

EXPOSE 4000
CMD ["node", "server.js"]
