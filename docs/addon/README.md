# Pi Ext Addon

`@hheei/pi-ext-addon` 是 Pi host 的可選增強集合，提供獨立、opt-in 的功能擴展。

## 包含功能

1. **Dollar Skill References (`dollar-skill`)**：
   * `$skill-name` 自動補全、輸入展開為 skill 檔案路徑與原子編輯器移動/刪除。
   * 預設關閉（opt-in），配置項位於 `dollar-skill`（相容舊 `pi-dollar-skill`）。
2. **Auto Session Title (`auto-title`)**：
   * 在首個穩定對話輪次後自動生成簡潔會話標題，亦可手動透過 `/auto-title` 觸發。
   * 預設關閉（opt-in），配置項位於 `auto-title`。

## 設定

所有功能均在 `/ext-settings` 中獨立提供設定面板與開關。
每個 Pi session 在 lifecycle cleanup 時清理對應的 hook 與資源。
