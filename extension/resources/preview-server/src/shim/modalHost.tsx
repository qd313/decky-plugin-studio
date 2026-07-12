import React from "react";
import { createRoot, type Root } from "react-dom/client";

export type ShowModalResult = {
  Close: () => void;
  Update: (modal: React.ReactNode) => void;
};

let modalContainer: HTMLDivElement | null = null;
let modalRoot: Root | null = null;

function ensureModalRoot(): Root {
  if (!modalContainer) {
    modalContainer = document.createElement("div");
    modalContainer.id = "decky-modal-root";
    document.body.appendChild(modalContainer);
    modalRoot = createRoot(modalContainer);
  }
  return modalRoot!;
}

function renderModal(content: React.ReactNode, onDismiss: () => void) {
  ensureModalRoot().render(
    <div
      className="decky-modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onDismiss();
      }}
    >
      <div className="decky-modal-shell">{content}</div>
    </div>
  );
}

export function showModalImpl(content: React.ReactNode): ShowModalResult {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    modalRoot?.render(null);
    window.dispatchEvent(new CustomEvent("decky-modal-closed"));
  };

  renderModal(content, close);

  return {
    Close: close,
    Update: (next) => {
      if (closed) return;
      renderModal(next, close);
    },
  };
}
