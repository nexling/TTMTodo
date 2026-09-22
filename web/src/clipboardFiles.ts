function namedUploadFile(file: File): File {
  if (file.name.trim()) return file;
  const subtype = (file.type.split("/")[1] || "bin").split("+")[0];
  const ext = subtype === "jpeg" ? "jpg" : subtype;
  return new File([file], `clipboard.${ext}`, { type: file.type || "application/octet-stream" });
}

export function filesFromDataTransfer(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  for (const file of Array.from(dt.files)) {
    out.push(namedUploadFile(file));
  }
  if (out.length) return out;
  for (const item of dt.items) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) out.push(namedUploadFile(file));
  }
  return out;
}
