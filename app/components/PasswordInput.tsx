"use client";

import { Eye, EyeOff } from "lucide-react";
import { useState, type InputHTMLAttributes } from "react";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  /** Required — the toggle button points at the input via `aria-controls`. */
  id: string;
};

/**
 * A password `<input>` with a show/hide eye toggle. The toggle is a real
 * `<button type="button">` (focusable, Enter/Space activate it, never submits
 * the surrounding form) whose `aria-label` flips between "Show password" and
 * "Hide password". Every other input prop passes straight through, so it's a
 * drop-in replacement for `<input type="password">`.
 */
export default function PasswordInput({ id, className, ...inputProps }: Props) {
  const [visible, setVisible] = useState(false);
  const Icon = visible ? EyeOff : Eye;

  return (
    <div className="relative mt-1">
      <input
        {...inputProps}
        id={id}
        type={visible ? "text" : "password"}
        className={`${className ?? ""} pr-10`}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? "Hide password" : "Show password"}
        aria-controls={id}
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-lg text-text-muted transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
      >
        <Icon aria-hidden className="h-4 w-4" />
      </button>
    </div>
  );
}
