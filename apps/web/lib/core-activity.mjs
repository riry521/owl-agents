// Core の処理の表示用の整形。純 JS。

/** 開始からの経過を { unit, count } にする（60秒未満は秒、1時間未満は分、それ以上は時間）。 */
export function elapsedParts(iso, now) {
  const start = typeof iso === "string" ? Date.parse(iso) : NaN;
  if (!Number.isFinite(start)) return null;
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  if (seconds < 60) return { unit: "seconds", count: seconds };
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? { unit: "minutes", count: minutes } : { unit: "hours", count: Math.floor(minutes / 60) };
}

/** argv を空白でつなぐ。無ければ null。 */
export function commandText(command) {
  return Array.isArray(command) && command.length > 0 ? command.join(" ") : null;
}
