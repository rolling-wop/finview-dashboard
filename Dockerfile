FROM node:20-alpine
# cache-bust: 1793110034
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p data
EXPOSE 8080
CMD ["node", "server.js"]
