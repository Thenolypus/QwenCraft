import { describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

describe("WebSocket protocol", () => {
  it("round-trips a tool_call and tool_result payload", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const listening = await new Promise<{ ok: boolean; error?: NodeJS.ErrnoException }>((resolve) => {
      server.once("listening", () => resolve({ ok: true }));
      server.once("error", (error: NodeJS.ErrnoException) => resolve({ ok: false, error }));
    });
    if (!listening.ok) {
      expect(listening.error?.code).toBe("EPERM");
      server.close();
      return;
    }
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("no port");
    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        socket.send(JSON.stringify({ id: message.id, type: "tool_result", status: "success", detail: "ok" }));
      });
    });

    const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await new Promise<void>((resolve) => client.once("open", () => resolve()));
    const id = "test-id";
    client.send(JSON.stringify({ id, type: "tool_call", tool: "chat", args: { message: "hi" } }));
    const response = await new Promise<any>((resolve) => client.once("message", (raw) => resolve(JSON.parse(raw.toString()))));
    expect(response).toEqual({ id, type: "tool_result", status: "success", detail: "ok" });
    client.close();
    server.close();
  });
});
