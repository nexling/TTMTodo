import { useEffect, useRef, useState } from "react";

export const COLOR_PALETTE = ["#e8a54b", "#d4654f", "#7c9a6d", "#6a8caf", "#b57bb0", "#c4842e"];

export function toHex6(value: string, fallback = COLOR_PALETTE[0]): string {
  const text = (value || "").trim();
  if (/^#[0-9a-fA-F]{6}$/.test(text)) return text.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(text)) {
    const r = text[1];
    const g = text[2];
    const b = text[3];
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return fallback;
}

type Props = {
  value: string;
  onChange: (color: string, source?: "swatch" | "wheel") => void;
};

export default function ColorPicker({ value, onChange }: Props) {
  const hex = toHex6(value);
  const [draft, setDraft] = useState(hex);
  const hexRef = useRef(hex);
  const onChangeRef = useRef(onChange);
  const inputRef = useRef<HTMLInputElement>(null);
  hexRef.current = hex;
  onChangeRef.current = onChange;

  useEffect(() => {
    setDraft(hex);
  }, [hex]);

  function commitWheel(next: string) {
    const color = toHex6(next, hexRef.current);
    setDraft(color);
    if (color !== hexRef.current) onChangeRef.current(color, "wheel");
  }

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const onNativeChange = () => commitWheel(el.value);
    el.addEventListener("change", onNativeChange);
    return () => el.removeEventListener("change", onNativeChange);
  }, []);

  const custom = !COLOR_PALETTE.includes(draft);
  return (
    <div className="colors">
      {COLOR_PALETTE.map((c) => (
        <button
          key={c}
          type="button"
          className={`swatch${hex === c ? " on" : ""}`}
          style={{ background: c }}
          onClick={() => onChange(c, "swatch")}
          aria-label={c}
        />
      ))}
      <label className={`swatch color-wheel${custom ? " on" : ""}`} style={{ background: draft }} title="Custom color">
        <input
          ref={inputRef}
          type="color"
          value={draft}
          onInput={(e) => setDraft(toHex6(e.currentTarget.value, hex))}
          onBlur={(e) => commitWheel(e.currentTarget.value)}
          aria-label="Custom color"
        />
      </label>
    </div>
  );
}
