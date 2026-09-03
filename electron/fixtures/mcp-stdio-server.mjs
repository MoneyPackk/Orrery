#!/usr/bin/env node
/**
 * A real MCP server over stdio, used to verify Orrery's client against the actual
 * protocol rather than against a mock of it.
 *
 * Deliberately dependency-free and launched as `node <this file>`, because Orrery
 * refuses to register shells and script interpreters, and spawns with a minimal
 * environment ({PATH, SYSTEMROOT}) and no shell.
 *
 * Behaviours it exercises:
 * - the initialize / notifications/initialized / tools/list / tools/call sequence
 * - newline-delimited JSON-RPC framing, including two frames in one write
 * - a tool that succeeds, one that reports isError, one that returns non-text content,
 *   one that echoes its arguments back so argument fidelity is observable,
 *   and one that returns output larger than Orrery's cap so truncation is exercised
 * - annotation-driven risk classification (destructiveHint, openWorldHint)
 */

const TOOLS = [
  {
    name: "read_note",
    title: "Read note",
    description: "Returns a fixed note.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "echo_args",
    title: "Echo arguments",
    description: "Returns the arguments it received, so fidelity is observable.",
    inputSchema: { type: "object", properties: { value: { type: "string" } } },
  },
  {
    name: "fail_loudly",
    title: "Fail loudly",
    description: "Reports a tool-level error.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "binary_blob",
    title: "Binary blob",
    description: "Returns a non-text content block.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "flood",
    title: "Flood",
    description: "Returns more text than the client accepts.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "purge_everything",
    title: "Purge everything",
    description: "Removes data permanently.",
    inputSchema: { type: "object", properties: {} },
    annotations: { destructiveHint: true },
  },
  {
    name: "reach_out",
    title: "Reach out",
    description: "Contacts an external service.",
    inputSchema: { type: "object", properties: {} },
    annotations: { openWorldHint: true },
  },
];

let initialized = false;
let sawInitializedNotification = false;
let buffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) handleLine(line);
    newline = buffer.indexOf("\n");
  }
});

function handleLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  // A notification carries no id and must never be answered.
  if (message.id === undefined) {
    if (message.method === "notifications/initialized") sawInitializedNotification = true;
    return;
  }
  if (message.method === "initialize") {
    initialized = true;
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "orrery-fixture", version: "1.0.0" },
      },
    });
    return;
  }
  if (!initialized) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32002, message: "Server not initialized." } });
    return;
  }
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } });
    return;
  }
  if (message.method === "tools/call") {
    respondToCall(message);
    return;
  }
  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found." } });
}

function respondToCall(message) {
  const name = message.params?.name;
  const args = message.params?.arguments ?? {};
  const reply = result => send({ jsonrpc: "2.0", id: message.id, result });

  if (name === "read_note") {
    reply({ content: [{ type: "text", text: "the note says hello" }], isError: false });
    return;
  }
  if (name === "echo_args") {
    // Keys sorted at every level so the assertion does not depend on key order.
    reply({ content: [{ type: "text", text: JSON.stringify(sortDeep(args)) }], isError: false });
    return;
  }
  if (name === "fail_loudly") {
    reply({ content: [{ type: "text", text: "the tool failed" }], isError: true });
    return;
  }
  if (name === "binary_blob") {
    reply({ content: [{ type: "image", data: "AAAA", mimeType: "image/png" }], isError: false });
    return;
  }
  if (name === "flood") {
    reply({ content: [{ type: "text", text: "x".repeat(50_000) }], isError: false });
    return;
  }
  if (name === "purge_everything" || name === "reach_out") {
    reply({ content: [{ type: "text", text: `${name} ran; initialized notification seen: ${sawInitializedNotification}` }], isError: false });
    return;
  }
  send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "Unknown tool." } });
}

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/** Recursively orders object keys so echoed arguments serialize deterministically. */
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value === null || typeof value !== "object") return value;
  const ordered = {};
  for (const key of Object.keys(value).sort()) ordered[key] = sortDeep(value[key]);
  return ordered;
}
