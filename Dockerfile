FROM node:20-alpine
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
RUN mkdir -p /data
ENV PORT=3000
ENV TZ=Europe/Madrid
ENV DB_PATH=/data/control_horario.db
EXPOSE 3000
CMD ["node", "server.js"]