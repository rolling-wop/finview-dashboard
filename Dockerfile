FROM node:20-alpine
# cache-bust: v1773817231
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
# Force full copy every time by copying a timestamp file
COPY . .
RUN mkdir -p data && echo "built-at: $(date)" > /app/build-info.txt
EXPOSE 3847
CMD ["node", "server.js"]
