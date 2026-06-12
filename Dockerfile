# ============================================================
# RSSPush API - Docker Image
# 容器启动后运行 node app.js
# ============================================================

FROM node:20-alpine

LABEL org.opencontainers.image.source="https://github.com/OWNER/rsspush"
LABEL org.opencontainers.image.description="RSSPush API - RSS to Notification Service"
LABEL org.opencontainers.image.licenses="MIT"

# 安装 apprise（Python 通知工具，部分推送方式依赖）
RUN apk add --no-cache python3 py3-pip py3-cffi py3-cryptography \
    && pip3 install --break-system-packages apprise \
    && apk del py3-pip

# 创建工作目录
WORKDIR /app

# 先复制依赖文件，利用 Docker 缓存层
COPY package.json package-lock.json ./

# 安装生产依赖（不安装 devDependencies）
RUN npm ci --omit=dev

# 复制应用代码
COPY app.js taskProcessor.js cron.js cron.after.js cron.task-split.js ./
COPY config.yaml.example image.version.txt ./
COPY build/ ./build/

# 创建数据目录
RUN mkdir -p /app/data

# 暴露端口
EXPOSE 8000

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:8000/check || exit 1

# 启动应用
CMD ["node", "app.js"]
