# research-dsh-bundle

DSH 边缘适配目前位于 `../src/dsh/`：运行时、工具、HTTP 路由和可嵌入面板都从主包导出。

在 DSH 配置中安装 `model-search/`，可把 `web_search` 接到当前模型的内置搜索。此配置启用已接入的 Magpie Responses 模型，关闭 DeepSeek 搜索渠道，网页抓取仍用 HTTP。支持的模型列在此包的 `cordis.patch.yml`。侦察员可用 `research_source_capture` 保存模型返回的来源链接。
