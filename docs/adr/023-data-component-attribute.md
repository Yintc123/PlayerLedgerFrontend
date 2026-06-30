# ADR 023 - 共用元件統一標註 `data-component`（devtools / DOM 定位）

## 狀態

已採用（v1，2026-06-30）

## 背景

開發 / 維運時常需要「這個 DOM 節點是哪個 React 元件畫的？」的答案：

- **dev 互動定位**：[React DevTools](https://react.dev/learn/react-developer-tools) 的 Components 分頁已能由 DOM 反查 owner 元件（PascalCase 名稱），這是最佳工具、零程式碼。
- **原生 Elements 面板 / production / `document.querySelector`**：上述工具不涵蓋——production build 的元件名會被 minify，且不一定每個人都開 React DevTools。E2E、線上問題重現、埋點對位時，需要一個**穩定、可被 CSS selector 命中、且在所有環境保留**的識別碼。

既有的 `data-slot`（shadcn 慣例，見 [ADR 021](./021-tailwind-v4-shadcn-ui.md)）標的是「元件內部的部位角色」（如 `card-header` / `dropdown-menu-content`），不是「元件身分」，兩者用途不同、不互斥。

## 決策

**`src/components/**` 下每個 export 且渲染 DOM 的 component（含複合元件的每個 sub-component），在其最外層 DOM 節點加上 `data-component="<自身元件名>"`。**

### 規則

1. **值 = 該元件 export 的 PascalCase 名稱**，不是檔名。例：`export-button.tsx` 的 `ExportButton` → `data-component="ExportButton"`；`status-tag.tsx` 的 `TopupStatusTag` → `data-component="TopupStatusTag"`。
2. **掛在「最外層 DOM 節點」**，且**置於 `data-slot` 之後、`{...props}` 之前**，沿用 `data-slot` 的可覆寫慣例——呼叫端若傳入自己的 `data-component` 可覆蓋（外層元件身分優先，例如 `<Button data-component="ExportButton">` 最終呈現 `ExportButton`）。
3. **全環境保留**（dev + production）。這是識別碼不是 debug-only，不做 build-time strip。
4. **複合 primitive（Radix kit）逐 sub-component 標自身名**：`DropdownMenuTrigger` / `DropdownMenuContent` / `DropdownMenuItem`… 每個有 DOM 的 sub-component 各自掛 `data-component="<該 sub-component 名>"`，與其 `data-slot`（部位名）並存。唯 Radix 的 **Root / Portal / Sub**（`DropdownMenu` / `DropdownMenuPortal` / `DropdownMenuSub` / `Popover`）為純 context、**不渲染任何 DOM 節點**（其 `data-slot` 亦為 no-op），無 DOM 可掛，維持現狀——這與規則 5 的「我方 provider 包 wrapper」不同：Radix Root/Portal/Sub 的 children 帶位置 / portal 語義，硬包 wrapper 會破壞其組合契約或產生空節點。
5. **無自有 DOM 的元件包 `display:contents` wrapper**：純邏輯 / context provider（原回傳 Fragment / `children`，無自有節點）包一層 `<div className="contents">` 承載 `data-component`。`display:contents` 不產生 box、零佈局影響，故仍視為「最外層節點」。例 `IdleTimerProvider`。（**無豁免**：`src/components/**` 下每個 export 的元件都帶 `data-component`。）
6. **不逐元件寫測試**：`data-component` 與 `data-slot` 同屬靜態標記、非行為；沿用 `data-slot` 既有慣例（不為每個 primitive 寫專屬測試），改由本 ADR 約束，避免測試與標記 1:1 膨脹。E2E 若依賴某 selector，則在該 E2E 案中自然涵蓋。

### 範圍（v1 落地）

`src/components/**` 共 16 檔、**36 個 `data-component` 標記**（每個有 DOM 的 export 一個；ui 複合元件含全部 sub-component）：

| 檔案 | `data-component` |
|------|------------------|
| `ui/button.tsx` | `Button` |
| `ui/input.tsx` | `Input` |
| `ui/label.tsx` | `Label` |
| `ui/card.tsx` | `Card` + `CardHeader` / `CardTitle` / `CardDescription` / `CardContent` / `CardFooter`（6） |
| `ui/alert.tsx` | `Alert` + `AlertTitle` / `AlertDescription`（3） |
| `ui/dropdown-menu.tsx` | 12 個 DOM sub-component（`DropdownMenuTrigger` / `Content` / `Group` / `Item` / `CheckboxItem` / `RadioGroup` / `RadioItem` / `Label` / `Separator` / `Shortcut` / `SubTrigger` / `SubContent`）；Root / Portal / Sub 無 DOM 不標 |
| `ui/popover.tsx` | `PopoverTrigger` / `PopoverContent` / `PopoverAnchor`（3）；Root 無 DOM 不標 |
| `topups/date-range-picker.tsx` | `DateRangePicker` |
| `topups/export-button.tsx` | `ExportButton` |
| `topups/multi-select.tsx` | `MultiSelect`（掛 trigger button；root 為無 DOM 的 `Popover`） |
| `topups/pagination.tsx` | `Pagination` |
| `topups/sort-select.tsx` | `SortSelect` |
| `topups/status-tag.tsx` | `TopupStatusTag` |
| `players/status-tag.tsx` | `PlayerStatusTag` |
| `idle-warning-modal.tsx` | `IdleWarningModal`（掛 overlay 外層；`countdownSec===undefined` 時 render null） |
| `idle-timer-provider.tsx` | `IdleTimerProvider`（包 `<div className="contents">` wrapper；無自有 DOM） |

**無 DOM 不標的 4 個 export**（純 Radix context，其 `data-slot` 亦 no-op）：`DropdownMenu`(Root)、`DropdownMenuPortal`、`DropdownMenuSub`、`Popover`(Root)。

> 頁面級 `src/app/**/_components/*`（filter-bar / result-table 等）**本次未納入**；本 ADR 確立慣例後，依此規則漸進補上、新元件建立時一併加。

## 影響範圍

| 檔案 | 變更 |
|------|------|
| `src/components/**`（16 檔 / 36 標記，見上表） | 每個有 DOM 的 export 加 `data-component` |
| `docs/adr/021-tailwind-v4-shadcn-ui.md` | §強制要求新增第 10 條，cross-ref 本 ADR |

## 後果

- ✅ Elements 面板 / production / `querySelector` 皆可穩定定位元件；E2E selector 不依賴 minify 後的 class。
- ✅ 與 `data-slot` 正交：`data-slot` 答「哪個部位」、`data-component` 答「哪個元件」。
- ⚠️ 屬人工慣例，可能漂移；以本 ADR + code review 約束（暫不加 ESLint 規則，待頁面級全面套用後再評估自動化）。
- ⚠️ 標記隨 DOM 出貨（每節點數十 bytes）；對 CMS 場景的 bundle / DOM size 影響可忽略。

## 參考

- [React DevTools](https://react.dev/learn/react-developer-tools)（dev 互動定位的首選，與本 ADR 互補）
- [ADR 021 - Tailwind v4 + shadcn/ui](./021-tailwind-v4-shadcn-ui.md)（`data-slot` 慣例來源）
