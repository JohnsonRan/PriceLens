# Chrome Web Store listing: English (primary language from 0.3.0)

## Basics

- Name: **PriceLens** (extName resolves to "PriceLens" in `en` and "价译 · PriceLens" in `zh_CN`)
- Default language: English (`default_locale: en`). Keep the Simplified Chinese listing from `LISTING.zh-CN.md`, and fill in both in the dashboard.
- Category: Shopping
- Website: https://github.com/JohnsonRan/PriceLens
- Support: https://github.com/JohnsonRan/PriceLens/issues
- Privacy policy: https://github.com/JohnsonRan/PriceLens/blob/main/PRIVACY.md (English; the Chinese version is at `PRIVACY.zh-CN.md`)
- Package: upload `dist/pricelens-<version>.zip` from `store/package.ps1`.

## Images

| Field | File |
| --- | --- |
| Store icon (128×128) | `extension/icons/icon128.png` (inside the ZIP) |
| Screenshots (1280×800, in order) | `store/<locale>/01-prices.png` … `05-settings.png` |
| Small promo tile (440×280) | `store/<locale>/promo-small-440x280.png` |
| Marquee promo tile (1400×560) | `store/<locale>/promo-marquee-1400x560.png` |

`<locale>` is `en` (default) or `zh_CN`. Each screenshot field takes at most 5 images, so keep the two languages in separate fields. Every image is a 24-bit RGB PNG without alpha, rendered by `store/render-screenshots.cjs` from the real extension UI with demo stores and fixed sample rates.

## Short description (manifest, ≤132 characters)

Keeps the original price and shows it in your currency. Daily central-bank rates, or Wise with your own token.

## Detailed description (paste as-is)

Shopping on a foreign site? Stop switching to a calculator.

PriceLens keeps every original price on the page and adds a small tag beside it with an estimate in your own currency.

Features
• Pick your currency once; supported prices on the page get a conversion tag.
• Original prices are never replaced. Click a tag (or hover one inside a product link) to see the currency, rate date and rate source.
• When "$" or "¥" prices are skipped as ambiguous, the panel says how many and links to this site's currency setting.
• Quick convert: the panel shows the live rate for a currency pair. Type any amount to convert it.
• Right-click conversion: select a price the page scan missed and choose "Convert with PriceLens".
• Card fee: add your card's foreign transaction fee, so results are closer to what you will actually be charged.
• Per-site currency: tell PriceLens what "$" means on a given shop (for example CAD) without affecting other sites.
• List-price difference: when a page clearly marks a list price (structured data or a struck-through price), PriceLens shows the list price minus the current price. Computed locally; can be turned off.
• Starting prices keep their "from" meaning instead of being shown as fixed prices.
• Pause any site, or turn automatic conversion off at any time.
• Light and dark themes; page tags adapt to the background they sit on. Full keyboard support.

Exchange rates
By default PriceLens uses free, daily central-bank reference rates. The ECB is preferred, and a multi-central-bank blend covers currencies the ECB does not publish. These are not live trading quotes, and no account or API key is needed. You can switch to Wise instead, using your own token and granting access to the Wise API; availability depends on your Wise account.

Optional AI
Some symbols, such as $ and ¥, can mean several currencies. When the page alone cannot settle which one, you can opt in to TypeSafe / Jev assistance. It is off by default and needs your own key, explicit consent and permission to reach the service.
When enabled, the price and up to 360 characters of nearby text per item are sent to TypeSafe automatically. Snippets may contain private information, so do not enable it on sensitive pages. Costs and data handling follow your TypeSafe plan and its policies. When the AI is unsure, the price is still skipped; recognition on every site is not guaranteed.

How to use
1. Install and pin the extension, then open the panel.
2. Choose "My currency".
3. Open or reload a shopping page. Pause the site if you do not want conversions there.

