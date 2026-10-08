import { onCleanup, onMount } from "solid-js";

export type ToastVariant = "error" | "info" | "success" | "warning";

export function ToastNotification(props: {
  message: string;
  variant?: ToastVariant;
  onClose?: () => void;
}) {
  const variant = () => props.variant ?? "info";
  const bg = () => {
    switch (variant()) {
      case "error":
        return "var(--color-danger, #b94040)";
      case "success":
        return "var(--color-success, #1f8f57)";
      case "warning":
        return "var(--color-warning, #b7791f)";
      case "info":
      default:
        return "var(--color-info, #3b5ba8)";
    }
  };

  onMount(() => {
    const timer = setTimeout(() => props.onClose?.(), 3000);
    onCleanup(() => clearTimeout(timer));
  });

  return (
    <div
      data-testid={`toast-${variant()}`}
      style={{
        position: "fixed",
        top: "24px",
        right: "24px",
        "z-index": 9999,
        background: bg(),
        color: "#fff",
        padding: "10px 18px",
        "border-radius": "6px",
        "font-size": "13px",
        "box-shadow": "0 4px 12px rgba(0,0,0,0.4)",
        display: "flex",
        gap: "10px",
        "align-items": "center",
        "max-width": "420px",
      }}
    >
      <span aria-hidden="true">{variant() === "success" ? "✓" : null}</span>
      <span>{props.message}</span>
      <button
        data-testid="toast-close"
        onClick={props.onClose}
        style={{
          background: "none",
          border: "none",
          color: "#fff",
          cursor: "pointer",
          padding: "0 4px",
          "font-size": "16px",
        }}
      >
        ×
      </button>
    </div>
  );
}
