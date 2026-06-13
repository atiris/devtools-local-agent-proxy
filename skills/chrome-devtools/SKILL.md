---
name: chrome-devtools
description: Uses Chrome DevTools via MCP for efficient debugging, troubleshooting and browser automation. Use when debugging web pages, automating browser interactions, analyzing performance, or inspecting network requests. This skill does not apply to `--slim` mode (MCP configuration).
---

## Core concepts

**Browser lifecycle**: browser starts on the first tool call using a persistent Chrome profile. Configure via CLI args in the MCP server config: `npx chrome-devtools-mcp@latest --help`. Extra tooling:

- `--categoryExtensions` for extension tooling
- `--memoryDebugging` for memory tooling

**Page selection**: tools act on the selected page. `list_pages` to list, `select_page` to switch.

**Element interaction**: `take_snapshot` returns page structure with a `uid` per element; use that `uid` for `click`, `fill`, etc. If an element isn't found, take a fresh snapshot — it may have been removed or the page changed.

## Workflow patterns

### Before interacting with a page

1. Navigate: `navigate_page` or `new_page`
2. Wait: `wait_for` when you know what content to expect
3. Snapshot: `take_snapshot` for structure
4. Interact: use `uid`s from the snapshot for `click`, `fill`, etc.

### Token-saving protocol (strict)

Images and raw dumps are the most expensive things in the context window. Follow these unless the user overrides them:

1. **Snapshots over screenshots** — use `take_snapshot` to find elements and verify state; use `take_screenshot` only for genuine visual questions (layout, colour, rendering), never to locate elements or read text
2. **`includeSnapshot: false`** on `click`, `fill`, `fill_form`, etc. unless you expect navigation or a major DOM/layout change; re-snapshot explicitly when you need new state
3. **Screenshot last and focused** — only on request or as a final check, never after every action

### Efficient data retrieval

The two list tools default to high-signal rows only (this proxy narrows them); widen explicitly when you need more:

- **`list_console_messages`** — returns `warn`..`error` by default. Set `minLevel`/`maxLevel` (`debug` < `info` < `warn` < `error`) to change the band; `minLevel: "debug"` returns everything
- **`list_network_requests`** — returns status `400`-`599` plus failed requests by default. Set `statusMin`/`statusMax` to change the band; `statusMin: 0, statusMax: 599` returns everything. Also pass `resourceTypes` (e.g. `["xhr", "fetch"]`) to skip images/fonts/stylesheets
- **Paginate** big result sets with `pageSize` + `pageIdx` instead of one large pull
- **Offload bodies to disk** with the `filePath`-style params (screenshots, snapshots, traces) and `get_network_request`'s `responseFilePath`, rather than inlining them

### Focused screenshots

Images are billed by pixel area, so capture the smallest useful region at the lowest useful resolution. To inspect one component, prefer `take_element_screenshot`.

**`take_element_screenshot`** — a tight, padded WebP of a single element:

- **`uid`** (required): element uid from `take_snapshot`
- **`padding`** (default 10): extra px so the element's border/focus ring is covered
- **`maxWidth`** (default 1024), **`quality`** (default 50)

The proxy measures the element, takes a full-page shot, and crops to just that element (works for tall/below-the-fold elements at any devicePixelRatio). Use it instead of `take_screenshot` whenever you care about one component.

**`take_screenshot`** — page/region capture; requires a focus `region` and returns a cropped, downscaled WebP:

- **`region`** (required): `full`, `top`/`bottom`/`left`/`right` (that half), `center` (central quarter), or `top-strip`/`bottom-strip` (top/bottom 20% band, for headers/footers) — pick the smallest region that answers the question
- **`maxWidth`** (default 1024): lower it (e.g. `512`) for a layout check — fewer pixels, fewer tokens
- **`quality`** (default 50): WebP quality; trims file size/latency, not tokens

Examples: sticky header → `region: "top-strip", maxWidth: 768`; centred modal → `region: "center"`; quick full-page sanity check → `region: "full", maxWidth: 512`

Any image is capped at 3000px per side. If a capture exceeds it (usually a tall full page) the proxy withholds the image and asks you to narrow — pick a region, lower `maxWidth`, or use `take_element_screenshot`

### Tool selection

- **Automation/interaction**: `take_snapshot` (text, faster, better for automation)
- **Visual inspection**: `take_screenshot`
- **Data not in the accessibility tree**: `evaluate_script`

### Parallel execution

Send multiple tool calls in parallel, but keep order: navigate → wait → snapshot → interact

### Testing an extension

> **Before proceeding**: extension tools (`install_extension`, `list_extensions`, etc.) need the server started with `--categoryExtensions`. If they aren't in your tool list, stop and ask the user to update their MCP server config:
>
> ```json
> {
>   "mcpServers": {
>     "chrome-devtools": {
>       "command": "npx",
>       "args": ["chrome-devtools-mcp@latest", "--categoryExtensions"]
>     }
>   }
> }
> ```
>
> After updating, the user must restart the MCP server (or their AI client)

1. **Install**: `install_extension` with the path to the unpacked extension
2. **Identify**: get the extension ID from the response or `list_extensions`
3. **Trigger**: `trigger_extension_action` to open the popup or side panel
4. **Verify service worker**: `evaluate_script` with `serviceWorkerId` to check state or trigger background actions
5. **Verify page behaviour**: navigate to a page the extension acts on, then `take_snapshot` to check injected elements or page changes

## Troubleshooting

If `chrome-devtools-mcp` is insufficient, point users to the Chrome DevTools UI:

- https://developer.chrome.com/docs/devtools
- https://developer.chrome.com/docs/devtools/ai-assistance

For errors launching `chrome-devtools-mcp` or Chrome, see https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/troubleshooting.md