Limitations
Conversions are estimates. They exclude fees unless you set one, and may differ from what the merchant or bank finally charges. PriceLens never replaces prices and never pays for anything.
These prices are not supported yet:
• prices inside images, canvas and iframes
• prices inside closed Shadow DOM
• prices on some complex pages
Browser built-in pages cannot be processed.
The list-price difference is only the numeric difference between two prices shown on the page. It does not verify that a discount is genuine and is not a guaranteed saving. Member and coupon prices are ignored. Price history is not provided.

Privacy and support
In the default mode, no page text is uploaded; only enabling AI sends limited snippets. Keys stay on your device and are never synced. The full privacy policy, help and issue tracker are linked below.

Project and help: https://github.com/JohnsonRan/PriceLens
Privacy policy: https://github.com/JohnsonRan/PriceLens/blob/main/PRIVACY.md
Issues: https://github.com/JohnsonRan/PriceLens/issues

## Permission justifications (dashboard fields)

| Permission | Justification |
| --- | --- |
| `storage` | Saves the target currency, switches, paused sites and per-site currencies. Also saves local-only credentials, AI consent and the rate cache. Settings may sync through the browser; credentials never sync. |
| `activeTab` | Reads the current tab's address when the user opens the panel, to show and pause the current site. Also grants the one-off page access a right-click conversion needs. |
| `contextMenus` | Adds "Convert with PriceLens" for selected text. The selection is parsed locally and never uploaded. |
| `scripting` | Fallback display for right-click conversion only. On tabs opened before install or update, with no live content script, it shows the result through the activeTab grant from that click. It injects no remote code and does not read page content. |
| Content script on http/https | Recognises prices locally on pages the user visits and adds conversion tags. To tell which currency a page uses it also reads, locally, the page's own structured data, price meta tags and inline script data (scanned as text, never executed, never sent). Shopping sites are not known in advance. Top frame only. Users can pause sites or restrict access in the browser. |
| `api.frankfurter.dev` | Fetches the default daily central-bank reference rates. Sends only currency codes, never page text. |
| Optional `api.wise.com` | After the user chooses Wise and grants access, fetches rates with the user's own token. |
| Optional `api.typesafe.ai` | Only after explicit consent and granted access. Sends ambiguous prices and up to 360 characters of nearby text with the user's own key, so the model can choose from a fixed currency list. Off by default. |

**Remote code:** none. APIs return only rate data or limited selections. All scripts and the bundled font ship in the ZIP, and no AI output is executed.

## What's new in 0.4.0 (for the listing or release notes)

- **Smarter currency detection.** When a page's own data names exactly one currency for its prices, prices shown only as "$" or "¥" are converted instead of skipped. Read locally; nothing is sent. Pages whose data names several currencies are still skipped.
- **Skipped-price notice.** The panel says how many ambiguous prices were skipped on this page and links straight to this site's currency setting.
- **Prices inside product links** now get a tag too. It is plain text, so clicking still opens the product; hover it for details.
- **Smaller tags** fit beside more prices without moving the page.
- Fixes: amounts followed by "million", "bn" or similar are no longer converted as if they were the whole amount; more consistent skipped counts; faster scanning on large pages.

Known limits: a page whose own data states one currency while its visible text says another (for example a banner "Prices in CAD" over data saying USD) is converted with the data's currency; "$" or "¥" prices with no currency anywhere in the page (Steam, Newegg, Fanatical) need **Currency on this site**; PlayStation Store prices are not recognised yet; in some tight product grids (for example Xbox, Nintendo) there is no room for a tag beside the price, so use right-click conversion there.

## What's new in 0.3.0 (for the listing or release notes)

- A new design: the panel is an "exchange ticket" with a live rate and quick convert, and page tags are small price tags.
- Right-click conversion for selected text.
- Card foreign-transaction fee.
- Per-site currency for ambiguous symbols.
- The English interface is now the default for non-Chinese browsers.
- Fixed wrong amounts for prices such as $0.125/oz, $1.5M and cents styled separately from dollars.
