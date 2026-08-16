FROM node:22-alpine
RUN apk add --no-cache docker-cli
WORKDIR /app
COPY attestor/package.json ./
RUN npm install --omit=dev
COPY attestor/src/ ./src/
COPY shared/src/ /shared/src/
RUN ln -s /app/node_modules /shared/node_modules
USER node
CMD ["node", "--experimental-strip-types", "src/main.ts"]
