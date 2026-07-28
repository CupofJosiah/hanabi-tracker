/** Getting JSON off the phone: download, clipboard, or the OS share sheet. */

export function download(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Give the click a tick to start before the blob goes away.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Safari refuses clipboard writes outside a user gesture; fall back to a
    // hidden textarea, which still works there.
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.append(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function canShareFiles(): boolean {
  return typeof navigator.share === "function" && typeof navigator.canShare === "function";
}

/** Offers the OS share sheet, so the JSON can go straight to Discord or a note. */
export async function shareFile(filename: string, text: string): Promise<boolean> {
  if (!canShareFiles()) return false;
  const file = new File([text], filename, { type: "application/json" });
  if (!navigator.canShare({ files: [file] })) return false;
  try {
    await navigator.share({ files: [file], title: filename });
    return true;
  } catch {
    return false;
  }
}
