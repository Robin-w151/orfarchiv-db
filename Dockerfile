ARG BASE_IMAGE=node:24-alpine

FROM ${BASE_IMAGE} AS builder

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --ignore-scripts

COPY . .

RUN npm run build


FROM ${BASE_IMAGE} AS runner

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/dist/db.js .

RUN mkdir -p /app/backup && chown 1000:1000 /app/backup

VOLUME /app/backup

USER 1000:1000

ENTRYPOINT ["node", "db.js"]

CMD ["backup", "--keep-running"]
