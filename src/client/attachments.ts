export const ATTACH_JS = `/* ---------- image attachments (paste / attach, stored in R2) ---------- */
const attachBtn = document.getElementById("attach");
const filePick = document.getElementById("filepick");
const pendingBox = document.getElementById("pending");
const box = document.getElementById("box");
let pendingImages = [];
let uploading = 0;
function renderPending() {
  if (!pendingBox) return;
  pendingBox.innerHTML = "";
  pendingBox.hidden = !pendingImages.length;
  for (const p of pendingImages) {
    const t = el("div", "thumb" + (p.uploading ? " uploading" : ""));
    if (p.preview) {
      const img = document.createElement("img");
      img.src = p.preview;
      img.alt = "attached image";
      t.appendChild(img);
    } else {
      t.appendChild(el("div", "thumbwait", "…"));
    }
    const x = el("button", null, "×");
    x.title = "Remove attachment";
    x.setAttribute("aria-label", "Remove attachment");
    x.onclick = () => {
      pendingImages = pendingImages.filter((q) => q !== p);
      // The bytes were already persisted on attach: delete the R2 object so
      // removed attachments do not linger as orphans. Best-effort — a
      // failure keeps the (harmless, unreferenced) bytes, never the UI.
      if (p.id) {
        apiFetch("/api/images/" + encodeURIComponent(p.id), { method: "DELETE" }).catch(() => {});
      }
      renderPending();
      syncSend();
    };
    t.appendChild(x);
    pendingBox.appendChild(t);
  }
}
function syncSend() {
  sendBtn.disabled = busy || uploading > 0 || booting;
}
/** Read a File as a data URL (for upload + instant thumbnail). */
function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(new Error("could not read " + (file.name || "image")));
    r.readAsDataURL(file);
  });
}
/** Upload data URLs: at most 4 total, images only, 5 MiB each (server enforces). */
async function attachFiles(files) {
  const list = [...(files || [])].filter((f) => f && /^image\\//.test(f.type || ""));
  if (!list.length) return;
  const valid = [];
  for (const file of list) {
    if (file.size > 5 * 1024 * 1024) {
      addError("image too large (max 5 MiB): " + (file.name || "pasted image"));
      continue;
    }
    valid.push(file);
  }
  if (!valid.length) return;
  // Reserve slots synchronously: concurrent paste/drop/pick events must not
  // all pass the cap check before any of them records its entries.
  const slots = 4 - pendingImages.length;
  if (slots <= 0) {
    addError("at most 4 images per message");
    return;
  }
  const take = valid.slice(0, slots);
  if (valid.length > slots) addError("at most 4 images per message (extras ignored)");
  uploading += take.length;
  syncSend();
  const entries = take.map((file) => {
    const entry = { preview: "", uploading: true, id: null, mimeType: file.type || "image/png", file };
    pendingImages.push(entry);
    return entry;
  });
  renderPending();
  await Promise.all(
    entries.map(async (entry) => {
      try {
        const preview = await readAsDataUrl(entry.file);
        entry.preview = preview;
        renderPending();
        const r = await apiFetch("/api/images", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ data: preview, mimeType: entry.mimeType }),
        }).then((r) => r.json());
        if (r.error) throw new Error(r.error);
        entry.id = r.id;
        entry.mimeType = r.mimeType || entry.mimeType;
        entry.uploading = false;
      } catch (e) {
        pendingImages = pendingImages.filter((q) => q !== entry);
        addError("upload failed: " + (e.message ?? e));
      } finally {
        uploading--;
      }
    }),
  );
  renderPending();
  syncSend();
}
if (attachBtn && filePick) {
  attachBtn.onclick = () => filePick.click();
  filePick.onchange = () => {
    attachFiles(filePick.files).catch((e) => addError(e.message ?? String(e)));
    filePick.value = "";
  };
}
if (box) {
  box.addEventListener("dragover", (e) => {
    if ([...(e.dataTransfer?.types || [])].includes("Files")) e.preventDefault();
  });
  box.addEventListener("drop", (e) => {
    // Claim the drop before filtering: a non-image file must not trigger the
    // browser default (which navigates away from the app).
    if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
    e.preventDefault();
    const files = [...(e.dataTransfer?.files || [])].filter((f) => /^image\\//.test(f.type || ""));
    if (files.length) {
      attachFiles(files).catch((err) => addError(err.message ?? String(err)));
    }
  });
}
input.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files || [])].filter((f) => /^image\\//.test(f.type || ""));
  const items = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith("image/"));
  if (files.length || items.length) {
    const picked = files.length ? files : items.map((i) => i.getAsFile()).filter(Boolean);
    if (picked.length) {
      e.preventDefault();
      attachFiles(picked).catch((err) => addError(err.message ?? String(err)));
    }
  }
});

`;
