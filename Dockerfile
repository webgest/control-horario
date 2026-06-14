FROM node:20-alpine

# Dependencias de sistema para better-sqlite3 + tzdata para zonas horarias
RUN apk add --no-cache python3 make g++ tzdata

WORKDIR /app

# Instalar dependencias
COPY package*.json ./
RUN npm install --production

# Copiar código fuente
COPY . .

# Crear directorio para la base de datos
RUN mkdir -p /data

# Variables de entorno por defecto
ENV PORT=3000
ENV TZ=Europe/Madrid
ENV DB_PATH=/data/control_horario.db

EXPOSE 3000

CMD ["node", "server.js"]
