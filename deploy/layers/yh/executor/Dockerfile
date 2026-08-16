FROM node:22-alpine
WORKDIR /app
COPY src/executor.js /app/executor.js
RUN chmod 0555 /app/executor.js
USER node
ENTRYPOINT ["node", "/app/executor.js"]
