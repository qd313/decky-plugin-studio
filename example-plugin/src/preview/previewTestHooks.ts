/**
 * Preview test hooks for Decky Plugin Studio automated scenarios.
 */

export type ExamplePreviewTestHooks = {
  getState: () => Record<string, unknown>;
  setGreeting: (name: string) => void;
};

let greeting = "Decky dev";

export function isDeckyPreviewRuntime(): boolean {
  if (typeof window === "undefined") return false;
  if ((window as Window & { __DECKY_PREVIEW__?: boolean }).__DECKY_PREVIEW__) return true;
  try {
    const env = (import.meta as ImportMeta & { env?: { DECKY_PREVIEW?: boolean | string } }).env;
    return env?.DECKY_PREVIEW === true || env?.DECKY_PREVIEW === "true";
  } catch {
    return false;
  }
}

export function registerExamplePreviewTestHooks(): void {
  if (!isDeckyPreviewRuntime()) return;
  const hooks: ExamplePreviewTestHooks = {
    getState: () => ({ greeting }),
    setGreeting: (name: string) => {
      greeting = name;
    },
  };
  const w = window as Window & {
    __deckyPreviewTestHooks?: ExamplePreviewTestHooks;
    __bonsaiTestHooks?: ExamplePreviewTestHooks;
  };
  w.__deckyPreviewTestHooks = hooks;
  w.__bonsaiTestHooks = hooks;
}
