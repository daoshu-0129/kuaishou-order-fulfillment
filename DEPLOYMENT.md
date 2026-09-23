# 备案通过后的部署步骤

本项目会在 `zhenggaoxiang.cn` 自动申请 HTTPS 证书。请务必先等 ICP 备案成功，再执行域名解析和启动 Web 服务。

## 1. 阿里云控制台

1. 在 ECS 安全组的**入方向**添加：TCP `80`，来源 `0.0.0.0/0`；TCP `443`，来源 `0.0.0.0/0`。
2. SSH `22` 只允许你的固定公网 IP；使用阿里云 Workbench 时，按控制台提示放通 Workbench 的来源地址。不要把应用端口 `3000` 开放到公网。
3. 备案成功后，在云解析 DNS 添加 A 记录：主机记录 `@`，记录值为 ECS 公网 IPv4；如需 `www`，再添加 CNAME `www` 指向 `zhenggaoxiang.cn`。

## 2. 连接并准备服务器

在 ECS 控制台点击实例的“连接”，通过 Workbench 登录。你购买页选择的是 **Alibaba Cloud Linux 3**；如实际系统不同，请先执行 `cat /etc/os-release` 再停止并告诉我，不要混用包管理命令。

```bash
sudo dnf -y install git wget
sudo wget -O /etc/yum.repos.d/docker-ce.repo http://mirrors.cloud.aliyuncs.com/docker-ce/linux/centos/docker-ce.repo
sudo sed -i 's|https://mirrors.aliyun.com|http://mirrors.cloud.aliyuncs.com|g' /etc/yum.repos.d/docker-ce.repo
sudo dnf -y install dnf-plugin-releasever-adapter --repo alinux3-plus
sudo dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker $USER
exit
```

重新通过 Workbench 登录后，先确认 Docker 已安装，然后执行：

```bash
docker compose version
git clone https://github.com/daoshu-0129/kuaishou-order-fulfillment.git
cd kuaishou-order-fulfillment
cp .env.example .env
nano .env
```

在 `.env` 中至少替换 `ADMIN_PASSWORD`、`SESSION_SECRET` 和 `TOKEN_ENCRYPTION_KEY`。部署生产环境前将 `DEMO_MODE` 改为 `false`；获得备案号后设置 `ICP_BEIAN_NUMBER`。

```bash
docker compose up --build -d
docker compose ps
docker compose logs -f --tail=100
```

`docker compose` 会让 Caddy 监听 80/443，自动申请 HTTPS 证书；Node 应用仅在 Docker 内部端口 `3000` 运行。

## 3. 快手审核通过后

在服务器 `.env` 中填写 `KUAISHOU_*` 变量并重启：

```bash
docker compose up -d
```

订单查询、发货回传的请求参数和签名方式必须以快手电商开放平台审核后的当前接口文档为准；只在 `server.js` 的服务端适配，绝不放入浏览器端代码或 Git 仓库。

