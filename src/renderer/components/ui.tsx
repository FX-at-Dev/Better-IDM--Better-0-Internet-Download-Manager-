import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon";

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`toggle ${checked ? "on" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
    >
      <span className="knob" />
    </button>
  );
}

export function Btn({
  children,
  onClick,
  kind = "secondary",
  icon,
  title,
  disabled,
  small,
  type = "button",
}: {
  children?: ReactNode;
  onClick?: (e: React.MouseEvent) => void;
  kind?: "primary" | "secondary" | "danger" | "icon";
  icon?: string;
  title?: string;
  disabled?: boolean;
  small?: boolean;
  type?: "button" | "submit";
}) {
  return (
    <button type={type} className={`btn ${kind} ${small ? "small" : ""} ${children ? "" : "only-icon"}`} onClick={onClick} title={title} disabled={disabled} aria-label={title}>
      {icon && <Icon name={icon} size={small ? 15 : 16} />}
      {children && <span>{children}</span>}
    </button>
  );
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  small,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  small?: boolean;
}) {
  return (
    <div className={`select ${small ? "small" : ""}`}>
      <select value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Icon name="chevronDown" size={14} />
    </div>
  );
}

/** Number input that commits on blur / Enter so typing doesn't spam the main process. */
export function NumberInput({
  value,
  onCommit,
  min = 0,
  max = 1e9,
  suffix,
  width = 90,
}: {
  value: number;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  suffix?: string;
  width?: number;
}) {
  const [v, setV] = useState(String(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setV(String(value));
  }, [value]);
  const commit = () => {
    const n = Math.max(min, Math.min(max, Number(v) || 0));
    setV(String(n));
    if (n !== value) onCommit(n);
  };
  return (
    <label className="num" style={{ width }}>
      <input
        inputMode="numeric"
        value={v}
        onFocus={() => (focused.current = true)}
        onChange={(e) => setV(e.target.value.replace(/[^\d.]/g, ""))}
        onBlur={() => {
          focused.current = false;
          commit();
        }}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
      {suffix && <span>{suffix}</span>}
    </label>
  );
}

export function TextInput({
  value,
  onCommit,
  placeholder,
  mono,
}: {
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  const [v, setV] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setV(value);
  }, [value]);
  return (
    <input
      className={`text ${mono ? "mono" : ""}`}
      value={v}
      placeholder={placeholder}
      onFocus={() => (focused.current = true)}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        focused.current = false;
        if (v !== value) onCommit(v);
      }}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

export function Row({ title, help, children }: { title: string; help?: ReactNode; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-text">
        <div className="setting-title">{title}</div>
        {help && <div className="setting-help">{help}</div>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

export function Section({ title, icon, children, aside }: { title: string; icon?: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="card section">
      <header>
        {icon && (
          <span className="section-icon">
            <Icon name={icon} size={16} />
          </span>
        )}
        <h3>{title}</h3>
        <div className="grow" />
        {aside}
      </header>
      {children}
    </section>
  );
}

export function Slider({ value, onChange, min = 0, max = 100 }: { value: number; onChange: (v: number) => void; min?: number; max?: number }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const pct = ((v - min) / (max - min)) * 100;
  return (
    <input
      type="range"
      className="slider"
      min={min}
      max={max}
      value={v}
      style={{ ["--pct" as string]: `${pct}%` }}
      onChange={(e) => setV(Number(e.target.value))}
      onPointerUp={() => onChange(v)}
      onKeyUp={() => onChange(v)}
    />
  );
}
