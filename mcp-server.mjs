#!/usr/bin/env node
/**
 * Instance Manager MCP Server
 *
 * 通过 MCP 协议将实例管理 REST API 暴露给 Claude Code orchestrator 实例。
 * 以 stdio 模式运行，由 Claude Code 的 --mcp-config 启动。
 *
 * 环境变量:
 *   MANAGER_PORT    - 管理器 HTTP 端口（必填）
 *   MANAGER_SESSION - 认证 session token（必填）
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const PORT = process.env.MANAGER_PORT;
const SESSION = process.env.MANAGER_SESSION;

if (!PORT || !SESSION) {
  console.error("MANAGER_PORT 和 MANAGER_SESSION 环境变量必须设置");
  process.exit(1);
}

const BASE_URL = `http://127.0.0.1:${PORT}`;

// ─── HTTP 请求工具 ─────────────────────────────────────────────────────────────

async function api(method, path, body) {
  const opts = {
    method,
    headers: {
      "Cookie": `session_token=${SESSION}`,
      "Content-Type": "application/json",
    },
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE_URL}${path}`, opts);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

// ─── MCP Server ────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "instance-manager",
  version: "1.0.0",
});

// --- list_instances ---
server.tool(
  "list_instances",
  "列出所有 Claude Code 实例及其当前状态（id、label、status、waitingInput 等）",
  {},
  async () => {
    const instances = await api("GET", "/api/instances");
    const summary = instances.map(i => ({
      id: i.id,
      label: i.label,
      status: i.status,
      cliType: i.cliType,
      waitingInput: i.waitingInput,
      cwd: i.cwd,
      startedAt: i.startedAt,
      finishedAt: i.finishedAt,
      lastOutput: i.lastOutput,
    }));
    return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
  }
);

// --- get_instance ---
server.tool(
  "get_instance",
  "获取指定实例的详细信息，包括最新输出",
  { instanceId: z.string().describe("实例 ID") },
  async ({ instanceId }) => {
    const inst = await api("GET", `/api/instances/${encodeURIComponent(instanceId)}`);
    return { content: [{ type: "text", text: JSON.stringify(inst, null, 2) }] };
  }
);

// --- create_instance ---
server.tool(
  "create_instance",
  "创建一个新的 Claude Code 实例并开始执行任务",
  {
    prompt: z.string().describe("要执行的任务 prompt"),
    cwd: z.string().optional().describe("工作目录路径"),
    label: z.string().optional().describe("实例显示标签"),
    cliType: z.enum(["claude", "codex", "gemini"]).optional().describe("CLI 类型，默认 claude"),
  },
  async ({ prompt, cwd, label, cliType }) => {
    const id = "inst-" + Date.now();
    const body = { id, prompt, cwd, label, cliType };
    const inst = await api("POST", "/api/instances", body);
    return { content: [{ type: "text", text: JSON.stringify(inst, null, 2) }] };
  }
);

// --- send_message ---
server.tool(
  "send_message",
  "向指定实例发送消息（添加到任务队列并立即发送）。适用于实例处于等待输入状态时。",
  {
    instanceId: z.string().describe("目标实例 ID"),
    message: z.string().describe("要发送的消息内容"),
  },
  async ({ instanceId, message }) => {
    // 添加任务到队列
    const task = await api("POST", `/api/instances/${encodeURIComponent(instanceId)}/tasks`, { text: message });
    // 立即发送该任务
    await api("POST", `/api/instances/${encodeURIComponent(instanceId)}/tasks/${encodeURIComponent(task.id)}/send`);
    return { content: [{ type: "text", text: `消息已发送到实例 ${instanceId}` }] };
  }
);

// --- stop_instance ---
server.tool(
  "stop_instance",
  "停止指定的运行中实例",
  { instanceId: z.string().describe("要停止的实例 ID") },
  async ({ instanceId }) => {
    await api("POST", `/api/instances/${encodeURIComponent(instanceId)}/stop`);
    return { content: [{ type: "text", text: `实例 ${instanceId} 已停止` }] };
  }
);

// --- get_output ---
server.tool(
  "get_output",
  "获取指定实例的终端输出（最后 N 行）",
  {
    instanceId: z.string().describe("实例 ID"),
    tail: z.number().optional().default(50).describe("返回最后多少行，默认 50"),
  },
  async ({ instanceId, tail }) => {
    const data = await api("GET", `/api/instances/${encodeURIComponent(instanceId)}/output?tail=${tail}`);
    return { content: [{ type: "text", text: data.output }] };
  }
);

// ─── 启动 ──────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
