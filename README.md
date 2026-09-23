# 快手订单发货助手

一个可自行部署的快手店铺订单履约工作台：在店铺授权后同步订单、导出 CSV、导入物流单号，并将发货信息回传至快手电商开放平台。

> 此仓库不保存快手 `AppSecret`、访问令牌、订单数据库或真实买家信息。所有密钥均通过部署环境变量配置。

## 已实现

- 管理员密码登录、HTTP-only 会话 Cookie、登录限流及基础安全响应头。
- AES-256-GCM 加密保存店铺访问令牌；加密密钥只存在服务器环境变量中。
- 待发货订单列表与已选订单 CSV 导出（包含公式注入防护）。
- 物流 CSV 导入与导入前字段校验；将已校验的发货单批量提交给平台。
- 快手 OAuth 授权入口与回调骨架；订单、发货请求统一由服务端发起。
- 不含真实个人信息的演示订单，便于上线前验收界面和导出流程。
- Docker 部署文件，适用于具备持久化磁盘的云服务器/容器平台。

备案通过后请使用 [DEPLOYMENT.md](DEPLOYMENT.md) 配置阿里云 ECS、DNS、HTTPS 和 Docker。备案号通过 `ICP_BEIAN_NUMBER` 环境变量显示在网站页脚；该值不属于密钥，可以安全填写在服务器环境变量中。

## 本地启动

需要 Node.js 20+。

```bash
cp .env.example .env
npm install
npm run dev
```

浏览器访问 `http://localhost:3000`。先在 `.env` 中设置 `ADMIN_PASSWORD`、`SESSION_SECRET` 以及 `TOKEN_ENCRYPTION_KEY`；未配置密码时无法登录。

生成令牌加密密钥：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## 快手电商开放平台接入

完成应用审核后，在部署平台的**环境变量**中设置下列值，绝不要提交到 Git：

| 变量 | 用途 |
| --- | --- |
| `KUAISHOU_APP_KEY`、`KUAISHOU_APP_SECRET` | 通过审核的应用凭据 |
| `KUAISHOU_REDIRECT_URI` | 与开放平台登记信息完全一致的 HTTPS 回调地址。本项目的生产地址为 `https://zhenggaoxiang.cn/api/kuaishou/callback` |
| `KUAISHOU_OAUTH_AUTHORIZE_URL`、`KUAISHOU_OAUTH_TOKEN_URL` | 当前应用类型对应的 OAuth 授权与换取令牌地址 |
| `KUAISHOU_ORDER_LIST_URL` | 已获批的订单查询接口地址 |
| `KUAISHOU_SHIPMENT_SUBMIT_URL` | 已获批的发货回传接口地址 |

应用获批后，请以快手电商开放平台控制台显示的**当前接口文档**为准，核对 OAuth 参数名、订单字段、签名方式和物流公司编码。`server.js` 中的 `tokenExchange` 和 `platformRequest` 是唯一的协议适配位置；不要在浏览器端调用接口或暴露 `AppSecret`。

## 上线建议

1. 代码放在当前私有 GitHub 仓库；应用部署到有持久化磁盘、HTTPS 和可绑定域名的后端服务，而不是 GitHub Pages。生产网站地址为 `https://zhenggaoxiang.cn`。
2. 国内主体使用已备案域名，并将生产域名、回调地址和登记表中的网站地址保持一致。
3. 将 `DEMO_MODE` 改为 `false`，强密码/会话密钥/令牌加密密钥全部替换为随机值。
4. 先用快手提供的测试店铺或小批量订单验证“查询 → 导出 → 导入单号 → 回传”闭环，再开启实际发货。
5. 根据业务合规要求配置访问控制、日志保留周期和订单数据删除策略。

## CSV 模板

导入物流信息时，第一行必须包含：

```csv
orderNo,carrierCode,trackingNo
KS202609230001,YTO,YT123456789
```

`carrierCode` 必须使用快手接口认可的物流公司编码。

