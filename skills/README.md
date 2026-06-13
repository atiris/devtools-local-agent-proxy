# Bundled skills

These skills are **vendored** (copied) from the upstream
[`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp)
project, licensed under Apache-2.0. They are bundled here so this plugin is
self-contained: you can disable/uninstall the upstream `chrome-devtools-mcp`
plugin entirely and still keep its skills, while this plugin provides the
(compressing) MCP server.

| Skill | Purpose |
|-------|---------|
| `a11y-debugging` | Accessibility (a11y) debugging & auditing via the accessibility tree |
| `chrome-devtools` | General Chrome DevTools debugging & browser automation |
| `chrome-devtools-cli` | Drive Chrome DevTools from shell scripts / CLI |
| `debug-optimize-lcp` | Debug & optimize Largest Contentful Paint / Core Web Vitals |
| `memory-leak-debugging` | Diagnose JS/Node memory leaks (memlab, heapsnapshots) |
| `troubleshooting` | Diagnose MCP connection/target failures |

The skills reference tools by bare name (`take_snapshot`, `list_pages`, …)
without a server prefix, so they work transparently against this plugin's
proxied `chrome-devtools` MCP server.

## Provenance

Vendored from `chrome-devtools-mcp` **v1.2.0**. See the repo-root `NOTICE`
for attribution.

## Keeping in sync with upstream

Upstream ships skills inside the `chrome-devtools-mcp` plugin. When that plugin
updates, re-vendor with:

```bash
# 1. Locate the latest cached upstream plugin (version dir varies):
ls ~/.claude/plugins/cache/*/chrome-devtools-mcp/*/skills

# 2. Diff to see what changed since we last vendored:
SRC=~/.claude/plugins/cache/chrome-devtools-plugins/chrome-devtools-mcp/<version>/skills
diff -ru ./skills "$SRC" --exclude README.md

# 3. Re-copy if you want to take upstream as-is:
cp -r "$SRC/." ./skills/

# 4. Update the vendored version number in NOTICE and in this file.
```

> The `~/.claude/plugins/cache/...` path is where Claude Code unpacks installed
> plugins. The exact marketplace folder (`chrome-devtools-plugins` vs
> `claude-plugins-official`) and version segment depend on how it was installed —
> the `ls` in step 1 finds it.

### Local adaptations

Keep this list current so re-vendoring doesn't silently clobber local edits:

- **`chrome-devtools/SKILL.md`** — rewritten terser (no trailing periods on
  prose, trimmed filler) and adapted for this proxy: a "Token-saving protocol",
  an "Efficient data retrieval" section documenting the proxy defaults
  (`minLevel`/`maxLevel` for console, `statusMin`/`statusMax` for network), and a
  "Focused screenshots" section documenting the required `region` plus
  `maxWidth`/`quality` on `take_screenshot`. All proxy-specific with no upstream
  equivalent; re-apply after any re-vendor.
- **`debug-optimize-lcp/SKILL.md`** — Step 4 now passes `statusMin: 0,
  statusMax: 599` to `list_network_requests` so the proxy's error-only default
  doesn't hide the successful 2xx LCP resource. Re-apply after re-vendor.

If you customize a skill (e.g. teaching `troubleshooting` about this proxy's
Ollama layer and `dist/proxy.js`), note it here so a future `cp -r` doesn't
overwrite it without review.
