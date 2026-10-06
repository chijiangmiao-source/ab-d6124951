# 宏卫生复核：零第三方依赖，Node 20 内置 HTTP / test / fetch
FROM node:20-alpine

WORKDIR /app

# 先拷清单以利用层缓存；本项目无第三方依赖
COPY package.json ./
COPY src ./src
COPY public ./public
COPY test ./test
COPY scripts ./scripts

# 构建期即可产出 dist/ 作为页面构建证据
RUN node src/build.js

EXPOSE 8080
CMD ["node", "src/server.js"]
