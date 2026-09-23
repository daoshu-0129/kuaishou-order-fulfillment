FROM node:20-alpine

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . ./

RUN addgroup -S app && adduser -S app -G app && mkdir -p /data && chown -R app:app /app /data
USER app

ENV NODE_ENV=production
ENV DATA_DIR=/data
EXPOSE 3000
VOLUME ["/data"]
CMD ["node", "server.js"]

