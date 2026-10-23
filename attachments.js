// Multi-image import: pick, drag-paste or paste images, resize them, and keep previews.
import { $, toast } from "./utils.js";

const MAX_IMAGES = 8;
const MAX_SIDE = 1280; // px; keeps request payloads small

let pending = []; // { name, mime, data (base64, no prefix), preview (data URL) }

export function bindAttachments() {
  const fileInput = $("file-input");
  $("attach-btn").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    await addFiles(fileInput.files);
    fileInput.value = "";
  });
  $("input").addEventListener("paste", async (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
    if (files.length) {
      e.preventDefault();
      await addFiles(files);
    }
  });
}

export function getPending() {
  return pending;
}

export function clear() {
  pending = [];
  render();
}

export async function addFiles(list) {
  const images = [...list].filter((f) => f.type.startsWith("image/"));
  const room = MAX_IMAGES - pending.length;
  if (room <= 0) return toast(`You can attach up to ${MAX_IMAGES} images per message.`);
  for (const file of images.slice(0, room)) {
    try {
      pending.push(await readImage(file));
    } catch (err) {
      toast(err.message);
    }
  }
  render();
}

function readImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
      URL.revokeObjectURL(url);
      resolve({ name: file.name, mime: "image/jpeg", data: dataUrl.split(",")[1], preview: dataUrl });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Could not read ${file.name}`));
    };
    img.src = url;
  });
}

function removeAt(index) {
  pending.splice(index, 1);
  render();
}

function render() {
  const wrap = $("attachments");
  wrap.innerHTML = "";
  pending.forEach((p, i) => {
    const box = document.createElement("div");
    box.className = "att";
    const img = document.createElement("img");
    img.src = p.preview;
    img.alt = p.name;
    const x = document.createElement("button");
    x.type = "button";
    x.textContent = "×";
    x.title = "Remove image";
    x.addEventListener("click", () => removeAt(i));
    box.append(img, x);
    wrap.append(box);
  });
  wrap.classList.toggle("hidden", pending.length === 0);
}
