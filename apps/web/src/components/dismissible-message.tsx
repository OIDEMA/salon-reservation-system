"use client";

import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

const DEFAULT_DISMISS_DELAY_MS = 5_000;

type DismissibleMessageProps = {
  message: string;
  onDismiss: () => void;
  className?: string;
  icon?: ReactNode;
  role?: "alert" | "status";
  dismissDelayMs?: number;
};

export function DismissibleMessage({
  message,
  onDismiss,
  className = "formMessage",
  icon,
  role = "status",
  dismissDelayMs = DEFAULT_DISMISS_DELAY_MS
}: DismissibleMessageProps) {
  const onDismissRef = useRef(onDismiss);

  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    const timer = window.setTimeout(() => onDismissRef.current(), dismissDelayMs);
    return () => window.clearTimeout(timer);
  }, [dismissDelayMs, message]);

  return (
    <div className={`${className} dismissibleMessage`} role={role} aria-live={role === "status" ? "polite" : "assertive"}>
      {icon}
      <span className="dismissibleMessageText">{message}</span>
      <button className="dismissibleMessageClose" type="button" aria-label="通知を閉じる" onClick={onDismiss}>
        <X aria-hidden="true" size={17} />
      </button>
    </div>
  );
}
