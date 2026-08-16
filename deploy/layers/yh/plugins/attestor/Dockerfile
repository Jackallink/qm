FROM node:22-alpine
RUN apk add --no-cache docker-cli
WORKDIR /app
COPY package.json ./
COPY src/ ./src/
COPY ../shared/src/ ./shared-src/
RUN mkdir -p /app/shared && cp -r /app/shared-src /app/shared/src && rm -rf /app/shared-src
USER node
CMD ["node", "--experimental-strip-types", "src/main.ts"]
