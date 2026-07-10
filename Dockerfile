# Open ArchiCAD — マルチステージビルド
# 1. ビルド: Vite で静的ファイルを生成
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN npm run build

# 2. 配信: nginx で静的配信のみ(実行時のサーバー計算ゼロ)
FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
