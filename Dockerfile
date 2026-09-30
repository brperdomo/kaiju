FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY workspaces ./workspaces
ENV KAIJU_PORT=8790 KAIJU_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8790
# The UI is local-only by default; inside a container every request looks remote, so set a password.
# docker run -p 8790:8790 -e KAIJU_UI_PASSWORD=changeme -e KAIJU_TOKEN=secret kaiju
CMD ["node", "src/server.js"]
