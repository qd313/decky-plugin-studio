import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import plugin from "./index";
import { registerRpcHandlers } from "./test-harness/fakeDeckyRpc";
import { renderWithHarness } from "./test-harness/renderWithHarness";

/** Mirrors `main.py` `get_greeting`. */
function greet(name: string = "Decky dev"): string {
  return `Hello, ${name}! CPU temp check uses hwmon intercept in preview.`;
}

describe("example plugin greeting", () => {
  beforeEach(() => {
    registerRpcHandlers({
      get_greeting: (name) => greet(typeof name === "string" ? name : "Decky dev"),
    });
  });

  it("shows greeting after clicking Greet", async () => {
    renderWithHarness(plugin.content);
    fireEvent.click(screen.getByText("Greet"));
    await waitFor(() => {
      expect(screen.getByText(greet())).toBeTruthy();
    });
  });
});
