# Browser Automation Manual Checklist

## Snapshot

- 验证 `browser_snapshot()` 默认输出 full accessibility tree
- 验证 `interactiveOnly: true` 仅输出交互元素
- 验证 `compact`、`depth`、`scopeRef`、`scopeSelector`、`focused`
- 验证 iframe 一层内联，且 iframe 内 `@ref` 可直接操作

## Interaction

- 验证 `snapshot -> @ref -> click/fill/type/select/check/uncheck/get/is/wait`
- 验证 `newTab` 点击链接会打开 Neovate 内新标签
- 验证 `scroll`、`drag`、`upload` 在真实页面上的行为

## Browser Context

- 验证 tab new/switch/close
- 验证 frame main/ref/selector/match
- 验证 dialog `alert` / `confirm` / `prompt`

## Environment

- 验证 `cookies`、`storage`
- 验证 `set(viewport/device/geo/offline/headers/credentials/media)`
- 验证 `network route` / `unroute` / requests log

## Diagnostics

- 验证 `console` / `errors`
- 验证 `highlight` / `inspect`
- 验证 `screenshot` / `pdf`
