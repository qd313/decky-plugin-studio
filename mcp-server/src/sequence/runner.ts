const FOCUS_MAP: Record<string, string> = {
  Up: "onMoveUp",
  Down: "onMoveDown",
  Left: "onMoveLeft",
  Right: "onMoveRight",
  A: "onOKButton",
  B: "onCancelButton",
  Select: "onButtonDown",
  Steam: "onButtonDown",
  QAM: "onButtonDown",
};

export async function runSequence(
  inputs: string[],
  delayMs: number
): Promise<{ focusPath: string[]; activeElement: string; domSnapshot: string }> {
  const focusPath: string[] = [];
  let activeElement = "document.body";

  for (const input of inputs) {
    const callback = FOCUS_MAP[input] ?? "onMoveRight";
    focusPath.push(`${callback}(${input})`);
    activeElement = `[data-focus-id="${input.toLowerCase()}"]`;
    await new Promise((r) => setTimeout(r, delayMs));
  }

  const domSnapshot = `<div data-focus-path="${focusPath.join("->")}">${activeElement}</div>`;
  return { focusPath, activeElement, domSnapshot };
}
