import { describe, expect, it } from "vitest";
import {
  assertAllRpcMethodsRegistered,
  dispatchFakeRpc,
  getRpcCallLog,
  registerRpcHandlers,
  resetFakeDeckyRpc,
} from "./fakeDeckyRpc";

describe("fakeDeckyRpc", () => {
  it("dispatches registered handlers", async () => {
    registerRpcHandlers({ ping: () => "pong" });
    await expect(dispatchFakeRpc("ping", [])).resolves.toBe("pong");
  });

  it("records call log and resets between tests", async () => {
    registerRpcHandlers({ echo: (...args: unknown[]) => args[0] });
    resetFakeDeckyRpc();
    await dispatchFakeRpc("echo", ["hi"]);
    expect(getRpcCallLog()).toHaveLength(1);
    expect(getRpcCallLog()[0]?.method).toBe("echo");
  });

  it("throws on unknown methods", async () => {
    registerRpcHandlers({});
    resetFakeDeckyRpc();
    await expect(dispatchFakeRpc("not_a_real_rpc", [])).rejects.toThrow(/unhandled method/);
  });

  it("assertAllRpcMethodsRegistered checks the handler map", () => {
    registerRpcHandlers({ a: () => 1, b: () => 2 });
    expect(() => assertAllRpcMethodsRegistered(["a", "b"])).not.toThrow();
    expect(() => assertAllRpcMethodsRegistered(["a", "c"])).toThrow(/missing default handlers/);
  });
});
