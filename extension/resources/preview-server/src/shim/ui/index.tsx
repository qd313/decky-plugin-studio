import React, { useEffect, useRef, useState } from "react";
import {
  extractGamepadHandlers,
  registerFocusTarget,
  unregisterFocusTarget,
  ensureFocusManager,
  type GamepadHandlers,
} from "../focusManager";
import { showModalImpl } from "../modalHost";

ensureFocusManager();

type ExtraProps = GamepadHandlers & Record<string, unknown>;

function useGamepadRegistration(
  ref: React.RefObject<HTMLElement | null>,
  props: ExtraProps,
  deps: React.DependencyList
) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handlers = extractGamepadHandlers(props);
    registerFocusTarget(el, handlers);
    return () => unregisterFocusTarget(el);
  }, deps);
}

let mainRunningApp: { appid: number; display_name: string } | null = null;

export const Router = {
  get MainRunningApp() {
    return mainRunningApp;
  },
  setMainRunningApp(app: { appid: number; display_name: string } | null) {
    mainRunningApp = app;
  },
  Route: ({ path, children }: { path: string; children: React.ReactNode }) => {
    const [current, setCurrent] = useState("/");
    useEffect(() => {
      const handler = (e: MessageEvent) => {
        if (e.data?.type === "decky-route") setCurrent(e.data.path);
      };
      window.addEventListener("message", handler);
      return () => window.removeEventListener("message", handler);
    }, []);
    return current === path || path === "/" ? <>{children}</> : null;
  },
  MainRouter: ({ children }: { children: React.ReactNode }) => <div className="decky-router">{children}</div>,
  SidebarRouter: ({ children }: { children: React.ReactNode }) => <div className="decky-sidebar">{children}</div>,
};

export const Navigation = {
  navigate: (path: string) => window.postMessage({ type: "decky-route", path }, "*"),
  close: () => window.postMessage({ type: "decky-route", path: "/" }, "*"),
};

export function Focusable(props: React.HTMLAttributes<HTMLDivElement> & ExtraProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { onMoveLeft, onMoveRight, onMoveUp, onMoveDown, onOKButton, onCancelButton, onButtonDown, ...rest } = props;
  useGamepadRegistration(ref, props, [
    onMoveLeft,
    onMoveRight,
    onMoveUp,
    onMoveDown,
    onOKButton,
    onCancelButton,
    onButtonDown,
  ]);
  return (
    <div
      ref={ref}
      tabIndex={0}
      {...rest}
      style={{ outline: "none", ...(props.style ?? {}) }}
    />
  );
}

