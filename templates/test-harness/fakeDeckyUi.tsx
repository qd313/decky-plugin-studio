import React from "react";

type StubProps = Record<string, unknown> & { children?: React.ReactNode };

function stub(name: string) {
  return function DeckyUiStub({ children, ...rest }: StubProps) {
    return (
      <div data-decky-ui={name} {...rest}>
        {children}
      </div>
    );
  };
}

export const PanelSection = stub("PanelSection");
export const Button = stub("Button");
export const Focusable = stub("Focusable");
