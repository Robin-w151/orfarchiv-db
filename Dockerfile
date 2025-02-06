FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev --ignore-scripts

COPY ./src/backup.js ./src/logger.js ./

ENTRYPOINT ["node", "backup.js"]

CMD ["--keep-running"]
