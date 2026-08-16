FROM node:22-alpine
WORKDIR /app
COPY remote-runtime/package.json ./
RUN npm install --omit=dev
COPY remote-runtime/src/ ./src/
COPY shared/src/ /shared/src/
RUN ln -s /app/node_modules /shared/node_modules
USER node
CMD ["node", "--experimental-strip-types", "src/main.ts"]
