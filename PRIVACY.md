# PriceLens Privacy Policy

**English** · [简体中文](PRIVACY.zh-CN.md)

Applies to version 0.3.0. Last updated 2026-09-30. Maintainer: [JohnsonRan / PriceLens](https://github.com/JohnsonRan/PriceLens).

PriceLens shows currency-conversion estimates next to prices on web pages. Everyday conversion needs no account. Optional AI is off by default. List-price differences are computed locally, without AI, and send no page content.

## 1. Local processing and storage

- **Reading pages.** On ordinary HTTP/HTTPS pages the extension reads prices, a limited amount of nearby text, currency information and layout, so it can recognise prices and place conversion tags. By default none of this page content is sent to any external service.
- **Site address.** The extension reads the current site's address locally, for "Pause on this site", per-site currency and some sensitive-path checks. It keeps no browsing-history database and does not request the browser history permission.
- **Right-click conversion.** "Convert with PriceLens" parses the text you selected (up to 500 characters) locally and sends it nowhere. Rates are fetched, when needed, as described in section 2.
- **Structured data.** Product structured data (JSON-LD) and struck-through price formatting are read only locally, to compute list-price differences.
- **Settings synced by your browser.** These settings are stored in the browser's `storage.sync` and may be synced by Chrome or Edge sync if you have it enabled:
  - auto-convert and list-price-difference switches
  - target currency and rate source
  - page currency hint
  - per-site currencies with their hostnames
  - card fee percentage
  - the list of paused sites
- **Data kept on this device only.** The Wise token, the TypeSafe key, your AI consent and cached rates are stored in local extension storage and are never synced.
  - The Wise token and TypeSafe key are never given to content scripts.
  - Rates and the AI on/off state reach the extension's own content script only in the form needed for conversion; web pages themselves cannot read them.
  - Local browser storage is not a separately encrypted vault, so protect your device and browser account.
- **No tracking.** The extension contains no ads, no analytics SDK, no browsing telemetry and no developer-operated data server. Its font and icons are bundled; it loads no remote code or assets.

## 2. External requests and recipients

| Feature and trigger | Recipient | What is sent |
| --- | --- | --- |
| Default central-bank rates, fetched under the cache policy when the panel opens, a page needs rates, you use right-click conversion, or you refresh | `api.frankfurter.dev` (Frankfurter: ECB data, plus a multi-central-bank blend for currencies the ECB does not cover) | Target currency code, provider name and the currency codes to fill in. No page prices or page content. |
| After you choose Wise, enter your own token and grant access | `api.wise.com` | Target currency code and your Wise token for authentication. No page prices or page content. |
| After you read the notice, enter a key, enable AI, save and grant access, whenever an unpaused site shows a price whose currency cannot be settled locally | `api.typesafe.ai` (TypeSafe / Jev) | The price text, up to 360 characters of nearby text per item, the candidate currencies, fixed questions and the model name. The key is sent in the authentication header. |

All requests use HTTPS and carry no website cookies. Service providers still receive normal connection information such as your IP address, and may log requests, account or usage information. The extension's developer receives none of these requests or keys.

AI requests never include full-page HTML, screenshots or the current page URL, although URL-like text inside a snippet may be included. AI output only selects from a limited list of currencies. Parsing, conversion and display all happen locally, and no code returned by the model is executed.

## 3. AI privacy boundaries

Once AI is enabled, eligible prices on unpaused sites are processed automatically; you are not asked before each request. The extension tries to exclude input fields, some hidden text, and common checkout, payment, account, sign-in, order and cart paths. It also masks some email addresses and long numbers.

**These measures cannot reliably detect every sensitive page or remove all personal information.** Nearby text may include product names, names, addresses, financial details, private messages or health information. Do not enable AI on sensitive pages. You can turn AI off, turn off auto-convert, pause the site, or restrict site access on the browser's extensions page.

Third-party retention, access and cross-border processing are governed by each provider's policies and your account agreement. TypeSafe currently states that it does not train or fine-tune models on input. That does not mean zero retention for every account, and PriceLens makes no zero-retention guarantee.

- [Frankfurter](https://frankfurter.dev/)
- [Wise privacy policy](https://wise.com/privacy-policy)
- [TypeSafe privacy policy](https://typesafe.ai/legal/privacy-policy)
- [TypeSafe data processing agreement](https://typesafe.ai/legal/data-processing)

## 4. Retention, turning things off and deletion

- **Settings and credentials** remain until you change them, clear them or uninstall the extension. To remove a key or token, first turn AI off or switch back to central-bank rates, then tick the matching "clear" option and save.
- **Rate caches** usually refresh every 6 hours for central-bank rates and every 5 minutes for Wise. If the network fails, only usable quotes from the same source and target currency, no more than 7 days old, are used. Expired records may remain in local storage but are no longer treated as valid quotes.
- **AI caches.** Page candidates and AI decisions are cached in memory only; page snippets are not stored persistently. The background decision cache lasts about 15 minutes with at most 256 entries. The in-page cache lasts until the page is closed or reloaded, or the relevant settings are reset.
- **Turning AI off.** Turning AI off and saving stops new AI requests, cancels in-flight requests where possible and clears decision caches. **Data already sent to a third party cannot be recalled.** To delete a provider's records, use that account or the provider's privacy contact.
- **Uninstalling** normally clears local extension storage. Synced data is also governed by your browser account settings and the provider's policies.

## 5. Limited use and contact

PriceLens uses and transfers user data only for the user-facing conversion features described above. It complies with the Chrome Web Store User Data Policy, including the Limited Use requirements. User data is never sold, and never used for advertising, credit assessment, lending or any purpose unrelated to conversion.

For questions, privacy requests or security reports, contact the maintainer via [GitHub Issues](https://github.com/JohnsonRan/PriceLens/issues). Issues are public, so **never post keys, screenshots of private pages or other sensitive information**. For account or data requests about a third-party service, also contact that provider.

If the purpose, recipients or scope of data sent ever changes, this policy will be updated first, and consent will be requested again where required.