export function Button(props: React.ButtonHTMLAttributes<HTMLButtonElement> & ExtraProps & { layout?: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const { layout: _layout, onMoveLeft, onMoveRight, onMoveUp, onMoveDown, onOKButton, onCancelButton, onButtonDown, className, ...rest } =
    props;
  useGamepadRegistration(ref, props, [
    onMoveLeft,
    onMoveRight,
    onMoveUp,
    onMoveDown,
    onOKButton,
    onCancelButton,
    onButtonDown,
  ]);
  return (
    <button
      ref={ref}
      className={["decky-btn", className].filter(Boolean).join(" ")}
      {...rest}
      style={{ ...(props.style ?? {}) }}
    />
  );
}

export function ButtonItem(props: React.ButtonHTMLAttributes<HTMLButtonElement> & ExtraProps & { layout?: string }) {
  return <Button {...props} />;
}

export function PanelSection({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="decky-panel-section">
      {title && <h3>{title}</h3>}
      {children}
    </section>
  );
}

export function PanelSectionRow({ children }: { children: React.ReactNode }) {
  return <div className="decky-panel-row">{children}</div>;
}

export function TextField(
  props: React.InputHTMLAttributes<HTMLInputElement> &
    ExtraProps & { label?: string; multiline?: boolean; rows?: number }
) {
  const ref = useRef<HTMLInputElement>(null);
  const { label, multiline, rows, onMoveLeft, onMoveRight, onMoveUp, onMoveDown, onOKButton, onCancelButton, onButtonDown, ...rest } =
    props;
  useGamepadRegistration(ref, props, [
    onMoveLeft,
    onMoveRight,
    onMoveUp,
    onMoveDown,
    onOKButton,
    onCancelButton,
    onButtonDown,
  ]);

  if (multiline) {
    const textareaProps = rest as React.TextareaHTMLAttributes<HTMLTextAreaElement>;
    return (
      <label style={{ display: "block", width: "100%" }}>
        {label && <div style={{ marginBottom: 6, color: "var(--decky-text-dim)", fontSize: 12 }}>{label}</div>}
        <textarea
          rows={rows ?? 3}
          className="decky-input"
          {...textareaProps}
          style={{ resize: "vertical", minHeight: 64, width: "100%", ...(props.style ?? {}) }}
        />
      </label>
    );
  }

  return (
    <label style={{ display: "block", width: "100%" }}>
      {label && <div style={{ marginBottom: 6, color: "var(--decky-text-dim)", fontSize: 12 }}>{label}</div>}
      <input ref={ref} className="decky-input" {...rest} style={{ ...(props.style ?? {}) }} />
    </label>
  );
}

export function ToggleField({
  label,
  checked,
  onChange,
  ...rest
}: {
  label: string;
  checked?: boolean;
  onChange?: (v: boolean) => void;
} & ExtraProps) {
  const ref = useRef<HTMLLabelElement>(null);
  useGamepadRegistration(ref, rest, [rest.onMoveLeft, rest.onMoveRight, rest.onMoveUp, rest.onMoveDown, rest.onOKButton]);
  return (
    <label ref={ref} style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 34 }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange?.(e.target.checked)} />
      {label}
    </label>
  );
}

export function Tabs({
  tabs,
  activeTab,
  onShowTab,
}: {
  tabs: { title: string; id: string; content: React.ReactNode }[];
  activeTab?: string;
  onShowTab?: (id: string) => void;
}) {
  const [active, setActive] = useState(activeTab ?? tabs[0]?.id);
  return (
    <div>
      <div className="decky-tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={["decky-tab", active === t.id ? "active" : ""].filter(Boolean).join(" ")}
            onClick={() => {
              setActive(t.id);
              onShowTab?.(t.id);
            }}
          >
            {t.title}
          </button>
        ))}
      </div>
      {tabs.find((t) => t.id === active)?.content}
    </div>
  );
}

export function showModal(content: React.ReactNode) {
  return showModalImpl(content);
}

