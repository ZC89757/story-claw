# Desktop localization

The desktop UI supports `zh-CN`, `en`, and `ru`, plus `system`. English is the
fallback when no preferred system language is supported. Regional Chinese
locales currently use Simplified Chinese. The device preference is stored under
`story-claw.ui-language` in Electron renderer local storage, independently of
production templates and model configuration. Switching does not reload the
renderer, reset unsaved fields, or send production/agent IPC requests.

## Translation boundary

- `desktop/renderer/locales.cjs` contains both translation catalogs. Chinese
  source strings are message keys; positional placeholders such as `{0}` must
  occur unchanged in each translation. Use count labels instead of plural
  suffixes so English and Russian counts remain grammatical.
- `i18n.cjs` works in the browser and in Node (native file-picker titles).
  `bindText(node, () => source)` and `bindAttribute` retain live UI bindings;
  use `t(key, values)` inside the getter for formatted messages.
- `localize` runs once over authored UI containers, and `setHTML` runs it over
  trusted application HTML fragments. Do not call either on user or AI content.
  There is no document-wide mutation observer or third-party translation service.
- Project names, source text, chat messages, generated visual-plan cells, asset
  names, template-pack metadata, and raw logs are not translated. Chinese
  protocol field names and the confirmation command remain unchanged.
- Known worker phase formats are adapted at the presentation boundary via
  `phaseText`; unrecognized backend diagnostics are shown verbatim.
- Keep new UI labels in both catalogs. Do not translate option values, DOM IDs,
  filenames, API keys, or IPC payloads. Text is assigned as text, never HTML.

## Verification

```sh
node --test desktop/i18n.test.cjs
npm run build:runtime
```

Manual UI checks: switch all three languages and System default; restart the
app; switch with unsaved source text and settings; open every settings tab at
1120×720; inspect project/asset lists, progress cards, visual-plan approval,
video controls and the native file picker. Confirm source text and chat content
are unchanged and production continues through language changes.

Existing release installers need a new build/release to include these changes.
