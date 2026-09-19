FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 3001
ENV PORT=3001
ENV NODE_ENV=production
CMD ["node", "server.js"]