export function ConfirmModal({
  children,
  strTitle,
  strDescription,
  strOKButtonText = "OK",
  strCancelButtonText = "Cancel",
  onOK,
  onCancel,
  closeModal,
  onEscKeypress,
  bOKDisabled,
  bCancelDisabled,
  bAlertDialog,
  className,
  modalClassName,
  bAllowFullSize = true,
}: {
  children?: React.ReactNode;
  strTitle?: React.ReactNode;
  strDescription?: React.ReactNode;
  strOKButtonText?: React.ReactNode;
  strCancelButtonText?: React.ReactNode;
  onOK?: () => void;
  onCancel?: () => void;
  closeModal?: () => void;
  onEscKeypress?: () => void;
  bOKDisabled?: boolean;
  bCancelDisabled?: boolean;
  bAlertDialog?: boolean;
  className?: string;
  modalClassName?: string;
  bAllowFullSize?: boolean;
}) {
  const cancel = () => {
    onCancel?.();
    closeModal?.();
    onEscKeypress?.();
  };

  return (
    <div
      className={[
        "decky-confirm-modal",
        bAllowFullSize ? "decky-confirm-modal--full" : "",
        modalClassName,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {strTitle ? <div className="decky-confirm-modal__header"><div className="decky-confirm-modal__title">{strTitle}</div></div> : null}
      <div className="decky-confirm-modal__body">
        {strDescription}
        {children}
      </div>
      <div className="decky-confirm-modal__footer">
        {!bAlertDialog && !bCancelDisabled ? (
          <Button className="decky-btn-secondary" onClick={cancel}>
            {strCancelButtonText}
          </Button>
        ) : null}
        <Button disabled={bOKDisabled} onClick={() => onOK?.()}>
          {strOKButtonText}
        </Button>
      </div>
    </div>
  );
}

export function ModalRoot({
  children,
  closeModal,
  onCancel,
  onEscKeypress,
  strTitle,
}: {
  children?: React.ReactNode;
  closeModal?: () => void;
  onCancel?: () => void;
  onEscKeypress?: () => void;
  strTitle?: React.ReactNode;
}) {
  const cancel = () => {
    onCancel?.();
    closeModal?.();
    onEscKeypress?.();
  };
  return (
    <div className="decky-confirm-modal decky-confirm-modal--full">
      <div className="decky-confirm-modal__header">
        <div className="decky-confirm-modal__title">{strTitle ?? "Dialog"}</div>
        <Button className="decky-btn-secondary" onClick={cancel} aria-label="Close">
          ✕
        </Button>
      </div>
      <div className="decky-confirm-modal__body">{children}</div>
    </div>
  );
}

export function Field({
  label,
  children,
}: {
  label?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="decky-field" style={{ marginBottom: 8 }}>
      {label ? <div style={{ marginBottom: 4, color: "var(--decky-text-dim)", fontSize: 12 }}>{label}</div> : null}
      {children}
    </div>
  );
}

export function SliderField({
  label,
  value = 0,
  min = 0,
  max = 100,
  step = 1,
  onChange,
  ...rest
}: {
  label: string;
  value?: number;
  min?: number;
  max?: number;
  step?: number;
  onChange?: (v: number) => void;
} & ExtraProps) {
  const ref = useRef<HTMLDivElement>(null);
  useGamepadRegistration(ref, rest, [rest.onOKButton]);
  return (
    <div ref={ref} className="decky-slider-field" tabIndex={0}>
      <label style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span>{label}</span>
        <span>{value}</span>
      </label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange?.(Number(e.target.value))}
        style={{ width: "100%" }}
      />
    </div>
  );
}

export function Dropdown({
  label,
  rgOptions,
  selectedOption,
  onChange,
  ...rest
}: {
  label?: string;
  rgOptions?: { label: string; data: string }[];
  selectedOption?: string;
  onChange?: (data: string) => void;
} & ExtraProps) {
  const ref = useRef<HTMLDivElement>(null);
  useGamepadRegistration(ref, rest, [rest.onOKButton]);
  const opts = rgOptions ?? [];
  return (
    <div ref={ref} className="decky-dropdown" tabIndex={0}>
      {label ? <div style={{ marginBottom: 4, fontSize: 12 }}>{label}</div> : null}
      <select
        value={selectedOption ?? opts[0]?.data ?? ""}
        onChange={(e) => onChange?.(e.target.value)}
        style={{ width: "100%", minHeight: 32 }}
      >
        {opts.map((o) => (
          <option key={o.data} value={o.data}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function DropdownOption({ children }: { children?: React.ReactNode }) {
  return <>{children}</>;
}

export function ProgressBar({ nProgress }: { nProgress?: number }) {
  const pct = Math.max(0, Math.min(100, nProgress ?? 0));
  return (
    <div style={{ background: "#1a3a52", borderRadius: 4, height: 8, overflow: "hidden" }}>
      <div style={{ width: `${pct}%`, height: "100%", background: "#4ec9b0" }} />
    </div>
  );
}

export function Spinner() {
  return <div className="decky-spinner" style={{ padding: 8, opacity: 0.8 }}>Loading…</div>;
}

export const Marquee = PanelSectionRow;

export const QuickAccessTab = {
  Home: "Home",
  Settings: "Settings",
  Notifications: "Notifications",
};

export { injectFocusEvent } from "../../focusGraph";
