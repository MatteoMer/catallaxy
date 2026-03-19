FROM node:22-slim

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .

EXPOSE 4100
CMD ["npm", "run", "dev"]
