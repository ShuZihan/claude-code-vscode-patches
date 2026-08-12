# New API 余额适配研究

研究对象：[`QuantumNous/new-api`](https://github.com/QuantumNous/new-api)，基准提交 [`3d5dc36`](https://github.com/QuantumNous/new-api/commit/3d5dc36f1d85ccae8d5cb2864764011795b559b5)（2026-08-11）。本文只使用官方仓库和官方文档。

## 结论

可以从 Claude Code 的供应商配置中取得 Base URL 和 API Key，然后自动完成：

1. 请求免鉴权的 `GET <base>/api/status`，取得站点名称和额度显示规则。
2. 请求 `GET <base>/api/usage/token/`，取得该 API Key 的原始 quota。
3. 按站点声明的 `quota_display_type` 换算并显示余额。

其中 `/api/status` 的 `data.system_name` 是站点名称；`/api/usage/token/` 的 `data.name` 是 **API Key 名称**，不能用作站点名称。

## 1. `GET /api/usage/token/`

当前路由位于公开 API 组下，但使用只读 Token 鉴权，并启用 CORS 与 CriticalRateLimit：[路由源码](https://github.com/QuantumNous/new-api/blob/3d5dc36f1d85ccae8d5cb2864764011795b559b5/router/api-router.go#L251-L258)。

请求：

```http
GET /api/usage/token/
Authorization: Bearer sk-...
```

控制器要求 `Authorization` 恰好解析为 `Bearer <token>`；`Bearer` 大小写不敏感，`sk-` 前缀会被移除后查库：[控制器源码](https://github.com/QuantumNous/new-api/blob/3d5dc36f1d85ccae8d5cb2864764011795b559b5/controller/token.go#L215-L240)。

当前成功响应：

```json
{
  "code": true,
  "message": "ok",
  "data": {
    "object": "token_usage",
    "name": "API Key name",
    "total_granted": 1000000,
    "total_used": 250000,
    "total_available": 750000,
    "unlimited_quota": false,
    "model_limits": {},
    "model_limits_enabled": false,
    "expires_at": 0
  }
}
```

字段直接来自当前控制器：[响应源码](https://github.com/QuantumNous/new-api/blob/3d5dc36f1d85ccae8d5cb2864764011795b559b5/controller/token.go#L247-L261)。

- `total_granted = remain_quota + used_quota`
- `total_used = used_quota`
- `total_available = remain_quota`
- `name` 是 Token/API Key 名称
- `expires_at = 0` 表示原始过期值为 `-1`，即没有有限过期时间
- `unlimited_quota = true` 时应显示“无限”，不要把 `total_available` 当成有限金额

当前只读鉴权允许已过期、已耗尽或已禁用的 Key 查询自身信息，但仍拒绝被封禁用户：[鉴权源码](https://github.com/QuantumNous/new-api/blob/3d5dc36f1d85ccae8d5cb2864764011795b559b5/middleware/auth.go#L275-L323)。

## 2. `GET /api/status`

`GET /api/status` 没有鉴权中间件，是官方公开端点：[路由源码](https://github.com/QuantumNous/new-api/blob/3d5dc36f1d85ccae8d5cb2864764011795b559b5/router/api-router.go#L14-L24)。响应结构为：

```json
{
  "success": true,
  "message": "",
  "data": {
    "version": "...",
    "system_name": "站点名称",
    "quota_per_unit": 500000,
    "display_in_currency": true,
    "quota_display_type": "CNY",
    "usd_exchange_rate": 7.3,
    "custom_currency_symbol": "¤",
    "custom_currency_exchange_rate": 1
  }
}
```

与本适配有关的当前字段见 [GetStatus 源码](https://github.com/QuantumNous/new-api/blob/3d5dc36f1d85ccae8d5cb2864764011795b559b5/controller/misc.go#L53-L99)：

| 字段 | 含义 |
| --- | --- |
| `system_name` | 管理员配置的站点名称；默认值是 `New API` |
| `version` | 构建版本，可辅助识别和兼容判断 |
| `quota_per_unit` | 多少 quota 等于 1 系统 USD；当前默认 `500000` |
| `quota_display_type` | 当前展示类型：`USD`、`CNY`、`TOKENS` 或 `CUSTOM` |
| `display_in_currency` | 旧前端兼容字段；只表示“货币/非货币”，不足以判断具体币种 |
| `usd_exchange_rate` | 1 USD 对应多少 CNY，仅用于 `CNY` 展示类型 |
| `custom_currency_symbol` | 自定义币种符号 |
| `custom_currency_exchange_rate` | 1 USD 对应多少自定义币种 |

官方定义的四种显示类型和汇率选择见 [general_setting.go](https://github.com/QuantumNous/new-api/blob/3d5dc36f1d85ccae8d5cb2864764011795b559b5/setting/operation_setting/general_setting.go#L5-L22) 与 [汇率选择逻辑](https://github.com/QuantumNous/new-api/blob/3d5dc36f1d85ccae8d5cb2864764011795b559b5/setting/operation_setting/general_setting.go#L59-L90)。

## 3. quota 换算

设 `Q = total_available`，`U = quota_per_unit`。

```text
USD = Q / U
```

再按 `quota_display_type`：

| 类型 | 显示值 |
| --- | --- |
| `USD` | `$ (Q / U)` |
| `CNY` | `¥ (Q / U × usd_exchange_rate)` |
| `CUSTOM` | `<custom_currency_symbol> (Q / U × custom_currency_exchange_rate)` |
| `TOKENS` | 原始 `Q`，不换算成货币 |

因此用户提出的公式在 `quota_display_type === "CNY"` 时完全正确：

```text
可用 CNY = total_available ÷ quota_per_unit × usd_exchange_rate
```

官方前端同样先以 `quota / quota_per_unit` 得到 USD，再按显示币种乘汇率：[formatQuotaWithCurrency](https://github.com/QuantumNous/new-api/blob/3d5dc36f1d85ccae8d5cb2864764011795b559b5/web/src/lib/currency.ts#L488-L524)、[formatCurrencyFromUSD](https://github.com/QuantumNous/new-api/blob/3d5dc36f1d85ccae8d5cb2864764011795b559b5/web/src/lib/currency.ts#L408-L439)。官方文档也将 quota 定义为内部计费点数：[倍率设置文档](https://docs.newapi.pro/en/docs/guide/console/settings/rate-settings)。

### 重要边界

这里得到的是“站点按管理员配置折算后的可用额度”，并不等同于可提现现金、充值余额或支付网关余额。尤其是 `usd_exchange_rate` 是展示换算率；充值价格还存在独立的 `price` 配置，不能混用。

## 4. 版本兼容

- `GET /api/token/usage` 于 2025-04-29 加入：[初始提交](https://github.com/QuantumNous/new-api/commit/9dc153eda12fe4b01c096fb056d44aa7bcd61aa0)。
- 2025-08-23 路由迁移为当前的 `GET /api/usage/token/`，并改为 Token 鉴权：[迁移提交](https://github.com/QuantumNous/new-api/commit/94e7f103677385710d27ad889b94f51b83f294c6)。
- `usd_exchange_rate` 于 2025-07-17 加入，当时明确用于 pricing：[提交](https://github.com/QuantumNous/new-api/commit/9f957da5ac36f352be8c46fc6a28ab7474c325d0)。
- `quota_display_type` 于 2025-09-29 加入，同时保留 `display_in_currency` 兼容旧前端：[提交](https://github.com/QuantumNous/new-api/commit/8294a76bc2f5a8193d639a0c7ef79cc97eb62569)。
- 旧版没有 `quota_display_type` 时，`display_in_currency=true` 的余额展示是 USD，不能因为响应中存在 `usd_exchange_rate` 就推断为 CNY：[旧前端源码](https://github.com/QuantumNous/new-api/blob/41ea93883b89d17122a1022b3ff9d6507368b954/web/src/helpers/render.jsx#L899-L916)。

兼容策略：

1. 优先使用合法的 `quota_display_type`。
2. 缺失时，`display_in_currency === false` 视为 `TOKENS`；`true` 视为 `USD`。
3. `quota_per_unit` 缺失或非正数时，才回退到 `500000`，同时标记结果为估算值。
4. 新路由 404 时可选尝试旧的 `/api/token/usage`；旧响应字段可能包含 `id`，当前响应不再保证该字段。

## 5. 自动识别与站点名称

推荐两阶段识别：

1. 从 Claude Code 当前供应商配置读取 Base URL，规范化掉末尾 `/v1` 后请求 `/api/status`。若 `success === true`，将非空 `data.system_name` 作为 UI 站点名；否则回退到主机名。
2. 使用同一配置的 API Key 请求 `/api/usage/token/`。仅当 `code === true` 且 `data.object === "token_usage"` 时，启用 New API 余额适配。

`/api/status` 无法在无鉴权条件下提供绝对可靠的产品身份：New API 允许自定义 `system_name`，One API 派生项目或私有 fork 也能返回相似结构。官方没有公开的不可伪造 `product_id` 字段。因此内部供应商类型宜命名为 `new-api-compatible`；`/api/status` 负责候选识别与站点名称，鉴权后的 token usage 响应用于强确认。

安全要求：API Key 只应由 VSCode 扩展宿主发起请求，不能传入 Webview、日志、错误信息或持久化余额缓存。
