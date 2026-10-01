// chrome.i18n test double backed by the shipped _locales files (same placeholder rules as Chrome).
const fs = require("node:fs");
const path = require("node:path");

function factory(messages, uiLanguage) {
  return {
    getUILanguage: () => uiLanguage,
    getMessage(key, subs = []) {
      const entry = messages[key];
      if (!entry) return "";
      const args = [].concat(subs).map(String);
      return entry.message.replace(/\$(\w+)\$/g, (whole, name) => {
        const content = entry.placeholders?.[name.toLowerCase()]?.content;
        return content ? content.replace(/\$(\d)/g, (_, n) => args[n - 1] ?? "") : whole;
      });
    },
  };
}

// Same fallback as Chrome: zh_CN has no folder of its own and resolves to zh.
const read = (lang) => {
  const dir = path.join(__dirname, "../extension/_locales");
  const pack = fs.existsSync(path.join(dir, lang)) ? lang : lang.split("_")[0];
  return JSON.parse(fs.readFileSync(path.join(dir, pack, "messages.json"), "utf8"));
};
const i18n = (lang = "zh_CN") => factory(read(lang), lang.replace("_", "-"));
// Inline <script> for file:// fixtures, which cannot fetch the locale file themselves.
const i18nScript = (lang = "zh_CN") => `<script>window.PL_I18N = (${factory})(${JSON.stringify(read(lang)).replace(/</g, "\\u003c")}, ${JSON.stringify(lang.replace("_", "-"))});</script>`;

module.exports = { i18n, i18nScript };
