import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import * as devicePairing from "../infra/device-pairing.js";
import {
  connectReq,
  getFreePort,
  installGatewayTestHooks,
  openWs,
  restoreGatewayToken,
  startGatewayServer,
  testState,
  waitForWsClose,
} from "./server.auth.shared.js";

installGatewayTestHooks({ scope: "suite" });

describe("handshake internal error feedback", () => {
  let server: Awaited<ReturnType<typeof startGatewayServer>>;
  let port = 0;
  let prevToken: string | undefined;

  beforeAll(async () => {
    prevToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    testState.gatewayAuth = { mode: "none" };
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    port = await getFreePort();
    server = await startGatewayServer(port);
  });

  afterAll(async () => {
    await server.close();
    restoreGatewayToken(prevToken);
  });

  test("sends UNAVAILABLE error response when handshake throws an internal error", async () => {
    // Make ensureDeviceToken throw an internal error after the connect
    // handshake has parsed the request and extracted the frame ID. This
    // simulates any unexpected crash during handshake processing (e.g. file
    // I/O failure, corrupt pairing state, etc.). Before the fix, the
    // server silently closed the connection. After the fix, the server
    // sends an error response so the client gets actionable feedback.
    const spy = vi
      .spyOn(devicePairing, "ensureDeviceToken")
      .mockRejectedValueOnce(new Error("simulated internal error"));

    const ws = await openWs(port);
    try {
      const res = await connectReq(ws, {
        skipDefaultAuth: true,
        scopes: ["operator.admin"],
      });
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("UNAVAILABLE");
      expect(res.error?.message).toBe("internal handshake error");
      const closed = await waitForWsClose(ws, 2_000);
      expect(closed).toBe(true);
    } finally {
      spy.mockRestore();
      if (ws.readyState !== ws.CLOSED) {
        ws.close();
      }
    }
  });
});
