FROM node:20-alpine
# cache-bust: v1773817231
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p data
EXPOSE 3847
CMD ["node", "server.js"]
