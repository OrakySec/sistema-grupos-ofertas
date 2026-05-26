FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN npx prisma generate
RUN npm run build
EXPOSE 3001
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
