# ADR 021 - 採用 Tailwind v4 + shadcn/ui 作為前端 styling 堆疊

## 狀態

已採用（v1，2026-06-28；首次落地於 [/login 頁面改版](../specs/02-auth-session.md#登入頁-ui-設計v1)）

## 背景

v0 的 `/login` 頁面以 inline style 撰寫；spec 01–11 撰寫期間未明文約定全專案的 styling stack。當開始實作 CMS 頁面（[`08`](../specs/08-screen-player-search.md) / [`09`](../specs/09-screen-player-detail.md) / [`10`](../specs/10-screen-topup-list.md) / [`11`](../specs/11-screen-topup-detail.md)）時，必須先敲定一個專案級 styling 系統，否則：

- 元件實作各自選擇技術（CSS Modules / styled-components / Vanilla Extract）→ bundle 膨脹、心智模型不一致
- design token（顏色、陰影、間距、字級）無共用源 → 跨頁面視覺漂移、無法統一改版
- 表單 / Dialog / Combobox / Table 等高互動元件若自零做，TDD 與無障礙成本指數成長

本 ADR 鎖定全專案的 styling 與 component primitive 來源。

## 評估

### 候選方案

| 方案 | 樣式技術 | 元件庫 | 缺點 |
|------|---------|--------|------|
| **A. Tailwind v4 + shadcn/ui**（採用） | utility-first CSS via PostCSS | shadcn/ui（複製到專案，非 npm 依賴） | 初次設定步驟較多；utility class 語法陡學習曲線 |
| B. Tailwind v4 only | utility-first | 自寫 primitive | 5+ 頁面要做 form / select / dialog / table / toast，自寫成本與 a11y 風險高 |
| C. Mantine 或 Chakra UI | runtime CSS-in-JS | 內建完整元件庫 | 客製化到深度後撞包覆層；bundle size 較大；風格距離「現代 CMS」較遠 |
| D. CSS Modules | scoped CSS files | 自寫 primitive | 0 新依賴；但 design token / dark mode / animation / a11y 元件全自建，做出「現代 CMS 風」極困難 |

### 為何挑 A

1. **「當前流行 CMS UI」事實標準**：Vercel、Linear、Supabase、Resend、Cal.com 等指標 dashboard 全採此堆疊；社群範本密集、找解法成本低。
2. **shadcn/ui 是「複製到專案」不是 npm 依賴**：原始碼留在 `src/components/ui/*`，可任意改、不被上游版本綁架、不在依賴樹累積無用元件。
3. **Tailwind v4 取消 `tailwind.config.js`，改 CSS-first**：design token 寫在 `globals.css` 的 `@theme inline` 區塊，靜態解析、編譯期內聯，0 runtime 成本；與 shadcn 的 CSS variable 主題模型完全相容。
4. **OKLCH 色彩空間**：shadcn 預設色票採 OKLCH，色相一致性比 HSL 強，做漸層 / 對比 / dark mode 顏色推導更穩。
5. **a11y 由 Radix Primitives 兜底**：shadcn 內部用 `@radix-ui/react-*`（Label / Slot / Dialog / Popover 等），ARIA、focus management、keyboard 自帶；避免 spec 08–11 §鍵盤與無障礙的測試清單變成空談。
6. **與 Next.js 16 + React 19 相容**：shadcn 已對 React 19 移除 `forwardRef` 依賴；Tailwind v4 的 `@tailwindcss/postcss` plugin 對 Next 16 build pipeline 是 first-class 支援。

### 為何不採 B（Tailwind only）

自寫 Button / Input / Label 可接受，但 Dialog / DropdownMenu / Popover / Combobox 等帶 focus trap / portal / keyboard 的元件，自建至少 ~500 LOC 且 a11y 容易做錯；[`10 §7`](../specs/10-screen-topup-list.md) 匯出 Modal、[`10 §4.4`](../specs/10-screen-topup-list.md) MultiSelect 都會踩到。

### 為何不採 C（Mantine / Chakra）

- 主題客製到「品牌色 + 自家 design token」會撞包覆層；最終仍可能要包一層自家 component，多走一輪。
- Mantine core ≈ 200KB+ gzip 的 bundle size 對 CMS 場景非阻塞，但與 shadcn 的「只帶用到的元件」對比無優勢。
- 視覺風格較 framework-y，與「現代 CMS（Vercel / Linear 風）」距離較遠。

### 為何不採 D（CSS Modules）

design token 系統、dark mode、animation primitive 全要自建；「現代 CMS UI」的視覺含 OKLCH 色票、subtle shadow、focus ring、漸層等，徒手做雖可達成但耗時極高，與 v1 速度要求不符。

## 決策

採方案 A。

### 技術棧

| 角色 | 套件 | 版本 |
|------|------|------|
| CSS engine | `tailwindcss` | `^4` |
| PostCSS plugin | `@tailwindcss/postcss` | `^4` |
| Animation utilities | `tw-animate-css` | latest（Tailwind v4 對應） |
| Variant API | `class-variance-authority` | latest |
| Class combinator | `clsx` + `tailwind-merge` | latest |
| Icon set | `lucide-react` | latest |
| A11y primitives | `@radix-ui/react-label`、`@radix-ui/react-slot`（其他元件按需加） | latest |
| 元件樣板 | shadcn/ui（直接複製檔案，不裝 npm 套件） | — |
| Component 測試 | `jsdom` + `@testing-library/user-event`（既有 `@testing-library/react` + `@testing-library/jest-dom`） | latest |

### 檔案配置

```
postcss.config.mjs                                  # @tailwindcss/postcss plugin
src/app/globals.css                                 # @import 'tailwindcss' + @theme inline tokens
src/app/layout.tsx                                  # import globals.css + Inter font variable
src/lib/utils.ts                                    # cn(...inputs) helper
src/components/ui/
├── button.tsx
├── input.tsx
├── label.tsx
├── card.tsx
└── alert.tsx                                       # v1 已建立的 5 個 shadcn primitive
```

未來新元件（v1 範圍外）：Dialog / DropdownMenu / Select / Combobox / Table / Toast / Tooltip / Tabs 等，**按需從 shadcn 官方原始碼複製進 `src/components/ui/`**；不裝 shadcn CLI（避免拉入無關元件）。

### 強制要求

1. **新 UI 元件優先用 shadcn 對應元件**；缺則手動建檔複製 shadcn 官方原始碼放 `src/components/ui/`。**不裝 shadcn CLI**。
2. **design token 只能改 `globals.css` 的 `:root` 與 `@theme inline`**；元件內不 hard-code 色票（`bg-red-500` 之類僅在原型階段；正式 component 一律 `bg-destructive` / `bg-primary`）。
3. **`@apply` 僅在 `@layer base`** 使用；元件內保持 utility class，不寫 component-scope CSS。
4. **`cn()` 用 `clsx + tailwind-merge`**，避免兩個 utility class 衝突時順序不確定。
5. **a11y 預設用 Radix primitive**：所有需 keyboard / focus / portal 的元件（Dialog / Popover / DropdownMenu / Select / Combobox）必須走 Radix，不自寫。
6. **dark mode 在 v1 不啟用但保留結構**：`globals.css` 預留 `.dark` selector（`@custom-variant dark`）；未來只需新增 `.dark { --background: ...; ... }` 區塊與 `<html class="dark">` toggle，無需重構元件。
7. **字型統一**：Inter（透過 `next/font/google`），CSS variable `--font-inter` → `--font-sans`；元件 className 寫 `font-sans` 即可。
8. **icon 統一用 lucide-react**：不混用 heroicons / phosphor 等其他 icon set，避免兩套線條風格並存。

### 何時重新評估

- Tailwind v5 或下一代主要版本釋出
- shadcn 官方對 React 19 / Tailwind v4 元件 API 出現破壞性變更
- 引入 dark mode 時：本 ADR 補上 dark token 表
- 引入 i18n 框架時：評估與 Inter font fallback 的搭配
- bundle size 觀測（v1 未測；落地後若超過合理門檻再評估）

## 影響範圍

| 檔案 | 變更 |
|------|------|
| `package.json` | +9 deps：tailwindcss / @tailwindcss/postcss / tw-animate-css / class-variance-authority / clsx / tailwind-merge / lucide-react / @radix-ui/react-label / @radix-ui/react-slot；+2 devDeps：jsdom / @testing-library/user-event |
| `postcss.config.mjs` | 新增 |
| `src/app/globals.css` | 新增（Tailwind import + OKLCH 色票 + theme tokens） |
| `src/app/layout.tsx` | 載入 globals.css + Inter font |
| `src/lib/utils.ts` | 新增 `cn()` helper |
| `src/components/ui/{button,input,label,card,alert}.tsx` | 新增（v1 5 個 shadcn primitive） |
| `docs/specs/02-auth-session.md` §3.1 / §9 / §12 | 新增「登入頁 UI 設計」小節 + 測試清單擴充 + 本 ADR cross-ref |
| `docs/specs/08–11`（screen specs） | Server / Client 切割描述不變；元件名稱沿用 shadcn 提供的 Card / Button / Input / Label / Alert / Dialog 等；UI tooling 段落隱含採本 ADR |

## 參考

- [Tailwind v4 release notes](https://tailwindcss.com/blog/tailwindcss-v4)
- [shadcn/ui docs](https://ui.shadcn.com)
- [Radix Primitives](https://www.radix-ui.com/primitives)
- [OKLCH 色彩空間（why for design system）](https://evilmartians.com/chronicles/oklch-in-css-why-quit-rgb-hsl)
- [02-auth-session.md §3.1 登入流程](../specs/02-auth-session.md#31-登入流程)（首個落地頁面）
