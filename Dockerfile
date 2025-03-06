FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev --ignore-scripts

COPY ./src/backup.ts ./src/logger.ts ./

ENTRYPOINT ["node", "--experimental-strip-types", "backup.ts"]

CMD ["--keep-running"]
