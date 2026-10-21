// The app's logo, bundled by Vite (assets/logo.png is the full-size source).
import logoUrl from "./assets/logo.png";

export function brandMark(size: number): HTMLImageElement {
  const img = new Image(size, size);
  img.src = logoUrl;
  img.alt = "";
  img.className = "brand-mark";
  img.draggable = false;
  return img;
}
