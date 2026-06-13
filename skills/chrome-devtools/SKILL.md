---
name: chrome-devtools
description: Uses Chrome DevTools via MCP for efficient debugging, troubleshooting and browser automation. Use when debugging web pages, automating browser interactions, analyzing performance, or inspecting network requests. This skill does not apply to `--slim` mode (MCP configuration).
---

## Core Concepts

**Browser lifecycle**: Browser starts automatically on first tool call using a persistent Chrome profile. Configure via CLI args in the MCP server configuration: `npx chrome-devtools-mcp@latest --help`.
Addional tooling can be enabled by providing the following flags:

- For extension tooling, use the `--categoryExtensions` flag.
- For memory tooling, use the `--memoryDebugging` flag.

**Page selection**: Tools operate on the currently selected page. Use `list_pages` to see available pages, then `select_page` to switch context.
**Element interaction**: Use `take_snapshot` to get page structure with element `uid`s. Each element has a unique `uid` for interaction. If an element isn't found, take a fresh snapshot - the element may have been removed or the page changed.

## Workflow Patterns

### Before interacting with a page

1. Navigate: `navigate_page` or `new_page`
2. Wait: `wait_for` to ensure content is loaded if you know what you look for.
3. Snapshot: `take_snapshot` to understand page structure
4. Interact: Use element `uid`s from snapshot for `click`, `fill`, etc.

### Efficient data retrieval

Diagnostic reads (`list_console_messages`, `list_network_requests`) return **every**
message/request by default, which floods the context window. Always narrow the
request to what you actually need:

- **`list_console_messages`**: default to `types: ["error", "warn"]` when hunting
  for problems. Only widen to `["log", "info", ...]` if you specifically need them.
- **`list_network_requests`**: pass `resourceTypes` (e.g. `["xhr", "fetch"]`) to
  skip images/fonts/stylesheets when you only care about API traffic.
- **Paginate** large result sets with `pageSize` (e.g. `pageSize: 50`) + `pageIdx`
  instead of pulling everything in one call.
- Use the `filePath`-style params for large outputs (screenshots, snapshots,
  traces) and `get_network_request`'s `responseFilePath` to offload big bodies to
  disk rather than inlining them.
- Set `includeSnapshot: false` on input actions unless you need updated page state.

> Note: `list_network_requests` can filter by `resourceTypes` but **not** by HTTP
> status or latency. To find only failed/slow requests, fetch the relevant
> `resourceTypes` and inspect `status`/timing in the result.

### Token-Saving Protocol (strict)

Images and raw dumps are the most expensive thing you can put in the context
window. Follow these rules unless the user explicitly overrides them:

1. **Prefer snapshots over screenshots.** Use `take_snapshot` (text-based
   accessibility tree with element `uid`s) to find elements and verify state.
   Do **not** use `take_screenshot` to locate elements or read text — only for
   genuine *visual* questions (layout, colour, rendering).
2. **Keep `includeSnapshot: false`** on `click`, `fill`, `fill_form`, etc.
   unless you expect a navigation or a major DOM/layout change. Re-snapshot
   explicitly only when you actually need the new state.
3. **Screenshot last, and focused.** Take a visual screenshot only when asked
   for visual confirmation or at the end as a final check — never after every
   action.

### Tool selection

- **Automation/interaction**: `take_snapshot` (text-based, faster, better for automation)
- **Visual inspection**: `take_screenshot` (when user needs to see visual state)
- **Additional details**: `evaluate_script` for data not in accessibility tree

### Focused screenshots (`take_screenshot`)

Claude is billed for images by pixel area, so always capture the **smallest
useful region at the lowest useful resolution**. This proxy requires a focus
`region` and returns a cropped, downscaled **WebP**:

- **`region`** (required): `full`, `top`/`bottom`/`left`/`right` (that half),
  `center` (central quarter), or `top-strip`/`bottom-strip` (top/bottom 20% band
  — use for headers/footers). Pick the smallest region that answers the question.
- **`maxWidth`** (default 1024): lower it (e.g. `512`) when you only need to
  confirm a layout — fewer pixels means fewer tokens.
- **`quality`** (default 50): WebP quality; trims file size/latency, not tokens.

Examples: checking a sticky header → `region: "top-strip", maxWidth: 768`;
verifying a centred modal → `region: "center"`; a quick full-page sanity check →
`region: "full", maxWidth: 512`.

### Parallel execution

You can send multiple tool calls in parallel, but maintain correct order: navigate → wait → snapshot → interact.

### Testing an extension

> **Before proceeding**: Extension tools (`install_extension`, `list_extensions`, etc.) are only available when the MCP server is started with the `--categoryExtensions` flag. If these tools are not in your tool list, stop and ask the user to update their MCP server configuration:
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
> After updating, the user must restart the MCP server (or their AI client) for the change to take effect.

1. **Install**: Use `install_extension` with the path to the unpacked extension.
2. **Identify**: Get the extension ID from the response or by calling `list_extensions`.
3. **Trigger Action**: Use `trigger_extension_action` to open the popup or side panel if applicable.
4. **Verify Service Worker**: Use `evaluate_script` with `serviceWorkerId` to check extension state or trigger background actions.
5. **Verify Page Behavior**: Navigate to a page where the extension operates and use `take_snapshot` to check if content scripts injected elements or modified the page correctly.

## Troubleshooting

If `chrome-devtools-mcp` is insufficient, guide users to use Chrome DevTools UI:

- https://developer.chrome.com/docs/devtools
- https://developer.chrome.com/docs/devtools/ai-assistance

If there are errors launching `chrome-devtools-mcp` or Chrome, refer to https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/troubleshooting.md.
