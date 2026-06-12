// Check how chrome-devtools-mcp actually formats its CallToolResult
// by calling it directly via stdio and logging the raw JSON

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "npx",
  args: ["-y", "chrome-devtools-mcp@latest"],
  env: process.env,
});
const client = new Client({ name: "test-client", version: "0.0.1" });
await client.connect(transport);

// Call list_console_messages and inspect raw result structure
const result = await client.callTool({ name: "list_console_messages", arguments: {} });
console.log("content is Array:", Array.isArray(result.content));
console.log("content length:", result.content?.length);
if (Array.isArray(result.content)) {
  for (const c of result.content.slice(0, 3)) {
    console.log("  entry type:", c.type, "| has text:", "text" in c, "| text length:", c.text?.length ?? "N/A");
  }
}

// Replicate textOf logic
function textOf(result) {
  if (!Array.isArray(result.content)) return "";
  return result.content.map(c => c.type === "text" ? c.text : "").join("\n");
}
const text = textOf(result);
console.log("textOf() length:", text.length, "| estimated tokens:", Math.ceil(text.length / 4));

await transport.close();
