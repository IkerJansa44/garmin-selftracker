FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json /app/
RUN npm ci

COPY . /app

EXPOSE 5180

CMD ["npm", "run", "dev"]
