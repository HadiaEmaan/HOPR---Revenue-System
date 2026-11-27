FROM node:24-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=7860 \
    PMS_DB_PATH=/data/clinic.sqlite

WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --chown=node:node . .

USER root
RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 7860
CMD ["npm", "start"]
