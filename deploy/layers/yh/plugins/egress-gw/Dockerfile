FROM node:22-alpine
WORKDIR /app
COPY egress-gw/package.json ./
RUN npm install --omit=dev
COPY egress-gw/src/ ./src/
COPY shared/src/ /shared/src/
RUN ln -s /app/node_modules /shared/node_modules
USER node
CMD ["node", "--experimental-strip-types", "src/main.ts"]
